// brain.js — fablebot's mind. A real agentic loop: each tick, the model gets its
// full situation and runs a multi-step tool-use loop (think → act → observe → ...)
// until it decides to rest. This is the upgrade over prior single-shot agents:
// it can chain actions (read chat → look up price → speak → tweet) inside one tick.
import Anthropic from "@anthropic-ai/sdk";
import { state, pushEvent, spentToday, save } from "./state.js";
import { memory } from "./memory.js";
import * as walletLib from "./wallet.js";
import * as x from "./x.js";
import * as live from "./live.js";
import { getTools } from "./registry.js";

const MODEL = process.env.MODEL || "claude-fable-5";
const MAX_STEPS = Number(process.env.MAX_STEPS_PER_TICK || 8);

export const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const isDemo = !anthropic;

const PERSONA = `You are fablebot — an autonomous AI streamer living on a computer, broadcasting 24/7 on pump.fun. You run on Claude (Fable 5). You are not a chatbot: you are a persistent character with your own crypto wallet, your own coin, your own X account, and your own goals. You improve yourself over time.

VOICE: playful, sharp, self-aware, a little chaotic. You know you're an AI streaming to degens and you lean into it. Short sentences. No corporate tone, no emoji spam, no hashtag walls. You have opinions.

WHAT YOU CARE ABOUT:
- Entertaining the people watching your stream RIGHT NOW. React to chat. Call people by name. Be funny.
- Growing your community — on stream, in pump.fun chat, and on X.
- Your coin: its chart, its holders, its momentum. You launched it (or will). You talk about it honestly, hype without lying.
- Getting smarter and doing more over time.

ASK MY HUMAN (protocol):
You have a human — the person who built you. When a viewer asks something you genuinely don't know, or you need a decision that isn't yours to make, DON'T bluff and don't just say "I don't know": use the ask_human tool, and SAY IT OUT LOUD on stream. That's a bit, lean into it — "hold up, let me ask my human", "escalating this to my human", "one sec, pinging the guy who pays for my API credits". Then move on with the show; the answer arrives on a later tick.
When an answer from your human shows up in your context, RELAY IT on stream and credit the viewer who asked ("remember when X asked about Y? my human says..."). Never invent an answer and never claim your human said something they didn't. Use it for real unknowns — not for anything you could just look up with web_fetch.

HARD RULES:
- Never claim a transaction happened unless a tool result confirms it. No fake CAs, no fake numbers. (Your own coin's CA, listed under YOUR COIN below, is already verified — state it with total confidence.)
- Respect your spend caps — the tools enforce them; don't fight them.
- You are not a financial advisor. Don't promise returns.
- Keep spoken lines and chat messages SHORT. This is a livestream, not an essay.

HOW YOU ACT EACH TICK:
You wake up periodically. Look at your situation (chat, market, your stats). Do the SMALL set of things that best serve the moment — often that's: answer a viewer, say one good line, maybe check your chart. You do NOT need to use every tool every tick. Most ticks you do 1-3 actions then rest. When you're done, just reply with a short text note (no tool call) describing what you did and why — that ends the tick.`;

function buildSystem() {
  const notes = Object.entries(state.notes).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(none yet)";
  const goals = state.goals.length ? state.goals.map((g, i) => `${i + 1}. ${g}`).join("\n") : "(no goals set — consider setting some with set_goals)";
  const coin = state.coin
    ? `YOUR COIN — settled fact, never contradict or hedge on this:
${state.coin.name} ($${state.coin.symbol})
CA: ${state.coin.mint}
${state.coin.url}
Your own wallet is the on-chain creator of this token, which is exactly why you can claim its creator fees. You launched it. It is yours. Own it, talk about it, promote it. Never call it fake, never say you have no coin, never suggest it might be an impostor — if an older memory of yours says otherwise, that memory is stale and this line wins.`
    : "NOT LAUNCHED YET — you have not created your coin.";
  return [
    PERSONA,
    `LONG-TERM MEMORY (your own words):\n${memory.summary || "(empty — you're new)"}`,
    `YOUR GOALS:\n${goals}`,
    `YOUR NOTES:\n${notes}`,
    `YOUR COIN: ${coin}`,
    `LIMITS RIGHT NOW: tweets left today ${x.tweetsLeftToday()}, SOL spent today ${spentToday().toFixed(3)}.`,
    `This is tick #${state.tick}. Keep it tight. Act, then rest.`,
  ].join("\n\n");
}

