/* Núcleo del servidor de notificaciones del club. Todo lo que decide y escribe el servidor está aquí; index.js solo lo
   conecta con Cloud Functions. Se prueba con un Firestore de mentira (pruebas/), sin Internet.

   Cómo funciona (cada cosa en la colección «envios», un documento por notificación):
     · planificar(uid): con los horarios del alumno crea los recordatorios de las próximas 26 horas (uno por ocurrencia,
       con la misma clave que usa la app) y cancela los que ya no tocan. Se llama cada hora y al cambiar sus preferencias
       o sus dispositivos.
     · despachar(): cada minuto. Recupera lo que se quedó a medias, reparte los avisos del Club que ya llegaron a su hora
       y procesa lo pendiente cuya hora ya pasó.
     · procesar(envío): primero lo «reclama» en una transacción (si dos vueltas coinciden, solo una lo procesa); después
       decide con el estado real del alumno (avisos-motor.js) si todavía sirve, lo deja en su bandeja y lo envía a sus
       dispositivos. Cada dispositivo que ya lo aceptó queda anotado: en un reintento no se le vuelve a enviar.
   Estados de un envío: pendiente → procesando → enviado | parcial | fallido | cancelado | omitido | sin-dispositivos.
   «Enviado» quiere decir que el servicio de notificaciones (Google, Apple, Mozilla, Microsoft) lo ACEPTÓ; la entrega al
   teléfono la confirma la app (recibida/abierta/leída) cuando se abre.

   El mismo núcleo sirve para el servidor de GitHub Actions (github/subir/servidor-notificaciones), que corre cada
   10 minutos y no tiene índices compuestos de Firestore. Para eso, crearNucleo admite (si faltan, todo queda como en
   Cloud Functions):
     ventana          cuánto se planifica por delante (ms).
     consultasSimples consultas que no necesitan índices compuestos: solo con igualdades, y lo demás se filtra aquí.
     minutos          cada cuánto revisa el servidor (se anota en config/push para que la app lo sepa).
     servidor         'functions' o 'github' (se anota en config/push).
     siempreLatido    late en cada vuelta (si no, cada 5 minutos).
     tardeAuto        un recordatorio automático con más retraso que esto (ms) ya no se manda como notificación. */
'use strict';
const M = require('./avisos-motor');
const { DETALLE_CLAVES } = require('./envio');

const MAX_INTENTOS = 4;
const ESPERAS = [60e3, 5 * 60e3, 15 * 60e3];   // espera antes de cada reintento
const ATASCO = 3 * 60e3;                        // «procesando» más de esto: se quedó a medias
const VENTANA = 26 * 36e5;                      // se planifica hasta 26 horas por delante
const POR_VUELTA = 100;
const TARDE_CLUB = 24 * 36e5;                   // un aviso del Club con más de un día de retraso ya no se manda como notificación
const ANTIGUO_ENVIOS = 30 * 864e5, ANTIGUO_BANDEJA = 60 * 864e5;
const UID = /^[A-Za-z0-9_-]{1,128}$/;

