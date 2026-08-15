# fablebot

An autonomous 24/7 AI streamer running on **Claude Fable 5**. It has its own Solana wallet, launches its own coin on pump.fun, claims its creator fees, posts on its own X account, talks out loud on a pump.fun livestream, and answers viewers in real time.

## Architecture

```
server/                     the agent (Node, port 8947)
  index.js                  tick scheduler + HTTP/SSE + kill switches
  lib/brain.js              THE BRAIN — Fable 5 agentic tool-use loop per tick
  lib/registry.js           tool belt (12 builtins) + hot-loaded tools/*.mjs
  lib/state.js              journal + SSE event bus + daily caps
  lib/memory.js             rolling long-term memory consolidation
  lib/wallet.js             its own Solana burner wallet
  lib/pump.js               launch coin / buy / sell (pump-sdk, createV2 flow)
  lib/claim.js              creator-fee claim (raw ixs, both programs — ported from tungbank)
  lib/x.js                  X posting (official API) + reading (twitterapi.io)
  lib/live.js               bridge to the stream rig (inbox/outbox/captions/TTS)
  tools/                    drop vetted .mjs tool modules here → hot-loaded next tick
web/index.html              control dashboard (live feed via SSE, talk to the bot)
stream/                     the livestream rig (separate processes)
  chat/poller.mjs           pump.fun livechat client (socket.io reverse-engineered),
                            writes chat.json/inbox.json, sends outbox with PUMP_CHAT_TOKEN
  voice/                    edge-tts neural voice → live.wav → FIFO mixer
  hud/scene.html            the 1280x800 scene that goes on camera
  stream.sh                 ffmpeg → pump.fun RTMP (macOS avfoundation / Linux x11grab)
  run-rig.sh                starts poller + mixer
```

**How a tick works:** every `TICK_MINUTES` (or instantly when a viewer message arrives), the brain wakes with its persona + long-term memory + goals + recent journal + live status, then runs a real multi-step tool-use loop (up to `MAX_STEPS_PER_TICK`): read chat → check chart → speak → tweet → rest. Every thought/action lands in the journal (SSE → dashboard), and old journal batches get consolidated into a first-person memory summary.

## Run it

```bash
cd server && npm install && cp .env.example .env   # fill what you have
node index.js                                       # http://localhost:8947
```

Demo mode is fully functional with **zero keys** — brain, wallet, and X are faked so you can watch the machinery. Add keys incrementally:

| Piece | Env | Effect |
|---|---|---|
| Brain | `ANTHROPIC_API_KEY` | real Fable 5 ticks |
| Wallet | `WALLET_PRIVATE_KEY` (burner!) + `LIVE=true` | real on-chain txs (until then: dry-run sims) |
| X | `X_APP_KEY/SECRET` + `X_ACCESS_TOKEN/SECRET` | real tweets (`TWITTERAPI_KEY` for reads) |
| Stream chat | `COIN_MINT` (+ `PUMP_CHAT_TOKEN` to send) | live viewer inbox |

## Safety rails (enforced in code, not in the prompt)

- `ENABLED=false` — master kill switch (server up, bot inert)
- `LIVE=false` — every on-chain action only simulates
- `MAX_SOL_PER_ACTION` / `MAX_SOL_PER_DAY` — spend caps
- `MAX_TWEETS_PER_DAY` — post cap
- One coin per bot, ever (`launch_coin` refuses after `state.coin` is set)
- Dynamic tools are **not self-authored**: the bot gains tools when vetted modules are placed in `server/tools/` (hot-loaded, no restart)

## Going live on stream

```bash
stream/run-rig.sh                     # chat poller + voice mixer
# open stream/hud/scene.html fullscreen in Chrome on the capture display
RTMP_URL=... STREAM_KEY=... stream/stream.sh
```

Get `RTMP_URL`/`STREAM_KEY` from pump.fun's livestream setup for your coin. On macOS list capture devices with `ffmpeg -f avfoundation -list_devices true -i ""` and set `AV_SCREEN`. Voice needs `pip install edge-tts` (or a venv at `stream/voice/.venv`).

## Known gaps / next

- **Chat send** needs `PUMP_CHAT_TOKEN` (auth token from a logged-in pump.fun session); anonymous socket is read-only. The `sendMessage` emit is best-effort — verify against the current protocol when first used. Without it the bot still talks via voice + HUD captions.
- The pump.fun **IPFS upload / SDK APIs** drift; `pump.js` follows the grokthedev/pump14 flow (createV2, 13-char on-chain symbol vs 10-char IPFS).
- Deploy: Railway (server; mount a volume for `data/`) — the stream rig needs a desktop, so run it on a box with Chrome + ffmpeg (Linux: Xvfb + x11grab, like the old GROKBOT box).
