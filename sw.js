/* Service worker de Ruta de Amigo. Guarda la app para usarla sin Internet.
   construir.py reemplaza 09705e02b4 y ["./", "manifest.json", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]. No edites publicar/sw.js a mano. */
const VERSION = '09705e02b4';
const CACHE = 'ruta-amigo-' + VERSION;
const ARCHIVOS = ["./", "manifest.json", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
const aqui = (ruta) => new URL(ruta, self.registration.scope).href;
const INICIO = aqui('./');   // la app se guarda con la dirección de la carpeta, que es el enlace que se comparte
const TEXTOS = aqui('textos-del-club.txt');
const CENTRAL = aqui('central.json');   // configuración de la base central del club (opcional)
// Biblioteca de recursos: los PDF del instructor y el visor de PDF. No se guardan al instalar (pesan más que la app):
// se guardan cuando el alumno los abre o cuando toca «Guardar todos». Su almacén no empieza por «ruta-amigo-»,
// así que no se borra al actualizar la app.
const RECURSOS = 'amigo-recursos-v1';
const CARPETA = aqui('recursos/');

// Al instalarse guarda la app completa. «no-cache» obliga a preguntarle al servidor si cada
// archivo cambió: si no cambió, se aprovecha la copia que el navegador acaba de bajar
// (así la primera visita no descarga la app dos veces); si cambió, baja la versión nueva.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(ARCHIVOS.map((a) =>
    fetch(new Request(aqui(a), { cache: 'no-cache' })).then((r) => {
      if (!r.ok) throw new Error('No se pudo guardar ' + a);
      return c.put(aqui(a), r);
    })
  ))));
});

// Al activarse borra las versiones anteriores.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('ruta-amigo-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Los textos del club y la configuración de la base central se piden siempre a la red: quien publica
// puede cambiarlos cuando quiera. Si el club no ha subido el archivo, la app recibe un texto vacío en lugar de un error.
function textosDelClub(req) {
  return fetch(req, { cache: 'no-store' }).then((r) => {
    if (r.ok) return r;
    if (r.status === 404) return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response('', { status: 503 });
  }).catch(() => new Response('', { status: 503 }));
}

// Un archivo de la biblioteca: primero lo guardado; si no está, se pide a la red y se guarda para la próxima vez.
// Cada dirección lleva la huella del archivo (?v=…): si el instructor cambia un PDF, la versión vieja se descarta.
function recurso(req) {
  if (req.headers.has('range')) return fetch(req);   // un trozo suelto (lo piden algunos visores): no se guarda
  return caches.open(RECURSOS).then((c) => c.match(req).then((guardado) => guardado || fetch(req).then((r) => {
    if (r.ok && r.status === 200) {
      const copia = r.clone(), ruta = new URL(req.url).pathname;
      c.put(req, copia).then(() => c.keys()).then((ks) => Promise.all(ks.filter((k) => k.url !== req.url && new URL(k.url).pathname === ruta).map((k) => c.delete(k)))).catch(() => {});
    }
    return r;
  })));
}

// Todo lo demás se responde desde lo guardado; solo va a la red si algo no está guardado.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.origin + url.pathname === TEXTOS || url.origin + url.pathname === CENTRAL) { e.respondWith(textosDelClub(req)); return; }
  if (url.href.indexOf(CARPETA) === 0) { e.respondWith(recurso(req)); return; }
  if (req.mode === 'navigate') { e.respondWith(caches.match(INICIO).then((r) => r || fetch(req))); return; }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});

// La página avisa cuando el usuario acepta actualizar.
self.addEventListener('message', (e) => {
  if (e.data === 'activar') self.skipWaiting();
});
