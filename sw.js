// Service worker: guarda la app entera para que una recarga sin red funcione.
// Al publicar cambios, sube VERSION: así los móviles descargan la versión nueva.
const VERSION = 'thq-2026-10-08-5';
const CACHE = `app-${VERSION}`;
const CACHE_EXTRA = 'extra-v1';

const APP = [
  './',
  './index.html',
  './profe.html',
  './css/app.css',
  './css/profe.css',
  './js/config.js',
  './js/db.js',
  './js/api.js',
  './js/qr.js',
  './js/alumno.js',
  './js/profe.js',
  './js/importar.js',
  './manifest.json',
  './icons/favicon.svg',
  './img/hockey-banner.jpg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(APP.map((u) => new Request(u, { cache: 'reload' })));
    // Las librerías de CDN no deben impedir la instalación si fallan.
    await Promise.all(CDN.map((u) => c.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const claves = await caches.keys();
    await Promise.all(claves.filter((k) => k.startsWith('app-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const esSupabase = (url) => url.hostname.endsWith('.supabase.co');
const esFuente = (url) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // La API y Realtime siempre van a la red: nunca respuestas viejas.
  if (esSupabase(url)) return;

  if (req.mode === 'navigate') {
    // ?c=CODIGO y similares: misma página.
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const pagina = url.pathname.endsWith('profe.html') ? './profe.html' : './index.html';
      return (await c.match(pagina)) || fetch(req);
    })());
    return;
  }

  if (esFuente(url)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE_EXTRA);
      const guardada = await c.match(req);
      const red = fetch(req)
        .then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; })
        .catch(() => guardada || Response.error());
      return guardada || red;
    })());
    return;
  }

  e.respondWith((async () => {
    const guardada = await caches.match(req, { ignoreSearch: url.origin === self.location.origin });
    if (guardada) return guardada;
    const res = await fetch(req);
    if (res.ok && (url.origin === self.location.origin || CDN.includes(req.url))) {
      const c = await caches.open(CACHE);
      c.put(req, res.clone());
    }
    return res;
  })());
});
