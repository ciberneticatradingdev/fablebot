// index.js — fablebot server: agentic tick loop + HTTP/SSE + static HUD/site.
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { state, load, pushEvent, sseClients, spentToday, save } from "./lib/state.js";
import { loadMemory, memory, maybeConsolidate, resetMemorySummary } from "./lib/memory.js";
import { hasDb, dbLoadEventsByType } from "./lib/db.js";
import { runTick, anthropic, isDemo as brainDemo } from "./lib/brain.js";
import { launchCoin } from "./lib/pump.js";
import * as walletLib from "./lib/wallet.js";
import * as x from "./lib/x.js";
import * as live from "./lib/live.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await load();
await loadMemory();

// COIN_MINT is the source of truth for which coin is ours: it rehydrates the
// coin after an ephemeral restart AND switches it if we point at a new one.
if (process.env.COIN_MINT && state.coin?.mint !== process.env.COIN_MINT.trim()) {
  const mint = process.env.COIN_MINT.trim();
  const prev = state.coin?.mint;
  state.coin = {
    mint,
    symbol: process.env.LAUNCH_SYMBOL || "fablebot",
    name: process.env.LAUNCH_NAME || "fablebot",
    url: `https://pump.fun/coin/${mint}`, ts: Date.now(),
  };
  // Notes written before the real launch ("still not launched", "dry run",
  // "demo mode") would actively mislead the agent about its own coin.
  for (const [k, v] of Object.entries(state.notes)) {
    if (/dry.?run|not launched|demo mode|fake|never promote/i.test(`${k} ${v}`)) delete state.notes[k];
  }
  save();
  pushEvent("info", prev ? `coin switched ${prev} → ${mint}` : `coin set from COIN_MINT: ${mint}`);
}

// One-shot memory cleanup: bump MEMORY_RESET to any new value to wipe the
// consolidated archive and drop notes that contradict a now-settled fact.
if (process.env.MEMORY_RESET && state.notes._memory_reset !== process.env.MEMORY_RESET) {
  const before = Object.keys(state.notes).length;
  for (const [k, v] of Object.entries(state.notes)) {
    if (/impostor|not launched|never launch|dry.?run|demo mode|fake|didn'?t launch/i.test(`${k} ${v}`)) delete state.notes[k];
  }
  state.notes._memory_reset = process.env.MEMORY_RESET;
  resetMemorySummary();
  save();
  pushEvent("info", `memory reset: archive cleared, ${before - Object.keys(state.notes).length + 1} stale notes dropped`);
}

// A standing note from the operator, injected into the agent's memory. Set via
// env (not an HTTP endpoint) so nobody can write into the agent's brain remotely.
for (const [envVar, noteKey] of [["OPERATOR_NOTE", "from_my_human"], ["TOOLS_NOTE", "my_new_tools"]]) {
  const raw = process.env[envVar];
  if (!raw) continue;
  const v = raw.slice(0, 1600);
  if (state.notes[noteKey] !== v) {
    state.notes[noteKey] = v;
    save();
    pushEvent("info", `note from my human updated (${noteKey})`);
  }
}

const PORT = Number(process.env.PORT || 8947);
const ENABLED = process.env.ENABLED !== "false";           // master run switch (agent acts)
const TICK_MS = Number(process.env.TICK_MINUTES || 3) * 60 * 1000;
const CONSOLIDATE_MODEL = process.env.CONSOLIDATE_MODEL || process.env.MODEL || "claude-fable-5";

let ticking = false;
async function tickOnce(reason = "scheduled") {
  if (!ENABLED) { pushEvent("info", "ENABLED=false — tick skipped (kill switch)"); return; }
  if (ticking) return;
  ticking = true;
  try { await runTick(reason); }
  catch (e) { pushEvent("error", `tick crashed: ${e.message}`); }
  finally { ticking = false; }
  startChatPoller(); // begins once the agent has launched its coin
  maybeConsolidate(anthropic, CONSOLIDATE_MODEL).catch(() => {});
}

// ---- HTTP ----
const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    brain: !anthropic ? "demo" : "live",
    wallet: walletLib.address,
    walletMode: walletLib.isDemo ? "demo" : "live",
    x: x.isDemo ? "demo" : "live",
    enabled: ENABLED,
    tick: state.tick,
    coin: state.coin,
  });
});

