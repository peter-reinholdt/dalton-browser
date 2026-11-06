// Deployment setting: a pinned external HTTPS distribution may be used here.
// Its JSmol.min.js and all j2s resources must permit CORS and COEP loading.
// Keep the viewer document itself local; molecular data stays in inline loads.
export const JSMOL_BASE = new URL('./vendor/jsmol/', import.meta.url).href;
