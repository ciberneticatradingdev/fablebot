// api-config.js — where the frontend finds the backend.
// The backend (Railway) serves the API AND this frontend, so same-origin works
// there and locally. When the landing is served from Vercel (a different origin),
// point it at the Railway backend by setting BACKEND below after the first deploy.
//
//   BACKEND = "https://fablebot-production.up.railway.app"
//
// Leave it "" to always use same-origin (fine if you only deploy on Railway).
const BACKEND = "";

// same-origin on localhost or when no backend override is set; otherwise the
// override only kicks in when we're NOT already on that backend host.
export const API = (() => {
  if (!BACKEND) return "";
  try { if (location.origin === BACKEND) return ""; } catch {}
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "";
  return BACKEND;
})();

// where "watch live" should send people (the HUD lives on the backend/rig host)
export const STREAM_URL = (API || "") + "/stream/hud/scene.html";
