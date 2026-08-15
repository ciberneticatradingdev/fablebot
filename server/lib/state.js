// state.js — persistence + event bus
// Single JSON state file (debounced writes) + append-only journal + SSE fanout.
import fs from "node:fs";
import path from "node:path";

const DATA = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), "data");
fs.mkdirSync(DATA, { recursive: true });

const STATE_FILE = process.env.STATE_FILE || path.join(DATA, "state.json");
const JOURNAL_FILE = path.join(DATA, "journal.jsonl");

export const dataDir = DATA;

export const state = {
  nextEventId: 1,
  tick: 0,
  events: [],          // ring buffer, last 400 (scan/think/act/tool/error/info/chat/tweet)
  coin: null,          // { mint, name, symbol, sig, ts } once launched
  tweetsToday: [],     // timestamps for rate caps
  spendToday: [],      // { ts, sol, what }
  lastClaimAt: 0,
  lastTweetAt: 0,
  goals: [],           // bot-editable goal list
  notes: {},           // bot-editable key/value scratch memory
};

let saveTimer = null;
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
    catch (e) { console.error("state save failed:", e.message); }
  }, 500);
}

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    Object.assign(state, raw);
    state.nextEventId = Math.max(state.nextEventId, ...state.events.map(e => e.id + 1), 1);
  } catch { /* fresh start */ }
}

// ---- SSE ----
export const sseClients = new Set();

export function pushEvent(type, text, meta = {}) {
  const ev = { id: state.nextEventId++, ts: Date.now(), type, text, ...meta };
  state.events.push(ev);
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  save();
  try { fs.appendFileSync(JOURNAL_FILE, JSON.stringify(ev) + "\n"); } catch {}
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
  console.log(`[${type}] ${String(text).slice(0, 200)}`);
  return ev;
}

// ---- daily windows ----
const DAY = 24 * 60 * 60 * 1000;
export function pruneDaily() {
  const cut = Date.now() - DAY;
  state.tweetsToday = state.tweetsToday.filter(t => t > cut);
  state.spendToday = state.spendToday.filter(s => s.ts > cut);
}
export function spentToday() {
  pruneDaily();
  return state.spendToday.reduce((a, s) => a + s.sol, 0);
}
