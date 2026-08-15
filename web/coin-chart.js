// coin-chart.js — proper candlestick chart for fablebot's coin.
// Data: DexScreener (live price/mcap) + GeckoTerminal OHLCV (1m candles).
// A brand-new coin only has candles in the minutes it actually traded, so the
// series is bucketed on a fixed interval and gaps are forward-filled with flat
// candles (what every trading chart does) — that's what makes it read as a real
// chart instead of two lonely bars. Volume histogram along the bottom.
// Demo mode (pre-launch) generates a random walk in the same candle shape.

const THEME = {
  header: "#8a7a6d",
  grid: "#ece5d9",
  label: "#b3a897",
  up: "#2e9e6b",
  down: "#d9503f",
  upFill: "rgba(46,158,107,.85)",
  downFill: "rgba(217,80,63,.85)",
  dim: "#b3a897",
  cross: "#d9663f",
};

const fmtUsd = v => v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "b" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "m" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + (+v).toFixed(2);
const fmtPrice = v => "$" + (+v).toPrecision(3);

// Bucket raw OHLCV into a continuous series, forward-filling empty periods.
function densify(raw, stepSec, maxBars, nowSec) {
  if (!raw.length) return [];
  const byBucket = new Map();
  for (const k of raw) byBucket.set(Math.floor(k.t / stepSec) * stepSec, k);
  const end = Math.floor(nowSec / stepSec) * stepSec;
  const start = Math.max(Math.floor(raw[0].t / stepSec) * stepSec, end - (maxBars - 1) * stepSec);
  const out = [];
  let last = raw[0].o;
  for (let t = start; t <= end; t += stepSec) {
    const k = byBucket.get(t);
    if (k) { out.push({ ...k, t, filled: false }); last = k.c; }
    else out.push({ t, o: last, h: last, l: last, c: last, v: 0, filled: true });
  }
  return out.slice(-maxBars);
}

