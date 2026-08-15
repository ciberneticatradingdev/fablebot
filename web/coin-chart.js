// coin-chart.js — the price chart behind fablebot (clay/cream themed).
// Real data: DexScreener price + GeckoTerminal 5m OHLCV candles for the coin.
// Renders a clean area + price line (looks like a normal chart with any number of
// points), with thin candlesticks overlaid once there's enough history. Before the
// coin exists it shows a subtle simulated line so the stream isn't empty.
//   mountCoinChart(canvas, { getCoin: async () => ({mint, symbol}) | null })

const THEME = {
  header: "#8a7a6d",
  grid: "#e7e0d3",
  label: "#b3a897",
  up: "#2e9e6b",
  down: "#d9503f",
  line: "#d9663f",
  fillTop: "rgba(217,102,63,0.22)",
  fillBot: "rgba(217,102,63,0.0)",
  dim: "#b3a897",
};

const fmtUsd = v => v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "b" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "m" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + (+v).toFixed(2);
const fmtPrice = v => v >= 1 ? "$" + (+v).toFixed(3) : "$" + (+v).toPrecision(3);

export function mountCoinChart(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  const getCoin = opts.getCoin || (async () => null);

  let coin = null;
  let px = null;                 // { usd, m5, h24, mcap }
  let candles = null;            // [{t,o,h,l,c}]
  let pairAddr = null;
  const sessionPrices = [];

  // pre-launch simulated line
  let demo = [];
  let demoP = 0.000031;
  function demoStep() {
    demoP *= 1 + (Math.random() - 0.48) * 0.04;
    demo.push(demoP);
    if (demo.length > 80) demo.shift();
  }
  for (let i = 0; i < 80; i++) demoStep();

  async function pollMarket() {
    try { coin = (await getCoin()) || coin; } catch {}
    if (!coin?.mint) return;
    try {
      const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + coin.mint);
      const j = await r.json();
      const pairs = (j.pairs || []).filter(p => p.chainId === "solana");
      if (!pairs.length) return;
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const p = pairs[0];
      const first = !px;
      px = { usd: +p.priceUsd, m5: +(p.priceChange?.m5 ?? 0), h24: +(p.priceChange?.h24 ?? 0), mcap: p.marketCap || p.fdv || 0 };
      pairAddr = p.pairAddress;
      sessionPrices.push(px.usd);
      if (sessionPrices.length > 200) sessionPrices.shift();
      if (first) pollOhlcv();
    } catch {}
  }
  async function pollOhlcv() {
    if (!pairAddr) return;
    try {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddr}/ohlcv/minute?aggregate=5&limit=96`);
      if (!r.ok) throw 0;
      const j = await r.json();
      const list = j?.data?.attributes?.ohlcv_list;
      if (Array.isArray(list) && list.length) {
        candles = list.map(c => ({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] })).sort((a, b) => a.t - b.t);
      }
    } catch {}
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const live = !!(coin?.mint && px);
    const sym = live ? (coin.symbol || "TEST") : "TEST";

    // build the price series (real closes, else session, else demo)
    let series, ohlc = null;
    if (live && candles && candles.length) { ohlc = candles; series = candles.map(k => k.c); }
    else if (live && sessionPrices.length) series = sessionPrices.slice();
    else series = demo.slice();
    // guarantee at least 2 points so a line renders
    if (series.length === 1) series = [series[0], series[0]];

    // header
    ctx.font = "600 34px 'SF Mono', Menlo, monospace";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = THEME.header;
    ctx.fillText("$" + sym + (live ? "" : " · simulation"), 26, 40);
    const last = live ? px.usd : demoP;
    const chg = live ? px.m5 : 0;
    ctx.textAlign = "right";
    ctx.fillStyle = chg >= 0 ? THEME.up : THEME.down;
    ctx.fillText(fmtPrice(last), W - 26, 40);

    const top = 84, bot = H - 64, left = 22, right = W - 96;
    let lo = Math.min(...series), hi = Math.max(...series);
    if (ohlc) { lo = Math.min(...ohlc.map(k => k.l)); hi = Math.max(...ohlc.map(k => k.h)); }
    if (hi <= lo) { const pad = (hi || 1) * 0.05 + 1e-12; lo -= pad; hi += pad; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const X = i => left + (right - left) * (series.length === 1 ? 0.5 : i / (series.length - 1));
    const Y = v => bot - (v - lo) / (hi - lo) * (bot - top);

    // gridlines + y labels
    ctx.lineWidth = 1.5; ctx.strokeStyle = THEME.grid;
    ctx.font = "500 16px 'SF Mono', Menlo, monospace"; ctx.fillStyle = THEME.label; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const y = top + (bot - top) * i / 4;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.fillText(fmtPrice(hi - (hi - lo) * i / 4), W - 8, y);
    }

    // area fill under the line
    const grad = ctx.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0, THEME.fillTop); grad.addColorStop(1, THEME.fillBot);
    ctx.beginPath();
    ctx.moveTo(X(0), Y(series[0]));
    for (let i = 1; i < series.length; i++) ctx.lineTo(X(i), Y(series[i]));
    ctx.lineTo(X(series.length - 1), bot); ctx.lineTo(X(0), bot); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // price line
    ctx.beginPath();
    ctx.moveTo(X(0), Y(series[0]));
    for (let i = 1; i < series.length; i++) ctx.lineTo(X(i), Y(series[i]));
    ctx.strokeStyle = live ? THEME.line : THEME.dim;
    ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();

    // thin candlesticks overlaid once there's real history
    if (ohlc && ohlc.length >= 6) {
      const n = ohlc.length, slot = (right - left) / n, cw = Math.min(12, slot * 0.6);
      ohlc.forEach((k, i) => {
        const x = left + slot * i + slot / 2;
        const up = k.c >= k.o;
        ctx.strokeStyle = ctx.fillStyle = up ? THEME.up : THEME.down;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, Y(k.h)); ctx.lineTo(x, Y(k.l)); ctx.stroke();
        const yo = Y(k.o), yc = Y(k.c);
        ctx.fillRect(x - cw / 2, Math.min(yo, yc), cw, Math.max(2, Math.abs(yc - yo)));
      });
    }

    // current-price dot
    ctx.beginPath();
    ctx.arc(X(series.length - 1), Y(series[series.length - 1]), 4, 0, 7);
    ctx.fillStyle = live ? THEME.line : THEME.dim; ctx.fill();

    // footer
    ctx.font = "500 20px 'SF Mono', Menlo, monospace"; ctx.textAlign = "left"; ctx.fillStyle = THEME.dim;
    ctx.fillText(
      live ? `5m ${px.m5 >= 0 ? "+" : ""}${px.m5.toFixed(1)}%   24h ${px.h24 >= 0 ? "+" : ""}${px.h24.toFixed(1)}%   mc ${fmtUsd(px.mcap)}`
           : "waiting for the coin…",
      26, H - 30);
    ctx.textAlign = "right";
    ctx.fillText(live ? "live · fablebot is watching" : "practice chart", W - 26, H - 30);
  }

  pollMarket(); draw();
  const t1 = setInterval(pollMarket, 8000);
  const t2 = setInterval(pollOhlcv, 30000);
  const t3 = setInterval(() => { if (!(coin?.mint && px)) demoStep(); draw(); }, 3000);

  return { stop: () => [t1, t2, t3].forEach(clearInterval), draw };
}
