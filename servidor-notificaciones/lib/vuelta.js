/* Una vuelta del servidor de notificaciones del club en GitHub Actions.

   GitHub la corre cada 10 minutos (.github/workflows/notificaciones.yml). Es el mismo servidor que el de Cloud
   Functions: nucleo.js, envio.js y avisos-motor.js son copias exactas (las hace python/construir.py). Cambia esto:
     · No hay «disparadores». Cuando algo cambia (los horarios o los dispositivos de un alumno, una notificación de
       prueba, una evidencia devuelta, una cuenta borrada), la app deja un aviso en la colección «solicitudes» y aquí se
       atiende en la vuelta siguiente. Cada solicitud solo dice de quién es y qué pasó: lo demás se lee de la base.
     · Las claves VAPID las crea la primera vuelta y quedan en config/servidor, un documento que nadie puede leer desde
       la app (las reglas no lo permiten): solo esta cuenta de servicio. La pública se anuncia en config/push.
     · No hay índices compuestos de Firestore: el núcleo usa consultas con solo igualdades y planifica 4 horas por
       delante. Cada hora (en la primera vuelta que pase la hora) repasa los horarios de todos los alumnos; una vez al
       día, después de las 3 de la mañana, borra lo viejo.
     · Si el servidor de Cloud Functions está activo (late), esta vuelta no hace nada: manda uno solo.
   Lo que se anota en el registro es público (los de GitHub Actions de un repositorio público los ve cualquiera): solo
   cifras y avisos sin datos de nadie. */
'use strict';
const M = require('./avisos-motor');
const { crearNucleo } = require('./nucleo');
const { crearEnviador, clavesDelMismoPar } = require('./envio');

const VERSION = '2026.10-gh1';
const MINUTOS = 10;                 // cada cuánto la corre GitHub (el flujo lo dice en MINUTOS; esto, si no lo dice)
const ZONA = 'America/Santo_Domingo';
const VENTANA = 4 * 36e5;           // se planifica 4 horas por delante (y el repaso es cada hora)
const REPASO = 55 * 60e3;           // el repaso de todos los alumnos: una vez por hora
const TARDE_AUTO = 3 * 36e5;        // un recordatorio con más de 3 horas de retraso ya no se manda como notificación
const CEDER = 15 * 60e3;            // si Cloud Functions latió hace menos de esto, manda él
const PRUEBA_VIEJA = 6 * 36e5;      // una prueba pedida hace más de esto ya no se envía
const ESPERA_BORRAR = 24 * 36e5;    // «borrar» con el perfil todavía presente: se espera como mucho un día
const ESPERA_ERROR = 36e5;          // una solicitud que dio error se reintenta durante una hora
const POR_VUELTA = 100;             // solicitudes por vuelta
const UID = /^[A-Za-z0-9_-]{1,128}$/;

const ms = (t) => (!t ? 0 : typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : Date.parse(t) || 0);
const yaExiste = (err) => !!err && (err.code === 6 || /ALREADY_EXISTS|already exists/i.test(String(err.message || '')));

/** Las claves VAPID del club: las de config/servidor o, la primera vez, unas nuevas. */
async function clavesDelServidor(db, TS, webpush, t0, log) {
  const ref = db.doc('config/servidor');
  const s = await ref.get();
  const d = s.exists ? s.data() : {};
  if (clavesDelMismoPar(d.vapidPublica, d.vapidPrivada)) return { publica: d.vapidPublica, privada: d.vapidPrivada, cfg: d, nuevas: false };
  const k = webpush.generateVAPIDKeys();
  const nuevas = { vapidPublica: k.publicKey, vapidPrivada: k.privateKey, creadas: TS.fromMillis(t0) };
  if (s.exists) {
    // Había algo que no sirve (alguien editó el documento a mano): se cambian, y cada dispositivo se vuelve a
    // suscribir solo al abrir la app.
    log.warn('Las claves guardadas en config/servidor no servían: se crearon unas nuevas (cada dispositivo se vuelve a suscribir al abrir la app).');
    await ref.set(nuevas, { merge: true });
    return { publica: k.publicKey, privada: k.privateKey, cfg: Object.assign({}, d, nuevas), nuevas: true };
  }
  try {
    await ref.create(nuevas);
    return { publica: k.publicKey, privada: k.privateKey, cfg: nuevas, nuevas: true };
  } catch (err) {
    if (!yaExiste(err)) throw err;
    // Otra vuelta las creó en el mismo momento: valen esas.
    const d2 = (await ref.get()).data() || {};
    if (!clavesDelMismoPar(d2.vapidPublica, d2.vapidPrivada)) throw new Error('No se pudieron leer las claves del servidor de notificaciones');
    return { publica: d2.vapidPublica, privada: d2.vapidPrivada, cfg: d2, nuevas: false };
  }
}

/** Se borra solo si nadie la volvió a escribir mientras se atendía (si no, queda para la vuelta siguiente). */
async function quitarSolicitud(db, ref, t) {
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists && ms(s.get('t')) === t) tx.delete(ref);
  });
}

