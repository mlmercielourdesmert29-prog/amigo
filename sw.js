/* Service worker de Ruta de Amigo. Guarda la app para usarla sin Internet.
   construir.py reemplaza 1a3ea04656 y ["./", "manifest.json", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "insignia-96.png"]. No edites publicar/sw.js a mano. */
const VERSION = '1a3ea04656';
const CACHE = 'ruta-amigo-' + VERSION;
const ARCHIVOS = ["./", "manifest.json", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "insignia-96.png"];
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

/* ---------- Notificaciones push ---------- */
// El servidor del club manda cada aviso cifrado (Web Push). Aquí se muestra como notificación del sistema, se anota en
// IndexedDB que llegó (la app lo pone en su bandeja y lo cuenta como «recibido» al abrirse) y, al tocarla, se abre la
// sección correcta de la app. La notificación se muestra SIEMPRE: los navegadores lo exigen (y Safari retira la
// suscripción si no se hace). No hay alarmas locales: sin servidor y sin Internet, una app web no puede despertarse sola.
const BD = 'ruta-amigo-sw';
function bdAbrir() {
  return new Promise((ok) => {
    try {
      const r = indexedDB.open(BD, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('eventos')) db.createObjectStore('eventos', { keyPath: 'k', autoIncrement: true });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
    } catch (err) { ok(null); }
  });
}
function anotar(ev) {
  return bdAbrir().then((db) => new Promise((ok) => {
    if (!db) { ok(); return; }
    try {
      const tx = db.transaction('eventos', 'readwrite');
      tx.objectStore('eventos').add(ev);
      tx.oncomplete = () => ok();
      tx.onerror = () => ok();
    } catch (err) { ok(); }
  }));
}
// El número sobre el icono de la app (Android con la app instalada, iPhone 16.4 o más): uno más por cada aviso que llega.
function sumarInsignia() {
  return bdAbrir().then((db) => new Promise((ok) => {
    if (!db || !self.navigator || !self.navigator.setAppBadge) { ok(); return; }
    try {
      const tx = db.transaction('meta', 'readwrite'), st = tx.objectStore('meta'), r = st.get('noLeidas');
      r.onsuccess = () => { const n = (Number(r.result) || 0) + 1; st.put(n, 'noLeidas'); self.navigator.setAppBadge(n).catch(() => {}); };
      tx.oncomplete = () => ok();
      tx.onerror = () => ok();
    } catch (err) { ok(); }
  }));
}
const rutaSegura = (r) => (typeof r === 'string' && r.length <= 120 && /^#\/[A-Za-z0-9/_.-]*$/.test(r) && r.indexOf('..') < 0 ? r : '#/avisos');
self.addEventListener('push', (e) => {
  let a = {};
  try { a = e.data ? e.data.json() : {}; } catch (err) { a = { titulo: 'Ruta de Amigo', texto: e.data ? String(e.data.text()).slice(0, 300) : '' }; }
  const id = String(a.id || '').slice(0, 160);
  const aviso = { id, titulo: String(a.titulo || 'Ruta de Amigo').slice(0, 80), texto: String(a.texto || '').slice(0, 300), ruta: rutaSegura(a.ruta),
    cat: String(a.cat || '').slice(0, 20), estilo: String(a.estilo || '').slice(0, 20), t: Number(a.t) || Date.now(), envio: String(a.envio || '').slice(0, 200) };
  const opciones = { body: aviso.texto, icon: aqui('icon-192.png'), badge: aqui('insignia-96.png'), tag: id || 'ruta-amigo', timestamp: aviso.t, lang: 'es', data: { id, ruta: aviso.ruta, aviso } };
  e.waitUntil(Promise.all([
    self.registration.showNotification(aviso.titulo, opciones),
    anotar({ tipo: 'recibida', id, t: Date.now(), aviso }),
    sumarInsignia(),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => ws.forEach((w) => w.postMessage({ tipo: 'push', aviso })))
  ]).catch(() => {}));
});
// Al tocar la notificación: la app abierta va a la sección del aviso; si no está abierta, se abre ahí.
// (Va en una función con nombre para poder probarlo: una prueba automática no puede «tocar» una notificación real.)
function alTocarNotificacion(n) {
  n.close();
  const d = n.data || {};
  const ruta = rutaSegura(d.ruta);
  return anotar({ tipo: 'abierta', id: String(d.id || ''), t: Date.now(), aviso: d.aviso || null })
    .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .then((ws) => {
      const w = ws.filter((x) => x.url.indexOf(INICIO) === 0)[0];
      if (w) { w.postMessage({ tipo: 'abrir', id: String(d.id || ''), ruta }); return w.focus(); }
      return self.clients.openWindow(INICIO + ruta);
    }).catch(() => {});
}
self.addEventListener('notificationclick', (e) => { e.waitUntil(alTocarNotificacion(e.notification)); });
// El navegador renovó (o perdió) la suscripción: la app la vuelve a registrar en la base del club al abrirse.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(anotar({ tipo: 'suscripcion', t: Date.now() }));
});