function crearNucleo(dep) {
  const { db, FV, TS, log, publica, version, region } = dep;
  const ahoraMs = dep.ahora || (() => Date.now());
  const ventana = dep.ventana || VENTANA, simples = !!dep.consultasSimples, tardeAuto = dep.tardeAuto || 0;
  let enviadorHecho = null;
  const enviador = () => enviadorHecho || (enviadorHecho = typeof dep.enviador === 'function' ? dep.enviador() : dep.enviador);
  const ms = (t) => (!t ? 0 : typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : Date.parse(t) || 0);
  const ts = (m) => TS.fromMillis(Math.round(m));
  const yaExiste = (err) => !!err && (err.code === 6 || /ALREADY_EXISTS|already exists/i.test(String(err.message || '')));
  const json = (t) => { try { return JSON.parse(t); } catch (err) { return null; } };
  const texto = (x, n) => String(x === undefined || x === null ? '' : x).slice(0, n);
  const esperaDe = (intentos) => ESPERAS[Math.min(Math.max(intentos, 1) - 1, ESPERAS.length - 1)];

  /* ---------- Lo que se sabe del alumno ---------- */
  async function prefsDe(uid) {
    const d = await db.doc(`alumnos/${uid}/notif/prefs`).get();
    return M.normalizarPrefs(d.exists ? json(d.get('json')) : null);
  }
  let clubCache = null;
  async function club() {
    if (clubCache && ahoraMs() - clubCache.t < 60e3) return clubCache.d;
    const d = await db.doc('config/publico').get();
    clubCache = { t: ahoraMs(), d: { evidencias: d.exists && d.get('evidencias') === true } };
    return clubCache.d;
  }
  /** El estado de estudio que subió la app, con las evidencias tal como están en la base (lo de la app puede estar viejo). */
  async function estadoDe(uid, cl) {
    const d = await db.doc(`alumnos/${uid}/notif/estado`).get();
    const est = M.normalizarEstado(d.exists ? json(d.get('json')) : null);
    if (cl && cl.evidencias) {
      const [evs, revs] = await Promise.all([db.collection(`alumnos/${uid}/evidencias`).get(), db.collection(`alumnos/${uid}/revisiones`).get()]);
      const rev = {};
      revs.docs.forEach((r) => { rev[r.id] = r.data(); });
      const enviadas = [], repetir = [];
      evs.docs.forEach((ev) => {
        const n = Number(ev.id);
        if (!(n >= 1 && n <= 14)) return;
        enviadas.push(n);
        const r = rev[ev.id], v = Number(ev.get('v')) || 1;
        if (r && Number(r.v) === v && r.estado === 'repetir') repetir.push({ dia: n, v, com: texto(r.comentario, 200) });
      });
      enviadas.sort((a, b) => a - b);
      est.evid = { activas: true, enviadas, faltan: est.gemas.hechas.filter((n) => enviadas.indexOf(n) < 0), repetir };
    } else if (cl) est.evid = { activas: false, enviadas: [], faltan: [], repetir: [] };
    return est;
  }
  /** Los dispositivos que todavía reciben (los 5 usados más recientemente). */
  async function dispositivos(uid, soloId) {
    const q = await db.collection(`alumnos/${uid}/dispositivos`).get();
    return q.docs.filter((d) => d.get('valido') !== false && (!soloId || d.id === soloId))
      .sort((a, b) => String(b.get('visto') || '').localeCompare(String(a.get('visto') || ''))).slice(0, 5);
  }
  async function aliasDe(uid) { const p = await db.doc(`alumnos/${uid}`).get(); return p.exists ? texto(p.get('alias'), 20) : ''; }
  /** Lo que ya se avisó hoy (en la zona del alumno): cuántos recordatorios automáticos y de qué temas. */
  async function contextoDelDia(uid, p, t0) {
    const q = await db.collection(`alumnos/${uid}/avisos`).where('creado', '>=', ts(M.inicioDelDia(t0, p.zona))).get();
    const deHoy = q.docs.filter((d) => /^r-/.test(d.id) && (d.get('origen') === 'app' || d.get('origen') === 'auto'));
    return { enviados: deHoy.filter((d) => String(d.get('tema') || '').indexOf('u-') !== 0).length, temas: deHoy.map((d) => String(d.get('tema') || '')) };
  }
  const nuevoItem = (o, t0, envioId) => Object.assign({ creado: ts(t0), envioId, leida: '', abierta: '', archivada: false, oculta: false, recibida: '' }, o);

  /* ---------- Planificar ---------- */
  /** Los recordatorios automáticos de un alumno en las próximas 26 horas (o la ventana elegida): crea los que faltan y cancela los que ya no tocan. */
  async function planificar(uid) {
    if (!UID.test(String(uid))) return { creados: 0, cancelados: 0 };
    const t0 = ahoraMs();
    const disp = await dispositivos(uid);
    const pend = await db.collection('envios').where('uid', '==', uid).where('estado', '==', 'pendiente').get();
    const autos = pend.docs.filter((d) => d.get('origen') === 'auto' && ms(d.get('programado')) >= t0);
    if (!disp.length) {
      // Sin dispositivos no hay a dónde enviar. (La app del alumno igual le muestra sus recordatorios dentro.)
      for (const d of autos) await d.ref.update({ estado: 'cancelado', motivo: 'Sin dispositivos con notificaciones', terminado: ts(t0) });
      return { creados: 0, cancelados: autos.length };
    }
    const p = await prefsDe(uid), est = await estadoDe(uid, null);
    const quiero = {};
    M.ocurrencias(p, t0, t0 + ventana, { evaluacion: est.eval }).forEach((oc) => { quiero[M.idEnvio(uid, oc.clave)] = oc; });
    let creados = 0, cancelados = 0;
    for (const d of autos) if (!quiero[d.id]) { await d.ref.update({ estado: 'cancelado', motivo: 'Ya no está en sus horarios', terminado: ts(t0) }); cancelados++; }
    const alias = await aliasDe(uid);
    for (const id of Object.keys(quiero)) {
      const oc = quiero[id], ref = db.doc('envios/' + id);
      const datos = { uid, alias, clave: oc.clave, origen: 'auto', cat: oc.cat, programado: ts(oc.ms), creado: ts(t0), estado: 'pendiente', intentos: 0, bandeja: M.idBandeja(oc.clave),
        oc: { clave: oc.clave, tipo: oc.tipo, cat: oc.cat, fecha: oc.fecha, hora: oc.hora, ref: oc.ref, siHecho: !!oc.siHecho, texto: oc.texto || '', dias: oc.dias || 0 } };
      try { await ref.create(datos); creados++; } catch (err) {
        if (!yaExiste(err)) throw err;
        // Ya existía. Si se había cancelado porque el horario se quitó y ahora vuelve, se reactiva.
        const s = await ref.get();
        if (s.get('estado') === 'cancelado' && s.get('motivo') === 'Ya no está en sus horarios' && oc.ms > t0) { await ref.update({ estado: 'pendiente', motivo: FV.delete(), terminado: FV.delete(), programado: ts(oc.ms), oc: datos.oc }); creados++; }
        else if (s.get('estado') === 'pendiente' && ms(s.get('programado')) !== oc.ms) await ref.update({ programado: ts(oc.ms), oc: datos.oc });
      }
    }
    return { creados, cancelados };
  }
  /** Todos los alumnos (cada hora). saltar: los que ya se planificaron en esta misma vuelta (opcional). */
  async function planificarTodos(saltar) {
    const al = await db.collection('alumnos').select().get();
    let n = 0;
    for (const a of al.docs) {
      if (saltar && saltar.has(a.id)) continue;
      try { await planificar(a.id); n++; } catch (err) { log.error('No se pudo planificar', { uid: a.id, error: String(err && err.message) }); }
    }
    return n;
  }

  /* ---------- Despachar ---------- */
  function terminar(ref, estado, extra, t0) { return ref.update(Object.assign({ estado, terminado: ts(t0) }, extra || {})).then(() => estado); }

  /** Reclama un envío (solo una vuelta lo procesa) y lo procesa. Devuelve lo que pasó. */
  async function procesar(ref, t0) {
    const e = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const x = s.data();
      if (x.estado !== 'pendiente' || ms(x.programado) > t0) return null;
      const intentos = (Number(x.intentos) || 0) + 1;
      tx.update(ref, { estado: 'procesando', procesado: ts(t0), intentos, demoraMs: Math.max(0, t0 - ms(x.programado)) });
      return Object.assign({}, x, { intentos });
    });
    if (!e) return 'saltado';
    try {
      if (e.origen === 'auto') return await procesarAuto(ref, e, t0);
      if (e.origen === 'club') return await procesarClub(ref, e, t0);
      if (e.origen === 'prueba') return await procesarPrueba(ref, e, t0);
      if (e.origen === 'evento') return await procesarEvento(ref, e, t0);
      return await terminar(ref, 'fallido', { error: 'Origen desconocido' }, t0);
    } catch (err) {
      const msj = texto(err && err.message ? err.message : err, 200);
      log.error('Error al procesar un envío', { id: ref.id, error: msj });
      const otra = e.intentos < MAX_INTENTOS;
      await ref.update(otra ? { estado: 'pendiente', programado: ts(t0 + esperaDe(e.intentos)), error: msj } : { estado: 'fallido', terminado: ts(t0), error: msj });
      return otra ? 'reintento' : 'fallido';
    }
  }

  /** Lo envía a los dispositivos del alumno y anota el resultado en el envío y en su bandeja. */
  async function entregar(ref, e, uid, item, opc, bandeja, t0, soloDisp) {
    const ds = await dispositivos(uid, soloDisp);
    if (!ds.length) {
      const motivo = 'No hay dispositivos con notificaciones activadas';
      await bandeja.update({ push: { estado: 'sin-dispositivos', n: 0, t: ts(t0), motivo } }).catch(() => {});
      if (e.avisoId) await db.doc('avisos_club/' + e.avisoId).update({ 'push.omitidas': FV.increment(1) }).catch(() => {});
      return terminar(ref, 'sin-dispositivos', { motivo }, t0);
    }
    const carga = JSON.stringify(M.carga(Object.assign({}, item, { t: t0, envio: ref.id })));
    const antes = e.disp && typeof e.disp === 'object' ? e.disp : {}, res = {};
    await Promise.all(ds.map(async (d) => {
      // Ya lo aceptó en un intento anterior: no se le vuelve a enviar (no hay notificaciones repetidas por reintentos).
      if (antes[d.id] && antes[d.id].estado === 'aceptada') { res[d.id] = antes[d.id]; return; }
      const r = await enviador().enviar({ endpoint: d.get('endpoint'), keys: { p256dh: d.get('p256dh'), auth: d.get('auth') } }, carga, { ttl: opc.ttl, urgencia: opc.urgencia, id: ref.id });
      res[d.id] = { estado: r.estado, codigo: r.codigo || 0, t: ts(ahoraMs()) };
      if (r.detalle) res[d.id].detalle = texto(r.detalle, 200);
      // Se anota enseguida: si la función se corta después, el reintento sabe que a este dispositivo ya le llegó.
      if (r.estado === 'aceptada') await ref.update({ ['disp.' + d.id]: res[d.id] });
      if (r.estado === 'expirada') await d.ref.update({ valido: false, error: texto(r.detalle || 'La suscripción ya no vale', 200) });
    }));
    const vals = Object.keys(res).map((k) => res[k]);
    const ok = vals.filter((x) => x.estado === 'aceptada').length, pasajeros = vals.filter((x) => x.estado === 'reintentar').length;
    if (pasajeros && e.intentos < MAX_INTENTOS) {
      await ref.update({ estado: 'pendiente', programado: ts(t0 + esperaDe(e.intentos)), disp: res, error: 'Fallo pasajero del servicio de notificaciones; se reintenta' });
      return 'reintento';
    }
    const estado = ok === vals.length ? 'enviado' : ok ? 'parcial' : 'fallido';
    const malClaves = vals.some((x) => x.detalle === DETALLE_CLAVES);
    if (malClaves) log.error('Las claves VAPID no son pareja: no se envía nada hasta corregirlas (npm run llaves -- <proyecto> --nuevas y publicar otra vez)');
    const motivo = ok ? '' : malClaves ? DETALLE_CLAVES : vals.every((x) => x.estado === 'expirada') ? 'La suscripción ya no vale: hay que volver a activar las notificaciones en ese dispositivo' : 'El servicio de notificaciones no la aceptó';
    await bandeja.update({ push: { estado: ok ? 'aceptada' : 'fallida', n: ok, t: ts(t0), motivo } }).catch(() => {});
    if (e.avisoId) await db.doc('avisos_club/' + e.avisoId).update({ ['push.' + (ok ? 'aceptadas' : 'fallidas')]: FV.increment(1) }).catch(() => {});
    return terminar(ref, estado, ok ? { disp: res, error: FV.delete() } : { disp: res, error: motivo }, t0);
  }

  async function procesarAuto(ref, e, t0) {
    const uid = e.uid, bandeja = db.doc(`alumnos/${uid}/avisos/${e.bandeja}`);
    const omitir = () => terminar(ref, 'omitido', { motivo: 'La app del alumno ya lo mostró en su centro de notificaciones' }, t0);
    // Mucho después de su hora ya no sirve como notificación (dentro de la app sí aparece, la pone la propia app).
    if (tardeAuto && t0 - ms(e.programado) > tardeAuto) return terminar(ref, 'cancelado', { motivo: 'Se pasó la hora: el servidor no pudo revisarlo a tiempo (dentro de la app sí aparece)' }, t0);
    const ya = await bandeja.get();
    // Un reintento de este mismo envío (ya dejó el aviso en la bandeja): solo falta entregarlo.
    if (ya.exists && ya.get('envioId') === ref.id) return entregar(ref, e, uid, Object.assign({ id: e.bandeja }, ya.data()), { ttl: 4 * 3600, urgencia: 'normal' }, bandeja, t0);
    if (ya.exists) return omitir();
    const p = await prefsDe(uid), cl = await club();
    const est = await estadoDe(uid, cl), ctx = await contextoDelDia(uid, p, t0);
    const oc = Object.assign({}, e.oc || {}, { ms: ms(e.programado) });
    const dec = M.decidir(oc, est, p, { ahora: t0, canal: 'push', hoyEnviados: ctx.enviados, temas: ctx.temas, evidenciasActivas: cl.evidencias });
    if (dec.accion === 'cancelar') return terminar(ref, 'cancelado', { motivo: dec.motivo }, t0);
    if (dec.accion === 'aplazar') { await ref.update({ estado: 'pendiente', programado: ts(dec.ms), motivo: dec.motivo }); return 'aplazado'; }
    const m = dec.msj;
    const item = nuevoItem({ origen: 'auto', cat: m.cat, estilo: m.estilo, titulo: m.titulo, texto: m.texto, ruta: m.ruta, tema: m.tema }, t0, ref.id);
    try { await bandeja.create(item); } catch (err) { if (yaExiste(err)) return omitir(); throw err; }
    return entregar(ref, e, uid, Object.assign({ id: e.bandeja }, item), { ttl: 4 * 3600, urgencia: m.prioridad === 'alta' ? 'high' : 'normal' }, bandeja, t0);
  }

  async function procesarClub(ref, e, t0) {
    const uid = e.uid;
    const [av, copia] = await Promise.all([db.doc('avisos_club/' + e.avisoId).get(), db.doc(`alumnos/${uid}/avisos/${e.bandeja}`).get()]);
    if (!av.exists || av.get('estado') === 'cancelado' || !copia.exists || copia.get('cancelado') === true) return terminar(ref, 'cancelado', { motivo: 'El equipo canceló el aviso (o ya no está en su bandeja)' }, t0);
    const c = copia.data();
    const omitir = async (motivo) => {
      await copia.ref.update({ push: { estado: 'omitida', n: 0, t: ts(t0), motivo } });
      await av.ref.update({ 'push.omitidas': FV.increment(1) }).catch(() => {});
      return terminar(ref, 'omitido', { motivo }, t0);
    };
    if (t0 - ms(av.get('cuando')) > TARDE_CLUB) return omitir('Llegó con más de un día de retraso: solo se ve dentro de la app');
    const p = await prefsDe(uid);
    const dec = M.decidirClub({ tipo: c.tipo, cancelado: !!c.cancelado, expira: ms(c.expira) || 0 }, p, t0);
    if (dec.accion === 'cancelar') return omitir(dec.motivo);
    if (dec.accion === 'aplazar') { await ref.update({ estado: 'pendiente', programado: ts(dec.ms), motivo: dec.motivo }); return 'aplazado'; }
    await copia.ref.update({ envioId: ref.id });
    const exp = ms(c.expira);
    const item = { id: e.bandeja, titulo: c.titulo, texto: c.texto, ruta: c.ruta || '#/avisos', cat: 'club', estilo: 'club' };
    return entregar(ref, e, uid, item, { ttl: exp ? Math.max(60, Math.round((exp - t0) / 1000)) : 24 * 3600, urgencia: c.tipo === 'urgente' || c.tipo === 'importante' ? 'high' : 'normal' }, copia.ref, t0);
  }

  async function procesarPrueba(ref, e, t0) {
    const uid = e.uid, bandeja = db.doc(`alumnos/${uid}/avisos/${e.bandeja}`);
    const item = nuevoItem({ origen: 'prueba', cat: 'prueba', estilo: 'prueba', titulo: 'Notificación de prueba', texto: 'Si ves esto, las notificaciones funcionan en este dispositivo.', ruta: '#/avisos/ajustes', tema: 'prueba' }, t0, ref.id);
    try { await bandeja.create(item); } catch (err) { if (!yaExiste(err)) throw err; }
    return entregar(ref, e, uid, Object.assign({ id: e.bandeja }, item), { ttl: 600, urgencia: 'high' }, bandeja, t0, e.dispId || null);
  }

  async function procesarEvento(ref, e, t0) {
    const uid = e.uid, bandeja = db.doc(`alumnos/${uid}/avisos/${e.bandeja}`);
    const ya = await bandeja.get();
    if (ya.exists && ya.get('envioId') === ref.id) return entregar(ref, e, uid, Object.assign({ id: e.bandeja }, ya.data()), { ttl: 24 * 3600, urgencia: 'normal' }, bandeja, t0);
    if (ya.exists) return terminar(ref, 'omitido', { motivo: 'La app del alumno ya lo mostró en su centro de notificaciones' }, t0);
    const p = await prefsDe(uid);
    if (!p.cats.evidencias) return terminar(ref, 'cancelado', { motivo: 'El alumno apagó los avisos de evidencias' }, t0);
    if (M.enSilencio(t0, p)) { await ref.update({ estado: 'pendiente', programado: ts(M.finSilencio(t0, p)), motivo: 'Hora de silencio' }); return 'aplazado'; }
    // ¿Sigue igual? (el alumno pudo enviar otra versión, o el equipo cambiar la revisión)
    const [ev, rv] = await Promise.all([db.doc(`alumnos/${uid}/evidencias/${e.dia}`).get(), db.doc(`alumnos/${uid}/revisiones/${e.dia}`).get()]);
    if (!ev.exists || !rv.exists || Number(rv.get('v')) !== Number(ev.get('v')) || ['repetir', 'no'].indexOf(rv.get('estado')) < 0) return terminar(ref, 'cancelado', { motivo: 'La evidencia o su revisión cambiaron' }, t0);
    const it = e.item || {};
    const item = nuevoItem({ origen: 'auto', cat: 'evidencias', estilo: 'evidencia', titulo: texto(it.titulo, 80), texto: texto(it.texto, 500), ruta: texto(it.ruta, 120), tema: texto(it.tema, 80) }, t0, ref.id);
    try { await bandeja.create(item); } catch (err) { if (yaExiste(err)) return terminar(ref, 'omitido', { motivo: 'La app del alumno ya lo mostró en su centro de notificaciones' }, t0); throw err; }
    return entregar(ref, e, uid, Object.assign({ id: e.bandeja }, item), { ttl: 24 * 3600, urgencia: 'normal' }, bandeja, t0);
  }

  /** Lo que se quedó «procesando» (la función se cortó a medias): vuelve a la cola o, tras varios intentos, falla. */
  async function recuperarAtascados(t0) {
    const q = simples ? await db.collection('envios').where('estado', '==', 'procesando').limit(200).get()
      : await db.collection('envios').where('estado', '==', 'procesando').where('procesado', '<=', ts(t0 - ATASCO)).limit(50).get();
    const docs = q.docs.filter((d) => ms(d.get('procesado')) <= t0 - ATASCO).slice(0, 50);
    for (const d of docs) {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(d.ref);
        if (!s.exists || s.get('estado') !== 'procesando' || ms(s.get('procesado')) > t0 - ATASCO) return;
        const n = Number(s.get('intentos')) || 1;
        tx.update(d.ref, n < MAX_INTENTOS ? { estado: 'pendiente', programado: ts(t0), error: 'Se quedó a medias; se reintenta' } : { estado: 'fallido', terminado: ts(t0), error: 'Se quedó a medias varias veces' });
      });
    }
    return docs.length;
  }

  /** Los avisos del Club que ya llegaron a su hora: uno por destinatario en la cola de envíos. */
  async function repartirAvisosClub(t0) {
    const q = simples ? await db.collection('avisos_club').where('estado', '==', 'programado').get()
      : await db.collection('avisos_club').where('estado', '==', 'programado').where('cuando', '<=', ts(t0)).limit(20).get();
    let n = 0;
    for (const d of q.docs.filter((x) => ms(x.get('cuando')) <= t0).slice(0, 20)) {
      const a = await db.runTransaction(async (tx) => {
        const s = await tx.get(d.ref);
        if (!s.exists || s.get('estado') !== 'programado' || ms(s.get('cuando')) > t0) return null;
        const uids = Array.isArray(s.get('uids')) ? s.get('uids') : [];
        tx.update(d.ref, { estado: 'enviado', push: { estado: 'enviando', t: ts(t0), n: uids.length, aceptadas: 0, fallidas: 0, omitidas: 0 } });
        return s.data();
      });
      if (!a) continue;
      const uids = (Array.isArray(a.uids) ? a.uids : []).filter((u) => typeof u === 'string' && UID.test(u)).slice(0, 300);
      for (const uid of uids) {
        try {
          await db.doc(`envios/c-${d.id}-${uid}`).create({ uid, alias: '', origen: 'club', cat: 'club', avisoId: d.id, tipoAviso: texto(a.tipo, 20), titulo: texto(a.titulo, 80),
            programado: a.cuando, creado: ts(t0), estado: 'pendiente', intentos: 0, bandeja: 'club-' + d.id });
        } catch (err) { if (!yaExiste(err)) throw err; }
      }
      n++;
    }
    return n;
  }

  /** La señal de vida que lee la app (config/push): la clave pública, cuándo latió, cada cuánto revisa y quién es. */
  async function latido(t0) {
    await db.doc('config/push').set({ vapid: publica, activo: true, latido: ts(t0), version: version || '', region: region || '', minutos: dep.minutos || 1, servidor: dep.servidor || 'functions' }, { merge: true });
  }

  /** Cada minuto (en GitHub Actions, en cada vuelta). */
  async function despachar() {
    const t0 = ahoraMs();
    const r = { procesados: 0, enviados: 0, atascados: 0, club: 0 };
    r.atascados = await recuperarAtascados(t0);
    r.club = await repartirAvisosClub(t0);
    let lista;
    if (simples) {
      // Sin índice compuesto: todo lo pendiente (con la ventana corta son pocos) y aquí se elige lo que ya tocaba.
      const q = await db.collection('envios').where('estado', '==', 'pendiente').get();
      lista = q.docs.filter((d) => ms(d.get('programado')) <= t0).sort((a, b) => ms(a.get('programado')) - ms(b.get('programado'))).slice(0, POR_VUELTA);
    } else {
      const q = await db.collection('envios').where('estado', '==', 'pendiente').where('programado', '<=', ts(t0)).orderBy('programado').limit(POR_VUELTA).get();
      lista = q.docs.slice();
    }
    // De cinco en cinco: rápido, sin saturar a nadie.
    await Promise.all(Array.from({ length: Math.min(5, lista.length) }, async () => {
      while (lista.length) {
        const d = lista.shift();
        const x = await procesar(d.ref, t0);
        if (x !== 'saltado') r.procesados++;
        if (x === 'enviado' || x === 'parcial') r.enviados++;
      }
    }));
    if (dep.siempreLatido || new Date(t0).getUTCMinutes() % 5 === 0) await latido(t0);
    return r;
  }

  /* ---------- Sucesos ---------- */
  /** Una revisión de evidencia «repetir» o «no aprobada»: el alumno se entera enseguida. */
  async function alRevisar(uid, dia, antes, despues) {
    if (!UID.test(String(uid)) || !/^\d{1,2}$/.test(String(dia))) return null;
    if (!despues || ['repetir', 'no'].indexOf(despues.estado) < 0) return null;
    if (antes && antes.estado === despues.estado && Number(antes.v) === Number(despues.v)) return null;
    const v = Number(despues.v) || 1, t0 = ahoraMs(), id = `e-${uid}-rev${dia}v${v}${despues.estado}`;
    const rep = despues.estado === 'repetir', com = texto(despues.comentario, 160);
    const item = { titulo: rep ? 'Tu instructor pidió repetir una evidencia' : 'Tu evidencia no fue aprobada', ruta: '#/gemas/' + dia, tema: 'evid-rep-' + dia + '-v' + v,
      texto: 'Gema Bíblica del Día ' + dia + (com ? ': «' + com + '»' : rep ? '. Revisa el comentario y graba de nuevo tu evidencia.' : '.') };
    try {
      await db.doc('envios/' + id).create({ uid, alias: await aliasDe(uid), origen: 'evento', cat: 'evidencias', dia: String(dia), programado: ts(t0), creado: ts(t0), estado: 'pendiente', intentos: 0, bandeja: 'rev-' + dia + '-v' + v, item });
    } catch (err) { if (yaExiste(err)) return null; throw err; }
    return procesar(db.doc('envios/' + id), t0);
  }
  /** Una notificación de prueba pedida desde la app (las reglas dejan una cada 30 segundos). */
  async function alProbar(uid, d) {
    if (!UID.test(String(uid)) || !d || !/^[a-z0-9]{6,40}$/.test(String(d.req || ''))) return null;
    const t0 = ahoraMs(), id = `p-${uid}-${d.req}`;
    try {
      await db.doc('envios/' + id).create({ uid, alias: await aliasDe(uid), origen: 'prueba', cat: 'prueba', dispId: texto(d.disp, 40), programado: ts(t0), creado: ts(t0), estado: 'pendiente', intentos: 0, bandeja: 'prueba-' + d.req });
    } catch (err) { if (yaExiste(err)) return null; throw err; }
    return procesar(db.doc('envios/' + id), t0);
  }
  /** Al borrar un perfil: lo que quedó de esa cuenta (bandeja, preferencias, dispositivos y su registro de envíos). */
  async function alBorrarAlumno(uid) {
    if (!UID.test(String(uid))) return 0;
    let n = 0;
    for (const sub of ['avisos', 'notif', 'dispositivos']) {
      const q = await db.collection(`alumnos/${uid}/${sub}`).get();
      for (const d of q.docs) { await d.ref.delete(); n++; }
    }
    const q = await db.collection('envios').where('uid', '==', uid).get();
    for (const d of q.docs) { await d.ref.delete(); n++; }
    return n;
  }
  /** Una vez al día: borra los envíos de hace más de 30 días y lo de las bandejas de hace más de 60. */
  async function limpiar() {
    const t0 = ahoraMs();
    let n = 0;
    const q = await db.collection('envios').where('programado', '<', ts(t0 - ANTIGUO_ENVIOS)).limit(400).get();
    for (const d of q.docs) { await d.ref.delete(); n++; }
    const al = await db.collection('alumnos').select().get();
    for (const a of al.docs) {
      const b = await db.collection(`alumnos/${a.id}/avisos`).where('creado', '<', ts(t0 - ANTIGUO_BANDEJA)).limit(200).get();
      for (const d of b.docs) { await d.ref.delete(); n++; }
    }
    return n;
  }

  return { planificar, planificarTodos, despachar, procesar, alRevisar, alProbar, alBorrarAlumno, limpiar, latido, MAX_INTENTOS, ATASCO, VENTANA: ventana };
}

module.exports = { crearNucleo };