app.get("/api/state", async (_req, res) => {
  let sol = 0; try { sol = await walletLib.solBalance(); } catch {}
  res.json({
    tick: state.tick,
    events: state.events.slice(-120),
    coin: state.coin,
    goals: state.goals,
    notes: state.notes,
    memory: memory.summary,
    wallet: walletLib.address,
    sol,
    solSpentToday: spentToday(),
    stream: live.streamStatus(),
    tweets: {
      leftToday: x.tweetsLeftToday(),
      usedToday: state.tweetsToday.length,
      // rolling 24h window: the budget frees up as old posts age out
      nextFreesAt: state.tweetsToday.length ? Math.min(...state.tweetsToday) + 86400000 : null,
    },
    enabled: ENABLED,
  });
});

app.get("/api/feed", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", ts: Date.now() })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// The website is read-only. pump.fun's livestream chat is the ONLY way the
// public reaches the agent — anything typed here used to land straight in its
// inbox and steer it, so the endpoint is closed rather than just hidden in the UI.
app.post("/api/say", (_req, res) => {
  res.status(403).json({ error: "the website is read-only — talk to fablebot in its pump.fun livestream chat" });
});

// Only the operator may answer the agent's ask_human questions: an answer is
// injected into the agent's context as "YOUR HUMAN SAYS", so an open endpoint
// would let anyone impersonate the operator and steer the agent.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
function isOperator(req) {
  if (!ADMIN_TOKEN) return false;
  const given = req.get("x-admin-token") || req.query.key || req.body?.key || "";
  return given === ADMIN_TOKEN;
}

// live.fablebot.fun → the stream HUD at the root
app.get("/", (req, res, next) => {
  if ((req.hostname || "").startsWith("live.")) {
    return res.sendFile(path.join(__dirname, "..", "stream", "hud", "scene.html"));
  }
  next();
});
// ---- chat history ----
// Straight from the DB so the HUD's chat panel repopulates after any restart
// (the in-memory event ring is mostly think/act/tool, so chat scrolls out of it).
app.get("/api/chat", async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  res.setHeader("Access-Control-Allow-Origin", "*");
  let evs = hasDb ? await dbLoadEventsByType("chat", limit) : null;
  if (!evs) evs = state.events.filter(e => e.type === "chat").slice(-limit);
  res.json({ messages: evs.map(e => ({ ts: e.ts, text: e.text, source: e.source || null })) });
});