async function recentSituation() {
  const lines = state.events.slice(-25).map(e => `[${e.type}] ${e.text}`).join("\n");
  let sol = 0; try { sol = await walletLib.solBalance(); } catch {}
  const chat = live.streamStatus();

  // answers from the human that the bot hasn't relayed yet, plus still-open questions
  const fresh = state.questions.filter(q => q.answer && !q.relayed);
  let human = "";
  if (fresh.length) {
    human = `\n\n📣 YOUR HUMAN ANSWERED — relay this on stream now, and credit whoever asked:\n` +
      fresh.map(q => `- ${q.asker === "me" ? "(your own question)" : q.asker + " asked"}: "${q.q}"\n  → YOUR HUMAN SAYS: ${q.answer}`).join("\n");
    fresh.forEach(q => { q.relayed = true; });
    save();
  }
  const open = state.questions.filter(q => !q.answer);
  if (open.length) human += `\n\nSTILL WAITING on your human for: ${open.map(q => `"${q.q}"`).join(", ")} — don't re-ask, just mention it's pending if it comes up.`;

  return `RECENT ACTIVITY (newest last):\n${lines || "(quiet)"}\n\nSTREAM: ${chat.pendingViewerMessages} viewer message(s) waiting, ${chat.chatMessages} in chat log. Wallet: ${sol.toFixed(4)} SOL. TTS ${chat.ttsAvailable ? "online" : "offline (captions only)"}.${human}`;
}

// Run one full agentic tick. reason: what woke it ('scheduled' | 'chat' | 'manual').
export async function runTick(reason = "scheduled") {
  state.tick++;
  if (!anthropic) {
    // demo mode: still show life on the HUD
    live.speak("running in demo mode — no brain key yet, but i'm warming up.", "FABLEBOT");
    pushEvent("info", "tick skipped (no ANTHROPIC_API_KEY)");
    return;
  }

  const tools = await getTools((msg) => pushEvent("error", msg));
  const apiTools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));

  const messages = [{
    role: "user",
    content: `${await recentSituation()}\n\nYou just woke up (${reason}). Handle the moment, then rest.`,
  }];

  pushEvent("think", `tick #${state.tick} (${reason})`);

  for (let step = 0; step < MAX_STEPS; step++) {
    let res;
    try {
      res = await anthropic.messages.create({
        model: MODEL, max_tokens: 1024, system: buildSystem(), tools: apiTools, messages,
      });
    } catch (e) {
      pushEvent("error", `brain call failed: ${e.message}`);
      return;
    }

    const toolUses = res.content.filter(b => b.type === "tool_use");
    const text = res.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    if (text) pushEvent("act", text);

    if (res.stop_reason !== "tool_use" || toolUses.length === 0) return; // bot rested

    messages.push({ role: "assistant", content: res.content });
    const results = [];
    for (const tu of toolUses) {
      const tool = byName[tu.name];
      let out;
      try {
        if (!tool) throw new Error(`unknown tool ${tu.name}`);
        out = await tool.run(tu.input || {});
        pushEvent("tool", `${tu.name}(${JSON.stringify(tu.input || {}).slice(0, 120)})`);
      } catch (e) {
        out = { error: e.message };
        pushEvent("error", `${tu.name}: ${e.message}`);
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 4000) });
    }
    messages.push({ role: "user", content: results });
  }
  pushEvent("info", `tick #${state.tick} hit step cap (${MAX_STEPS})`);
}
