// memory.js — long-term memory with rolling consolidation (fablemars pattern).
// Journal entries beyond a threshold get merged into a 500-word summary by the brain model.
import fs from "node:fs";
import path from "node:path";
import { dataDir, state, pushEvent } from "./state.js";
import { hasDb, dbGetKv, dbSetKv } from "./db.js";

const MEM_FILE = path.join(dataDir, "memory.json");

export const memory = { summary: "", consolidatedThrough: 0 };

export async function loadMemory() {
  if (hasDb) {
    try { const m = await dbGetKv("memory"); if (m) Object.assign(memory, m); return; } catch {}
  }
  try { Object.assign(memory, JSON.parse(fs.readFileSync(MEM_FILE, "utf8"))); } catch {}
}
function saveMemory() {
  if (hasDb) dbSetKv("memory", { summary: memory.summary, consolidatedThrough: memory.consolidatedThrough }).catch(() => {});
  try { fs.writeFileSync(MEM_FILE, JSON.stringify(memory, null, 2)); } catch {}
}

let consolidating = false;

// anthropic: an Anthropic client (or null → skip). model: cheap model for compaction.
export async function maybeConsolidate(anthropic, model) {
  if (consolidating || !anthropic) return;
  const unconsolidated = state.events.filter(e => e.id > memory.consolidatedThrough);
  if (unconsolidated.length < 120) return;
  consolidating = true;
  try {
    const batch = unconsolidated.slice(0, 200);
    const lines = batch.map(e => `[${e.type}] ${e.text}`).join("\n");
    const msg = await anthropic.messages.create({
      model, max_tokens: 700,
      system: "You maintain the long-term memory of fablebot, an autonomous streamer agent. Merge the OLD ARCHIVE with the NEW EVENTS into at most 500 words. Keep: launched coins and their CAs, promises made to the community, follower names and running jokes, market moments, tools it built, mistakes and lessons. Drop routine ticks and noise. Write in first person as fablebot's own memory.",
      messages: [{ role: "user", content: `OLD ARCHIVE:\n${memory.summary || "(empty)"}\n\nNEW EVENTS:\n${lines}\n\nWrite the merged archive now.` }],
    });
    memory.summary = msg.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    memory.consolidatedThrough = batch[batch.length - 1].id;
    saveMemory();
    pushEvent("info", `memory consolidated through event ${memory.consolidatedThrough}`);
  } catch (e) {
    pushEvent("error", `memory consolidation failed: ${e.message}`);
  } finally {
    consolidating = false;
  }
}
