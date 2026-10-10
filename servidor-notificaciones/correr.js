/* Arranque del servidor de notificaciones del club en GitHub Actions. Lo ejecuta, cada 10 minutos, el flujo
   .github/workflows/notificaciones.yml (en la carpeta principal del repositorio). Lo que hace cada vuelta está en
   lib/vuelta.js.

   Necesita un único secreto del repositorio, FIREBASE_CUENTA: el contenido completo del archivo .json de una cuenta de
   servicio de Firebase (Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada). Llega como
   variable de entorno: nunca está en el código ni se guarda en ningún archivo, y GitHub lo tapa en los registros.

   Los registros de un repositorio público los puede ver cualquiera: aquí solo se escriben cifras y avisos, nunca
   nombres, identificadores, direcciones de dispositivos ni claves.

   Probarlo en una computadora (con Node.js 22 o más):  npm ci  y después  FIREBASE_CUENTA="$(cat clave.json)" node correr.js */
'use strict';
const { vuelta, VERSION, MINUTOS } = require('./lib/vuelta');

// Cualquier cosa que parezca un identificador, una dirección o una clave se tapa antes de escribirla.
const LARGO = /[A-Za-z0-9_-]{16,}/g;
const limpio = (x) => String(x === undefined || x === null ? '' : x).replace(LARGO, '…').replace(/\s+/g, ' ').trim().slice(0, 300);

const MENSAJES = {
  falta: 'Falta el secreto FIREBASE_CUENTA. En GitHub: Settings → Secrets and variables → Actions → New repository secret, con el nombre FIREBASE_CUENTA y, como valor, TODO el contenido del archivo .json de la cuenta de servicio de Firebase.',
  json: 'El secreto FIREBASE_CUENTA no es un JSON válido: hay que pegar el contenido COMPLETO del archivo .json (desde la primera { hasta la última }), sin cambiar nada.',
  campos: 'El secreto FIREBASE_CUENTA no parece la clave de una cuenta de servicio de Firebase (le falta "type": "service_account", el proyecto, el correo o la clave privada). Se genera en Firebase: Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada.'
};

/** El secreto: { ok, cuenta } o { error: 'falta' | 'json' | 'campos' }. Nunca se escribe en ningún sitio. */
function leerCuenta(texto) {
  const t = String(texto || '').replace(/^﻿/, '').trim();
  if (!t) return { error: 'falta' };
  let c;
  try { c = JSON.parse(t); } catch (err) { return { error: 'json' }; }
  if (!c || typeof c !== 'object' || c.type !== 'service_account' || typeof c.project_id !== 'string' || !/^[a-z0-9-]{4,40}$/.test(c.project_id) ||
    typeof c.client_email !== 'string' || !/BEGIN PRIVATE KEY/.test(String(c.private_key || ''))) return { error: 'campos' };
  return { ok: true, cuenta: c };
}

/** Qué pasó, en palabras, para los errores más comunes (sin repetir nada del secreto). */
function explicar(err, proyecto) {
  const c = err && err.code;
  const m = String((err && (err.message || (typeof err.details === 'string' ? err.details : ''))) || err);
  if (c === 16 || /UNAUTHENTICATED|invalid_grant|invalid_client|Invalid JWT|account not found/i.test(m)) {
    return 'Firebase no aceptó la clave de la cuenta de servicio (¿se borró o se cambió en Firebase?). Genera una clave nueva y pégala entera en el secreto FIREBASE_CUENTA.';
  }
  if (c === 7 || /PERMISSION_DENIED/i.test(m)) return 'La cuenta de servicio no tiene permiso para usar Firestore en el proyecto «' + proyecto + '». Usa la clave que da Firebase en Configuración del proyecto → Cuentas de servicio (la cuenta firebase-adminsdk).';
  if ((c === 5 || /NOT_FOUND/.test(m)) && /database/i.test(m)) return 'El proyecto «' + proyecto + '» no tiene base de datos Firestore. ¿Es la clave del proyecto de la app?';
  if (c === 9 && /index/i.test(m)) return 'Firestore pidió un índice compuesto (con este servidor no debería pasar): ' + limpio(m);
  if (c === 14 || c === 4 || /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|UNAVAILABLE|DEADLINE/i.test(m)) return 'No se pudo hablar con Firebase (un problema de red pasajero). La próxima vuelta lo intentará otra vez.';
  return 'Error inesperado' + (typeof c === 'number' ? ' (código ' + c + ')' : '') + ': ' + limpio(m);
}

/** La dirección de contacto que va en cada envío (la piden Google, Apple y Mozilla): la de la app en GitHub Pages. */
function contactoDe(env) {
  if (env.CONTACTO && /^(https:\/\/|mailto:)\S+$/.test(env.CONTACTO)) return env.CONTACTO;
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(env.GITHUB_REPOSITORY || '');
  if (m) {
    const duenio = m[1].toLowerCase();
    return m[2].toLowerCase() === duenio + '.github.io' ? 'https://' + duenio + '.github.io/' : 'https://' + duenio + '.github.io/' + m[2] + '/';
  }
  return 'https://mlmercielourdesmert29-prog.github.io/amigo/';
}

/** Cada cuánto corre GitHub esta vuelta: lo dice el flujo (MINUTOS, entre 5 y 60). La app lo usa para saber cuánto esperar. */
function minutosDe(env) {
  const n = Math.round(Number(env.MINUTOS));
  return n >= 5 && n <= 60 ? n : MINUTOS;
}