export function mountCoinChart(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  const getCoin = opts.getCoin || (async () => null);

  let coin = null, px = null, pairAddr = null;
  let raw = [];               // OHLCV backfill from geckoterminal (rate-limited, best-effort)
  let ownBuckets = new Map(); // candles we build ourselves from live DexScreener prices
  const STEP = 60;            // 1-minute candles
  const MAX_BARS = 64;

  // Our own candles are the reliable source: geckoterminal 429s easily and a
  // fresh pump.fun pool often has no OHLCV yet. Each price sample updates the
  // current minute's bucket. Persisted so an OBS/browser restart keeps history.
  const lsKey = () => `fb_candles_${coin?.mint || "none"}`;
  function loadOwn() {
    try {
      const j = JSON.parse(localStorage.getItem(lsKey()) || "[]");
      const cut = Math.floor(Date.now() / 1000) - MAX_BARS * STEP * 3;
      ownBuckets = new Map(j.filter(k => k.t > cut).map(k => [k.t, k]));
    } catch {}
  }
  function saveOwn() {
    try { localStorage.setItem(lsKey(), JSON.stringify([...ownBuckets.values()].slice(-MAX_BARS * 2))); } catch {}
  }
  function sample(price) {
    if (!(price > 0)) return;
    const t = Math.floor(Date.now() / 1000 / STEP) * STEP;
    const k = ownBuckets.get(t);
    if (!k) ownBuckets.set(t, { t, o: price, h: price, l: price, c: price, v: 0 });
    else { k.c = price; k.h = Math.max(k.h, price); k.l = Math.min(k.l, price); }
    if (ownBuckets.size > MAX_BARS * 3) ownBuckets.delete([...ownBuckets.keys()][0]);
    saveOwn();
  }
  // merge geckoterminal history with our own live buckets (ours wins on overlap)
  function merged() {
    const m = new Map();
    for (const k of raw) m.set(Math.floor(k.t / STEP) * STEP, k);
    for (const [t, k] of ownBuckets) m.set(t, { ...m.get(t), ...k, v: (m.get(t)?.v ?? 0) || k.v });
    return [...m.values()].sort((a, b) => a.t - b.t);
  }

  // ---- demo candles (pre-launch) ----
  let demo = [];
  let demoPrice = 0.0000042;
  function demoStep() {
    const o = demoPrice;
    let c = o, h = o, l = o;
    for (let i = 0; i < 5; i++) {
      c *= 1 + (Math.random() - 0.487) * 0.03;
      h = Math.max(h, c); l = Math.min(l, c);
    }
    demoPrice = c;
    demo.push({ t: Math.floor(Date.now() / 1000), o, h, l, c, v: 20 + Math.random() * 120, filled: false });
    if (demo.length > MAX_BARS) demo.shift();
  }
  for (let i = 0; i < MAX_BARS; i++) demoStep();

  async function pollMarket() {
    const had = coin?.mint;
    try { coin = (await getCoin()) || coin; } catch {}
    if (!coin?.mint) return;
    if (!had) loadOwn();
    try {
      const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + coin.mint);
      const j = await r.json();
      const pairs = (j.pairs || []).filter(p => p.chainId === "solana");
      if (!pairs.length) return;
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const p = pairs[0];
      px = {
        usd: +p.priceUsd, m5: +(p.priceChange?.m5 ?? 0), h24: +(p.priceChange?.h24 ?? 0),
        mcap: p.marketCap || p.fdv || 0,
      };
      if (!pairAddr) { pairAddr = p.pairAddress; pollOhlcv(); }
      pairAddr = p.pairAddress;
      sample(px.usd);
    } catch {}
  }
  async function pollOhlcv() {
    if (!pairAddr) return;
    try {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddr}/ohlcv/minute?aggregate=1&limit=200`);
      if (!r.ok) throw 0;
      const j = await r.json();
      const list = j?.data?.attributes?.ohlcv_list;
      if (Array.isArray(list) && list.length) {
        raw = list.map(c => ({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] || 0 })).sort((a, b) => a.t - b.t);
      }
    } catch {}
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const series = coin?.mint ? merged() : [];
    const live = series.length > 0;
    const sym = coin?.symbol || "FABLEBOT";
    const nowSec = Math.floor(Date.now() / 1000);
    let ks = live ? densify(series, STEP, MAX_BARS, nowSec) : demo;
    if (!ks.length) ks = demo;

    const lastK = ks[ks.length - 1];
    const lastPx = live && px ? px.usd : lastK.c;
    const chg = live && px ? px.m5 : (lastK.c >= ks[0].o ? 1 : -1);

    // header
    ctx.font = "600 32px 'SF Mono', Menlo, monospace";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = THEME.header;
    ctx.fillText("$" + sym + (live ? "  1m" : " · simulation"), 26, 38);
    ctx.textAlign = "right";
    ctx.fillStyle = chg >= 0 ? THEME.up : THEME.down;
    ctx.fillText(fmtPrice(lastPx), W - 26, 38);

    const top = 78, bot = H - 96, left = 22, right = W - 100;
    const volTop = H - 84, volBot = H - 52;

    let lo = Math.min(...ks.map(k => k.l));
    let hi = Math.max(...ks.map(k => k.h));
    if (!(hi > lo)) { hi = lo * 1.02 + 1e-12; lo = lo * 0.98; }
    const pad = (hi - lo) * 0.12; hi += pad; lo -= pad;
    const Y = v => bot - (v - lo) / (hi - lo) * (bot - top);
    const maxV = Math.max(1, ...ks.map(k => k.v || 0));

    // grid + price axis
    ctx.lineWidth = 1; ctx.strokeStyle = THEME.grid;
    ctx.font = "500 15px 'SF Mono', Menlo, monospace"; ctx.fillStyle = THEME.label;
    for (let i = 0; i <= 4; i++) {
      const y = top + (bot - top) * i / 4;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.textAlign = "left";
      ctx.fillText((hi - (hi - lo) * i / 4).toPrecision(3), right + 8, y);
    }

    // candles
    const n = ks.length;
    const slot = (right - left) / n;
    const bw = Math.max(3, Math.min(18, slot * 0.68));
    ks.forEach((k, i) => {
      const x = left + slot * i + slot / 2;
      const up = k.c >= k.o;
      const col = up ? THEME.up : THEME.down;
      // volume bar
      if (k.v > 0) {
        ctx.fillStyle = up ? "rgba(46,158,107,.18)" : "rgba(217,80,63,.18)";
        const vh = (k.v / maxV) * (volBot - volTop);
        ctx.fillRect(x - bw / 2, volBot - vh, bw, vh);
      }
      // wick
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, bw * 0.14);
      ctx.beginPath(); ctx.moveTo(x, Y(k.h)); ctx.lineTo(x, Y(k.l)); ctx.stroke();
      // body (flat/filled periods render as a thin doji line)
      const yo = Y(k.o), yc = Y(k.c);
      const bodyH = Math.max(k.filled ? 1.5 : 2.5, Math.abs(yc - yo));
      ctx.fillStyle = up ? THEME.upFill : THEME.downFill;
      if (k.filled) ctx.globalAlpha = 0.42;
      ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, bodyH);
      ctx.globalAlpha = 1;
    });

    // last-price marker line
    const ly = Y(lastPx);
    ctx.setLineDash([5, 5]); ctx.strokeStyle = THEME.cross; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(left, ly); ctx.lineTo(right, ly); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = THEME.cross;
    ctx.fillRect(right + 4, ly - 12, 92, 24);
    ctx.fillStyle = "#fff"; ctx.font = "600 14px 'SF Mono', Menlo, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(fmtPrice(lastPx).slice(0, 11), right + 50, ly);

    // footer
    ctx.font = "500 19px 'SF Mono', Menlo, monospace"; ctx.textAlign = "left"; ctx.fillStyle = THEME.dim;
    ctx.fillText(
      live && px ? `5m ${px.m5 >= 0 ? "+" : ""}${px.m5.toFixed(1)}%   24h ${px.h24 >= 0 ? "+" : ""}${px.h24.toFixed(1)}%   mc ${fmtUsd(px.mcap)}`
                 : "practice chart — real candles at launch",
      26, H - 22);
    ctx.textAlign = "right";
    ctx.fillText(live ? "live · geckoterminal" : "live · fablebot is watching", W - 26, H - 22);
  }

  pollMarket(); draw();
  const timers = [
    setInterval(pollMarket, 8000),
    setInterval(pollOhlcv, 120000),   // backfill only; rate-limited upstream
    setInterval(() => { if (!(coin?.mint)) demoStep(); draw(); }, 4000),
    setInterval(draw, 1000),
  ];
  return { stop: () => timers.forEach(clearInterval), draw };
}