// ---- OHLCV proxy: real candles for the HUD chart ----
// Browsers can't call geckoterminal directly (no CORS) and it rate-limits hard,
// so the server fetches once and caches for everyone watching.
const ohlcvCache = { at: 0, pair: null, data: null, mint: null };
app.get("/api/ohlcv", async (req, res) => {
  const mint = String(req.query.mint || state.coin?.mint || "").trim();
  if (!mint) return res.json({ candles: [] });
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (ohlcvCache.mint === mint && Date.now() - ohlcvCache.at < 45000) {
    return res.json({ candles: ohlcvCache.data || [], cached: true, pair: ohlcvCache.pair });
  }
  try {
    if (ohlcvCache.mint !== mint || !ohlcvCache.pair) {
      const dr = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + mint, { signal: AbortSignal.timeout(8000) });
      const dj = await dr.json();
      const pairs = (dj.pairs || []).filter(p => p.chainId === "solana")
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      ohlcvCache.pair = pairs[0]?.pairAddress || null;
      ohlcvCache.mint = mint;
    }
    if (!ohlcvCache.pair) return res.json({ candles: [] });
    const agg = String(req.query.aggregate || "1");
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${ohlcvCache.pair}/ohlcv/minute?aggregate=${agg}&limit=200`, {
      headers: { Accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const j = await r.json();
      const list = j?.data?.attributes?.ohlcv_list;
      if (Array.isArray(list)) {
        ohlcvCache.data = list.map(c => ({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] || 0 })).sort((a, b) => a.t - b.t);
        ohlcvCache.at = Date.now();
      }
    }
    res.json({ candles: ohlcvCache.data || [], pair: ohlcvCache.pair, status: r.status });
  } catch (e) {
    res.json({ candles: ohlcvCache.data || [], error: e.message });
  }
});

// ---- ask-my-human channel ----
app.get("/api/questions", (_req, res) => {
  res.json({ questions: state.questions.slice(-20).reverse() });
});
app.post("/api/answer", (req, res) => {
  if (!isOperator(req)) return res.status(403).json({ error: "operator only" });
  const id = Number(req.body?.id);
  const answer = String(req.body?.answer || "").slice(0, 800).trim();
  if (!answer) return res.status(400).json({ error: "empty answer" });
  const q = state.questions.find(x => x.id === id) || state.questions.filter(x => !x.answer).slice(-1)[0];
  if (!q) return res.status(404).json({ error: "no open question" });
  q.answer = answer; q.answeredAt = Date.now(); q.relayed = false;
  save();
  pushEvent("ask", `✅ my human answered: ${answer}`, { questionId: q.id });
  tickOnce("human-answer"); // wake it so it relays on stream promptly
  res.json({ ok: true, id: q.id });
});

// TTS proxy — fetch Google Translate TTS server-side (works there; a browser gets
// blocked by referer checks) and stream one mp3 back same-origin. Plays in normal
// browsers AND OBS's embedded browser (which has no speechSynthesis).
function chunkTTS(text, max = 190) {
  const words = String(text).split(/\s+/); const out = []; let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) { if (cur) out.push(cur.trim()); cur = w; }
    else cur += " " + w;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [String(text).slice(0, max)];
}
app.get("/api/tts", async (req, res) => {
  const text = String(req.query.text || "").slice(0, 600).trim();
  if (!text) return res.status(400).end();
  try {
    const bufs = [];
    for (const c of chunkTTS(text)) {
      const r = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(c)}`, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://translate.google.com/" },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) bufs.push(Buffer.from(await r.arrayBuffer()));
    }
    if (!bufs.length) return res.status(502).end();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(Buffer.concat(bufs));
  } catch (e) { res.status(500).end(); }
});

app.use(express.static(path.join(__dirname, "..", "web")));
app.use("/stream", express.static(path.join(__dirname, "..", "stream")));

// pump.fun chat + comments poller — spawn once the coin's mint is known
// (from COIN_MINT or right after the agent launches its coin).
let pollerStarted = false;
function startChatPoller() {
  if (pollerStarted) return;
  const mint = process.env.COIN_MINT || state.coin?.mint;
  if (!mint) return;
  pollerStarted = true;
  try {
    const child = spawn(process.execPath, [path.join(__dirname, "chat-poller.mjs")], {
      env: { ...process.env, COIN_MINT: mint },
      stdio: "inherit",
    });
    child.on("exit", (c) => { pollerStarted = false; pushEvent("info", `chat poller exited (${c}) — restarting in 15s`); setTimeout(startChatPoller, 15000); });
    pushEvent("info", `chat poller started for ${mint}`);
  } catch (e) { pollerStarted = false; pushEvent("error", `chat poller spawn failed: ${e.message}`); }
}

app.listen(PORT, () => {
  pushEvent("info", `fablebot up on :${PORT} — brain ${brainDemo ? "DEMO" : "LIVE"}, wallet ${walletLib.isDemo ? "DEMO" : walletLib.address}, x ${x.isDemo ? "DEMO" : "LIVE"}, enabled=${ENABLED}`);
  // One-shot deterministic launch (owner test). Fires once on boot, then the
  // agent takes over the coin. Params come from LAUNCH_* env (applied in launchCoin).
  if (process.env.LAUNCH_NOW === "true" && !state.coin) {
    launchCoin({
      name: process.env.LAUNCH_NAME || "test",
      symbol: process.env.LAUNCH_SYMBOL || "TEST",
      description: process.env.LAUNCH_DESCRIPTION || "test",
      imagePath: path.join(__dirname, "..", "stream", "hud", "logo.png"),
    })
      .then((c) => { pushEvent("info", `LAUNCH_NOW complete: ${c.mint}`); startChatPoller(); })
      .catch((e) => pushEvent("error", `LAUNCH_NOW failed: ${e.message}`));
  }
  tickOnce("boot");
  setInterval(() => tickOnce("scheduled"), TICK_MS);
  startChatPoller();
});