/** Lo que dejó la app en «solicitudes»: cada una se atiende y se borra. Devuelve a quién ya se planificó. */
async function atenderSolicitudes(db, n, t0, log, r) {
  const q = await db.collection('solicitudes').limit(POR_VUELTA).get();
  const hechos = new Set();
  // Lo que se envió en el momento (una prueba, una evidencia devuelta) cuenta también en el resumen de envíos.
  const contar = (x) => { if (!x) return false; r.procesados++; if (x === 'enviado' || x === 'parcial') r.enviados++; return true; };
  for (const s of q.docs) {
    const tipo = String(s.get('tipo') || ''), uid = String(s.get('uid') || ''), t = ms(s.get('t'));
    let quitar = true;
    r.solicitudes++;
    try {
      if (!UID.test(uid)) {
        // Mal formada (las reglas no deberían dejarla pasar): se quita sin más.
      } else if (tipo === 'planificar') {
        // Cambió sus horarios o sus dispositivos.
        if (!hechos.has(uid)) { await n.planificar(uid); hechos.add(uid); r.planificados++; }
      } else if (tipo === 'prueba') {
        // «Enviar una notificación de prueba»: la petición de verdad está en su notif/prueba (las reglas dejan una cada 30 segundos).
        const p = await db.doc(`alumnos/${uid}/notif/prueba`).get();
        if (p.exists && t0 - ms(p.get('pedida')) <= PRUEBA_VIEJA && contar(await n.alProbar(uid, p.data()))) r.pruebas++;
      } else if (tipo === 'revision') {
        // El equipo pidió repetir una evidencia (o no la aprobó): se lee la revisión tal como está ahora.
        const dia = String(s.get('dia') || '');
        if (/^\d{1,2}$/.test(dia)) {
          const rv = await db.doc(`alumnos/${uid}/revisiones/${dia}`).get();
          if (rv.exists && contar(await n.alRevisar(uid, dia, null, rv.data()))) r.evidencias++;
        }
      } else if (tipo === 'borrar') {
        // Se borró una cuenta: lo que quedó de ella (su registro de envíos, que la app no puede borrar). Mientras el
        // perfil exista, la cuenta todavía se está borrando (o no se borró): se espera.
        const perfil = await db.doc('alumnos/' + uid).get();
        if (perfil.exists) quitar = t0 - t > ESPERA_BORRAR;
        else r.borrados += await n.alBorrarAlumno(uid);
      }
    } catch (err) {
      r.errores++;
      log.error('No se pudo atender una solicitud de la app (' + tipo + ')', { error: String((err && err.message) || err) });
      quitar = t0 - t > ESPERA_ERROR;
    }
    if (quitar) await quitarSolicitud(db, s.ref, t);
  }
  return hechos;
}

/**
 * Una vuelta. dep: { db, FV, TS, log, webpush, contacto, minutos (cada cuánto la corre GitHub), ahora (para las pruebas),
 * enviador (para las pruebas) }.
 * Devuelve lo que hizo: { estado: 'hecha' | 'cede', clavesNuevas, solicitudes, planificados, pruebas, evidencias,
 * repaso, borrados, procesados, enviados, atascados, club, errores }.
 */
async function vuelta(dep) {
  const { db, FV, TS, log, webpush } = dep;
  const ahora = dep.ahora || (() => Date.now());
  const t0 = ahora();
  const r = { estado: 'hecha', clavesNuevas: false, solicitudes: 0, planificados: 0, pruebas: 0, evidencias: 0, repaso: -1, borrados: 0, procesados: 0, enviados: 0, atascados: 0, club: 0, errores: 0 };
  // 1. Si las Cloud Functions del club están activas, mandan ellas.
  const push = await db.doc('config/push').get();
  const esFunctions = push.exists && (push.get('servidor') === 'functions' || (!push.get('servidor') && !!push.get('region')));
  if (esFunctions && t0 - ms(push.get('latido')) < CEDER) return Object.assign(r, { estado: 'cede' });
  // 2. Las claves VAPID (la primera vez se crean).
  const k = await clavesDelServidor(db, TS, webpush, t0, log);
  r.clavesNuevas = k.nuevas;
  if (k.nuevas) {
    const pub = await db.doc('config/publico').get();
    if (!pub.exists) log.warn('En este proyecto no existe config/publico (el nombre del club). Si la app ya está configurada, revisa que la clave del secreto FIREBASE_CUENTA sea del mismo proyecto que la app (central.json).');
  }
  // 3. El núcleo, como lo necesita GitHub Actions.
  const n = crearNucleo({
    db, FV, TS, log, ahora, publica: k.publica, version: VERSION, region: '', servidor: 'github', minutos: dep.minutos || MINUTOS,
    ventana: VENTANA, consultasSimples: true, siempreLatido: true, tardeAuto: TARDE_AUTO,
    enviador: dep.enviador || (() => crearEnviador({ webpush, publica: k.publica, privada: k.privada, contacto: dep.contacto }))
  });
  // 4. Lo que pidió la app desde la vuelta anterior.
  const hechos = await atenderSolicitudes(db, n, t0, log, r);
  // 5. Una vez por hora, los horarios de todos (por si se perdió alguna solicitud); una vez al día, la limpieza.
  const cfg = db.doc('config/servidor');
  if (t0 - ms(k.cfg.planificado) >= REPASO) {
    await cfg.set({ planificado: TS.fromMillis(t0) }, { merge: true });
    r.repaso = await n.planificarTodos(hechos);
  }
  const p = M.partes(t0, ZONA);
  if (p.hora >= '03:00' && k.cfg.limpiado !== p.fecha) {
    await cfg.set({ limpiado: p.fecha }, { merge: true });
    r.borrados += await n.limpiar();
  }
  // 6. Lo que ya tocaba enviar; y el latido (config/push), que la app usa para saber que el servidor funciona.
  const d = await n.despachar();
  return Object.assign(r, { procesados: r.procesados + d.procesados, enviados: r.enviados + d.enviados, atascados: d.atascados, club: d.club });
}

module.exports = { vuelta, VERSION, MINUTOS, VENTANA, REPASO, CEDER, ZONA };
