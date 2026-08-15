// coin-chart.js — the jumbotron chart behind fablebot (ported from fablecat's
// "the number" screen, restyled to the clay/cream palette).
// Real mode: DexScreener price poll + GeckoTerminal 5m OHLCV candles.
// Demo mode (no coin yet): a live random-walk simulation so the stream looks alive.
//   mountCoinChart(canvas, { getCoin: async () => ({mint, symbol}) | null })

const THEME = {
  header: "#8a7a6d",
  price: "#20140d",
  grid: "#e5ddd0",
  label: "#b3a897",
  up: "#2e9e6b",
  down: "#d9503f",
  dim: "#b3a897",
};

const fmtUsd = v => v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "b" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "m" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + (+v).toFixed(2);
const fmtPrice = v => "$" + (+v).toPrecision(3);

export function mountCoinChart(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  const getCoin = opts.getCoin || (async () => null);

  let coin = null;          // { mint, symbol }
  let px = null;            // { usd, m5, h24, mcap }
  let candles = null;       // [{t,o,h,l,c}]
  let pairAddr = null;
  const sessionPrices = [];

  // ---- demo random walk (pre-launch) ----
  let demoCandles = [];
  let demoPrice = 0.000042;
  function demoStep() {
    const o = demoPrice;
    let c = o;
    let h = o, l = o;
    for (let i = 0; i < 6; i++) {
      c *= 1 + (Math.random() - 0.485) * 0.02;
      h = Math.max(h, c); l = Math.min(l, c);
    }
    demoPrice = c;
    demoCandles.push({ o, h, l, c });
    if (demoCandles.length > 48) demoCandles.shift();
  }
  for (let i = 0; i < 48; i++) demoStep();

  // ---- real data ----
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
      px = {
        usd: +p.priceUsd, m5: +(p.priceChange?.m5 ?? 0), h24: +(p.priceChange?.h24 ?? 0),
        mcap: p.marketCap || p.fdv || 0,
      };
      pairAddr = p.pairAddress;
      sessionPrices.push(px.usd);
      if (sessionPrices.length > 120) sessionPrices.shift();
      if (first) pollOhlcv();
    } catch {}
  }
  async function pollOhlcv() {
    if (!pairAddr) return;
    try {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddr}/ohlcv/minute?aggregate=5&limit=48`);
      if (!r.ok) throw 0;
      const j = await r.json();
      const list = j?.data?.attributes?.ohlcv_list;
      if (Array.isArray(list) && list.length) {
        candles = list.map(c => ({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] })).sort((a, b) => a.t - b.t);
      }
    } catch {}
  }

  // ---- draw ----
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const live = !!(coin?.mint && px);
    const sym = live ? (coin.symbol || "FABLEBOT") : "FABLEBOT";
    const ks = live ? (candles && candles.length > 1 ? candles : null) : demoCandles;

    // header
    ctx.font = "600 34px 'SF Mono', Menlo, monospace";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = THEME.header;
    ctx.fillText("$" + sym + (live ? "" : " · simulation"), 26, 40);
    const lastPx = live ? px.usd : demoPrice;
    const lastChg = live ? px.m5 : (demoCandles.at(-1).c >= demoCandles.at(-1).o ? 1 : -1);
    ctx.textAlign = "right";
    ctx.fillStyle = lastChg >= 0 ? THEME.up : THEME.down;
    ctx.fillText(fmtPrice(lastPx), W - 26, 40);

    const top = 84, bot = H - 64, left = 22, right = W - 92;
    let pts = null, lo = 0, hi = 0;
    if (ks) { lo = Math.min(...ks.map(k => k.l)); hi = Math.max(...ks.map(k => k.h)); }
    else if (sessionPrices.length > 1) { pts = sessionPrices; lo = Math.min(...pts); hi = Math.max(...pts); }
    if (hi <= lo) hi = lo * 1.001 + 1e-12;
    const Y = v => bot - (v - lo) / (hi - lo) * (bot - top);

    // grid + axis labels
    ctx.lineWidth = 1.5; ctx.strokeStyle = THEME.grid;
    for (let i = 0; i <= 4; i++) {
      const y = top + (bot - top) * i / 4;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      if (ks || pts) {
        ctx.font = "500 16px 'SF Mono', Menlo, monospace";
        ctx.fillStyle = THEME.label; ctx.textAlign = "right";
        ctx.fillText((hi - (hi - lo) * i / 4).toPrecision(3), W - 8, y);
      }
    }

    if (ks) {
      const n = ks.length, cw = (right - left) / n;
      ks.forEach((k, i) => {
        const x = left + cw * i + cw / 2;
        const up = k.c >= k.o;
        ctx.strokeStyle = ctx.fillStyle = up ? THEME.up : THEME.down;
        ctx.lineWidth = Math.max(1.5, cw * 0.1);
        ctx.beginPath(); ctx.moveTo(x, Y(k.h)); ctx.lineTo(x, Y(k.l)); ctx.stroke();
        const yo = Y(k.o), yc = Y(k.c);
        ctx.fillRect(x - cw * 0.3, Math.min(yo, yc), cw * 0.6, Math.max(2.5, Math.abs(yc - yo)));
      });
    } else if (pts) {
      ctx.strokeStyle = THEME.up; ctx.lineWidth = 4; ctx.lineJoin = "round"; ctx.beginPath();
      pts.forEach((v, i) => { const x = left + (right - left) * i / (pts.length - 1); i ? ctx.lineTo(x, Y(v)) : ctx.moveTo(x, Y(v)); });
      ctx.stroke();
    }

    // footer
    ctx.font = "500 20px 'SF Mono', Menlo, monospace"; ctx.textAlign = "left"; ctx.fillStyle = THEME.dim;
    ctx.fillText(
      live ? `5m ${px.m5 >= 0 ? "+" : ""}${px.m5.toFixed(1)}%   24h ${px.h24 >= 0 ? "+" : ""}${px.h24.toFixed(1)}%   mc ${fmtUsd(px.mcap)}`
           : "practice chart — real one appears at launch",
      26, H - 30);
    ctx.textAlign = "right";
    ctx.fillText("live · fablebot is watching", W - 26, H - 30);
  }

  // ---- loops ----
  pollMarket(); draw();
  const t1 = setInterval(pollMarket, 8000);
  const t2 = setInterval(pollOhlcv, 60000);
  const t3 = setInterval(() => { if (!(coin?.mint && px)) demoStep(); draw(); }, 5000);
  const t4 = setInterval(draw, 1000);

  return { stop: () => [t1, t2, t3, t4].forEach(clearInterval), draw };
}
