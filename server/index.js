// index.js — fablebot server: agentic tick loop + HTTP/SSE + static HUD/site.
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { state, load, pushEvent, sseClients, spentToday } from "./lib/state.js";
import { loadMemory, memory, maybeConsolidate } from "./lib/memory.js";
import { runTick, anthropic, isDemo as brainDemo } from "./lib/brain.js";
import { launchCoin } from "./lib/pump.js";
import * as walletLib from "./lib/wallet.js";
import * as x from "./lib/x.js";
import * as live from "./lib/live.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

load();
loadMemory();

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

// Let viewers on the site talk to the bot (also feeds the inbox the bot drains).
const chatWindow = new Map();
app.post("/api/say", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?";
  const now = Date.now();
  const hits = (chatWindow.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= 8) return res.status(429).json({ error: "slow down" });
  hits.push(now); chatWindow.set(ip, hits);

  const name = String(req.body?.name || "web").replace(/[^\w·\- ]/g, "").slice(0, 24) || "web";
  const text = String(req.body?.text || "").slice(0, 280);
  if (!text) return res.status(400).json({ error: "empty" });

  const inbox = live.readInbox();
  inbox.pending = [...(inbox.pending || []), { user: name, body: text, t: now, id: `web-${now}` }].slice(-40);
  live.writeInbox(inbox);
  pushEvent("chat", `${name}: ${text}`, { source: "web" });
  // nudge a chat-driven tick (debounced by `ticking`)
  tickOnce("chat");
  res.json({ ok: true });
});

// live.fablebot.fun → the stream HUD at the root
app.get("/", (req, res, next) => {
  if ((req.hostname || "").startsWith("live.")) {
    return res.sendFile(path.join(__dirname, "..", "stream", "hud", "scene.html"));
  }
  next();
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