/** Firestore de verdad (firebase-admin), por REST: arranca más rápido que gRPC y basta para lo que se hace aquí. */
function firestoreReal(cuenta) {
  const { initializeApp, cert } = require('firebase-admin/app');
  const { initializeFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
  const app = initializeApp({ credential: cert(cuenta), projectId: cuenta.project_id }, 'servidor-notificaciones');
  const db = initializeFirestore(app, { preferRest: true });
  return { db, FV: FieldValue, TS: Timestamp, cerrar: () => db.terminate().catch(() => {}) };
}

/** El registro: solo cifras; los textos de error, tapados. «::warning::» y «::error::» los resalta GitHub. */
function registro(salida) {
  const cifras = (o) => {
    if (!o || typeof o !== 'object') return '';
    const p = Object.keys(o).filter((k) => typeof o[k] === 'number' || k === 'error').map((k) => (k === 'error' ? limpio(o[k]) : k + ' ' + o[k]));
    return p.length ? ' — ' + p.join(', ') : '';
  };
  return {
    info: (m, o) => salida(limpio(m) + cifras(o)),
    warn: (m, o) => salida('::warning::' + limpio(m) + cifras(o)),
    error: (m, o) => salida('::warning::' + limpio(m) + cifras(o))
  };
}

/** El resumen de la vuelta: en el registro y, en GitHub, en la página de la ejecución. */
function resumir(r, seg, salida, archivo) {
  const filas = [
    ['Solicitudes de la app atendidas', r.solicitudes],
    ['Alumnos replanificados por un cambio', r.planificados],
    ['Notificaciones de prueba', r.pruebas],
    ['Avisos de evidencias devueltas', r.evidencias],
    ['Repaso de los horarios de todos', r.repaso < 0 ? 'no tocaba' : r.repaso + ' alumnos'],
    ['Avisos del Club repartidos', r.club],
    ['Envíos procesados', r.procesados],
    ['Aceptados por el servicio de notificaciones', r.enviados],
    ['Envíos que se habían quedado a medias', r.atascados],
    ['Registros viejos borrados', r.borrados],
    ['Errores', r.errores]
  ];
  salida('Vuelta hecha en ' + seg.toFixed(1) + ' s.');
  filas.forEach((f) => salida('  ' + f[0] + ': ' + f[1]));
  if (archivo) {
    try {
      require('node:fs').appendFileSync(archivo, '### Notificaciones del club · vuelta hecha en ' + seg.toFixed(1) + ' s\n\n| | |\n|---|---|\n' + filas.map((f) => '| ' + f[0] + ' | ' + f[1] + ' |').join('\n') + '\n');
    } catch (err) { /* el resumen de la página es opcional */ }
  }
}

/**
 * Una vuelta completa. opc (todo opcional, para las pruebas): { env, salida, firestore (en vez del de verdad),
 * webpush, enviador, ahora }. Devuelve el código de salida: 0 si salió bien (o si manda Cloud Functions), 1 si no.
 */
async function principal(opc) {
  opc = opc || {};
  const env = opc.env || process.env;
  const salida = opc.salida || ((t) => console.log(t));
  const log = registro(salida);
  const inicio = Date.now();
  salida('Servidor de notificaciones del club · GitHub Actions · versión ' + VERSION + ' · cada ' + minutosDe(env) + ' minutos');
  const c = leerCuenta(env.FIREBASE_CUENTA);
  if (!c.ok) { salida('::error::' + MENSAJES[c.error]); return 1; }
  const proyecto = c.cuenta.project_id;
  salida('Proyecto de Firebase: ' + proyecto);
  let fb;
  try { fb = (opc.firestore || firestoreReal)(c.cuenta); } catch (err) { salida('::error::No se pudo preparar la conexión con Firebase. ' + explicar(err, proyecto)); return 1; }
  let codigo = 0;
  try {
    const r = await vuelta({ db: fb.db, FV: fb.FV, TS: fb.TS, log, webpush: opc.webpush || require('web-push'), contacto: contactoDe(env), minutos: minutosDe(env), ahora: opc.ahora, enviador: opc.enviador });
    if (r.estado === 'cede') salida('El servidor de Cloud Functions del club está activo: él envía las notificaciones y esta vuelta no hace nada.');
    else {
      if (r.clavesNuevas) salida('Primera vuelta: se crearon las claves del servidor de notificaciones. La pública ya está en config/push (la usa la app); la privada quedó en config/servidor, que nadie puede leer desde la app.');
      resumir(r, (Date.now() - inicio) / 1000, salida, env.GITHUB_STEP_SUMMARY);
    }
  } catch (err) {
    salida('::error::' + explicar(err, proyecto));
    codigo = 1;
  } finally {
    if (fb && fb.cerrar) await fb.cerrar();
  }
  return codigo;
}

if (require.main === module) {
  // Un tope por si algo se queda colgado (GitHub, además, corta el trabajo a los 8 minutos).
  setTimeout(() => { console.log('::error::La vuelta tardó demasiado y se cortó. La próxima lo intentará otra vez.'); process.exit(1); }, 7 * 60e3).unref();
  principal().then((codigo) => process.exit(codigo), (err) => { console.log('::error::' + limpio(err && err.message)); process.exit(1); });
}

module.exports = { principal, leerCuenta, explicar, contactoDe, minutosDe, limpio, MENSAJES };
