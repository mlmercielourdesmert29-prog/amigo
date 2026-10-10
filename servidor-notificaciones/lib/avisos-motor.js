/* Motor de recordatorios y avisos. Son funciones puras (sin pantalla y sin red) que usan igual la app, en el
   navegador, y el servidor del club (Cloud Functions, firebase/functions). Así un recordatorio se decide con las
   mismas reglas en los dos lados y lleva la misma clave: la app y el servidor nunca muestran dos veces lo mismo.

   Lo que hay aquí:
     · Fechas y horas en la zona horaria del alumno (America/Santo_Domingo si no eligió otra).
     · Preferencias: horarios, recordatorios únicos, horas de silencio, tope diario, categorías y evaluación.
     · Ocurrencias: cuándo toca cada recordatorio dentro de un intervalo de tiempo.
     · Decisión: si un recordatorio sirve de verdad en ese momento (con el estado de estudio real) y qué dice.
   No inventa la fecha de la evaluación: si el alumno no la puso y el club tampoco, no hay avisos de evaluación.

   construir.py copia este archivo a firebase/functions/lib/. Edita SOLO este (src/js/avisos-motor.js). */
(function (raiz, fabrica) {
  'use strict';
  const M = fabrica();
  if (typeof module === 'object' && module && module.exports) module.exports = M;
  if (raiz && raiz.RA) raiz.RA.avisosMotor = M;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const ZONA = 'America/Santo_Domingo';
  const HORA = /^([01]\d|2[0-3]):[0-5]\d$/, FECHA = /^\d{4}-\d{2}-\d{2}$/, ID = /^[a-z0-9]{1,16}$/;
  /** Categorías que el alumno puede activar o apagar. */
  const CATEGORIAS = ['estudio', 'gemas', 'evidencias', 'jurado', 'tarjetas', 'requisitos', 'tareas', 'evaluacion', 'club', 'logros'];
  /** De qué puede tratar un horario: 'auto' elige lo que más sirva en ese momento. */
  const TEMAS_HORARIO = ['auto', 'estudio', 'gemas', 'evidencias', 'jurado', 'tarjetas', 'requisitos', 'tareas'];
  const NOMBRES = { auto: 'Lo que más me sirva', estudio: 'Estudio y plan del día', gemas: 'Gemas Bíblicas', evidencias: 'Evidencias de las gemas', jurado: 'Modo Jurado',
    tarjetas: 'Flashcards', requisitos: 'Requisitos pendientes', tareas: 'Tareas de graduación', evaluacion: 'Evaluación', club: 'Avisos del Club', logros: 'Logros', prueba: 'Prueba', nota: 'Recordatorio' };
  const TIPOS_CLUB = ['informativo', 'educativo', 'importante', 'urgente'];
  const LIMITES = { horarios: 12, unicos: 20, diasEval: 6, texto: 120 };

  /* ---------- Utilidades ---------- */
  const esObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const dos = (n) => (n < 10 ? '0' : '') + n;
  const txt = (x, max) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
  const ent = (x, min, max, def) => { const n = Math.round(Number(x)); return isFinite(n) && x !== null && x !== '' && typeof x !== 'boolean' ? Math.min(max, Math.max(min, n)) : def === undefined ? min : def; };
  // Una fecha que existe de verdad (no «2026-13-45»).
  const fecha = (x) => (typeof x === 'string' && FECHA.test(x) && fechaUTC(utcDe(x)) === x ? x : '');
  const hora = (x, def) => (typeof x === 'string' && HORA.test(x) ? x : def);
  /** Un número a partir de un texto, siempre el mismo para el mismo texto (para variar los mensajes sin azar). */
  function semilla(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
  const variante = (lista, clave) => lista[semilla(clave) % lista.length];
  const compacta = (f) => f.replace(/-/g, '');

  /* ---------- Fechas y zonas horarias ---------- */
  const formatos = {};
  function formato(zona) {
    if (!formatos[zona]) formatos[zona] = new Intl.DateTimeFormat('en-US', { timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return formatos[zona];
  }
  /** ¿Es una zona horaria que este dispositivo (o el servidor) conoce? */
  function zonaValida(z) {
    if (typeof z !== 'string' || !z || z.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(z)) return false;
    try { formato(z); return true; } catch (err) { return false; }
  }
  function utcDe(f) { const a = String(f).split('-'); return Date.UTC(Number(a[0]), Number(a[1]) - 1, Number(a[2])); }
  function fechaUTC(ms) { const d = new Date(ms); return d.getUTCFullYear() + '-' + dos(d.getUTCMonth() + 1) + '-' + dos(d.getUTCDate()); }
  const sumarDias = (f, n) => fechaUTC(utcDe(f) + n * 864e5);
  const diasEntre = (a, b) => Math.round((utcDe(b) - utcDe(a)) / 864e5);
  /** Día de la semana de una fecha: 1 lunes … 7 domingo. */
  function diaSemana(f) { const g = new Date(utcDe(f)).getUTCDay(); return g === 0 ? 7 : g; }
  /** Fecha, hora y día de la semana de un instante en una zona: { fecha: 'AAAA-MM-DD', hora: 'HH:MM', dow, y, m, d, h, mi }. */
  function partes(ms, zona) {
    const o = {};
    formato(zona).formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
    const y = Number(o.year), m = Number(o.month), d = Number(o.day), h = Number(o.hour) % 24, mi = Number(o.minute);
    const f = y + '-' + dos(m) + '-' + dos(d);
    return { fecha: f, hora: dos(h) + ':' + dos(mi), dow: diaSemana(f), y, m, d, h, mi };
  }
  /** Diferencia entre la hora de pared de una zona y la hora universal en un instante (en milisegundos). */
  function desfase(ms, zona) { const p = partes(ms, zona); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60000) * 60000; }
  /**
   * El instante (milisegundos) en que en una zona es tal fecha a tal hora. Con horario de verano: si esa hora no
   * existe (el reloj salta), se usa la primera que sí existe después; si existe dos veces, la primera.
   */
  function instante(f, h, zona) {
    const a = f.split('-').map(Number), b = h.split(':').map(Number);
    const pared = Date.UTC(a[0], a[1] - 1, a[2], b[0], b[1]);
    const c1 = pared - desfase(pared - 12 * 36e5, zona), c2 = pared - desfase(pared + 12 * 36e5, zona);
    const bien = (c) => { const p = partes(c, zona); return p.fecha === f && p.hora === h; };
    const b1 = bien(c1), b2 = bien(c2);
    if (b1 && b2) return Math.min(c1, c2);
    if (b1) return c1;
    if (b2) return c2;
    return Math.max(c1, c2);
  }
  const fechaEn = (ms, zona) => partes(ms, zona).fecha;
  /** Medianoche (en esa zona) del día del instante. */
  const inicioDelDia = (ms, zona) => instante(fechaEn(ms, zona), '00:00', zona);

  /* ---------- Preferencias ---------- */
  function prefsBase() {
    const cats = {};
    CATEGORIAS.forEach((c) => { cats[c] = true; });
    return {
      v: 1,
      activo: true,                 // recordatorios automáticos (dentro de la app y, si están activadas, notificaciones)
      zona: ZONA,
      cats,
      horarios: [{ id: 'h1', dias: [1, 2, 3, 4, 5, 6, 7], hora: '17:00', cat: 'auto', activo: true, desde: '', hasta: '', siHecho: true }],
      unicos: [],                   // { id, fecha, hora, texto, cat, siHecho, activo }
      silencio: { activo: true, desde: '21:30', hasta: '07:00' },
      maxDia: 3,                    // recordatorios automáticos como máximo al día
      evaluacion: { activo: true, dias: [7, 3, 1, 0], hora: '18:00' },
      urgentes: 'esperar',          // un aviso URGENTE del club en horas de silencio: 'esperar' a que terminen o 'sonar' igual
      t: ''                         // última vez que se cambiaron (para unir lo de varios dispositivos)
    };
  }
  function dias(x) {
    const out = [];
    (Array.isArray(x) ? x : []).forEach((d) => { d = Math.round(Number(d)); if (d >= 1 && d <= 7 && out.indexOf(d) < 0) out.push(d); });
    return out.sort((a, b) => a - b);
  }
  /** Las preferencias tal como llegan (de la pantalla, de otro dispositivo o de la red), revisadas campo por campo. */
  function normalizarPrefs(x) {
    const p = prefsBase();
    if (!esObj(x)) return p;
    if (typeof x.activo === 'boolean') p.activo = x.activo;
    if (zonaValida(x.zona)) p.zona = x.zona;
    if (esObj(x.cats)) CATEGORIAS.forEach((c) => { if (typeof x.cats[c] === 'boolean') p.cats[c] = x.cats[c]; });
    if (Array.isArray(x.horarios)) {
      const vistos = {};
      p.horarios = x.horarios.filter(esObj).map((h) => ({
        id: typeof h.id === 'string' && ID.test(h.id) ? h.id : '', dias: dias(h.dias), hora: hora(h.hora, '17:00'),
        cat: TEMAS_HORARIO.indexOf(h.cat) > -1 ? h.cat : 'auto', activo: h.activo !== false, desde: fecha(h.desde), hasta: fecha(h.hasta), siHecho: h.siHecho !== false
      })).filter((h) => { if (!h.id || vistos[h.id]) return false; vistos[h.id] = 1; return true; }).slice(0, LIMITES.horarios);
    }
    if (Array.isArray(x.unicos)) {
      const vistos = {};
      p.unicos = x.unicos.filter(esObj).map((u) => ({
        id: typeof u.id === 'string' && ID.test(u.id) ? u.id : '', fecha: fecha(u.fecha), hora: hora(u.hora, ''), texto: txt(u.texto, LIMITES.texto),
        cat: TEMAS_HORARIO.indexOf(u.cat) > -1 ? u.cat : 'nota', siHecho: u.siHecho === true, activo: u.activo !== false
      })).filter((u) => { if (!u.id || !u.fecha || !u.hora || vistos[u.id]) return false; vistos[u.id] = 1; return true; })
        .sort((a, b) => (a.fecha + a.hora < b.fecha + b.hora ? -1 : 1)).slice(-LIMITES.unicos);
    }
    if (esObj(x.silencio)) {
      if (typeof x.silencio.activo === 'boolean') p.silencio.activo = x.silencio.activo;
      p.silencio.desde = hora(x.silencio.desde, p.silencio.desde);
      p.silencio.hasta = hora(x.silencio.hasta, p.silencio.hasta);
    }
    p.maxDia = ent(x.maxDia, 1, 8, p.maxDia);
    if (esObj(x.evaluacion)) {
      if (typeof x.evaluacion.activo === 'boolean') p.evaluacion.activo = x.evaluacion.activo;
      if (Array.isArray(x.evaluacion.dias)) {
        const ds = [];
        x.evaluacion.dias.forEach((d) => { d = Math.round(Number(d)); if (d >= 0 && d <= 30 && ds.indexOf(d) < 0) ds.push(d); });
        p.evaluacion.dias = ds.sort((a, b) => b - a).slice(0, LIMITES.diasEval);
      }
      p.evaluacion.hora = hora(x.evaluacion.hora, p.evaluacion.hora);
    }
    if (x.urgentes === 'sonar' || x.urgentes === 'esperar') p.urgentes = x.urgentes;
    p.t = txt(x.t, 30);
    return p;
  }
  /** Un identificador corto y nuevo para un horario o un recordatorio único (ninguno de los que ya hay). */
  function nuevoId(prefijo, existentes) {
    const ya = {};
    (existentes || []).forEach((x) => { ya[x.id] = 1; });
    for (let i = 0; i < 50; i++) {
      const id = prefijo + Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '');
      if (ID.test(id) && !ya[id]) return id;
    }
    return prefijo + Date.now().toString(36);
  }

  /* ---------- Horas de silencio ---------- */
  /** ¿Ese instante cae en las horas de silencio del alumno? (Pueden cruzar la medianoche: de 21:30 a 07:00.) */
  function enSilencio(ms, prefs) {
    const s = prefs.silencio;
    if (!s.activo || s.desde === s.hasta) return false;
    const h = partes(ms, prefs.zona).hora;
    return s.desde < s.hasta ? h >= s.desde && h < s.hasta : h >= s.desde || h < s.hasta;
  }
  /** Cuándo terminan las horas de silencio en que cae ese instante (o el mismo instante si no cae en ellas). */
  function finSilencio(ms, prefs) {
    if (!enSilencio(ms, prefs)) return ms;
    const p = partes(ms, prefs.zona), s = prefs.silencio;
    // Si el silencio cruza la medianoche y ya es de noche, termina mañana; si no, hoy.
    const dia = s.desde > s.hasta && p.hora >= s.desde ? sumarDias(p.fecha, 1) : p.fecha;
    return instante(dia, s.hasta, prefs.zona);
  }

  /* ---------- Estado de estudio ---------- */
  // Lo que la app sabe del alumno y le sirve al servidor para decidir: solo cifras, títulos de la app y fechas.
  // Ningún apunte ni texto escrito por el alumno.
  function normalizarEstado(x) {
    x = esObj(x) ? x : {};
    const plan = esObj(x.plan) ? x.plan : {}, pd = {};
    if (esObj(plan.dias)) Object.keys(plan.dias).slice(0, 7).forEach((f) => {
      const y = plan.dias[f];
      if (fecha(f) && esObj(y)) pd[f] = { frase: txt(y.frase, 300), hecha: y.hecha === true, n: ent(y.n, 0, 60), estudiado: ent(y.estudiado, 0, 1440) };
    });
    const g = esObj(x.gemas) ? x.gemas : {}, total = ent(g.total, 0, 14), citas = {};
    if (esObj(g.citas)) Object.keys(g.citas).slice(0, 14).forEach((k) => { if (/^\d{1,2}$/.test(k)) citas[k] = txt(g.citas[k], 60); });
    const numeros = (l, max) => { const o = []; (Array.isArray(l) ? l : []).forEach((n) => { n = Math.round(Number(n)); if (n >= 1 && n <= max && o.indexOf(n) < 0) o.push(n); }); return o.sort((a, b) => a - b); };
    const ev = esObj(x.evid) ? x.evid : {};
    const rq = esObj(x.req) ? x.req : {}, mod = (o) => (esObj(o) && typeof o.mid === 'string' && /^[a-z0-9-]{1,30}$/.test(o.mid) ? { mid: o.mid, nombre: txt(o.nombre, 80), fallos: ent(o.fallos, 0, 999) } : null);
    const ta = esObj(x.tareas) ? x.tareas : {};
    return {
      v: 1, t: txt(x.t, 30), hoy: fecha(x.hoy),
      plan: { dias: pd, min: ent(plan.min, 0, 600) },
      gemas: { inicio: fecha(g.inicio), total, hechas: numeros(g.hechas, total || 14), dominio: ent(g.dominio, 0, 100), citas },
      evid: { activas: ev.activas === true, enviadas: numeros(ev.enviadas, 14), faltan: numeros(ev.faltan, 14),
        repetir: (Array.isArray(ev.repetir) ? ev.repetir : []).filter(esObj).slice(0, 7).map((r) => ({ dia: ent(r.dia, 1, 14), v: ent(r.v, 1, 999), com: txt(r.com, 200) })) },
      tarjetas: { pendientes: ent(esObj(x.tarjetas) ? x.tarjetas.pendientes : 0, 0, 9999) },
      jurado: { fallidas: ent(esObj(x.jurado) ? x.jurado.fallidas : 0, 0, 9999) },
      req: { pendientes: ent(rq.pendientes, 0, 99), sugerido: mod(rq.sugerido), debil: mod(rq.debil) },
      tareas: { pendientes: ent(ta.pendientes, 0, 99), primera: txt(ta.primera, 120) },
      eval: fecha(x.eval)
    };
  }

  /* ---------- Ocurrencias ---------- */
  /**
   * Los recordatorios que tocan entre desde y hasta (milisegundos), en orden. ctx.evaluacion: la fecha REAL de la
   * evaluación ('AAAA-MM-DD') o ''. Cada uno: { clave, tipo: 'horario'|'unico'|'evaluacion', cat, ms, fecha, hora, ref, siHecho, texto, dias }.
   */
  function ocurrencias(prefs, desde, hasta, ctx) {
    ctx = ctx || {};
    const out = [];
    if (!prefs.activo || !(hasta > desde)) return out;
    const z = prefs.zona;
    const f0 = sumarDias(fechaEn(desde, z), -1), f1 = sumarDias(fechaEn(hasta, z), 1);
    for (let f = f0, i = 0; f <= f1 && i < 400; f = sumarDias(f, 1), i++) {
      const dow = diaSemana(f);
      prefs.horarios.forEach((h) => {
        if (!h.activo || h.dias.indexOf(dow) < 0 || (h.desde && f < h.desde) || (h.hasta && f > h.hasta)) return;
        const ms = instante(f, h.hora, z);
        if (ms >= desde && ms < hasta) out.push({ clave: h.id + '-' + compacta(f), tipo: 'horario', cat: h.cat, ms, fecha: f, hora: h.hora, ref: h.id, siHecho: h.siHecho, texto: '', dias: 0 });
      });
    }
    prefs.unicos.forEach((u) => {
      if (!u.activo) return;
      const ms = instante(u.fecha, u.hora, z);
      if (ms >= desde && ms < hasta) out.push({ clave: u.id, tipo: 'unico', cat: u.cat, ms, fecha: u.fecha, hora: u.hora, ref: u.id, siHecho: u.siHecho, texto: u.texto, dias: 0 });
    });
    const ev = fecha(ctx.evaluacion);
    if (ev && prefs.evaluacion.activo && prefs.cats.evaluacion) prefs.evaluacion.dias.forEach((d) => {
      const f = sumarDias(ev, -d), ms = instante(f, prefs.evaluacion.hora, z);
      if (ms >= desde && ms < hasta) out.push({ clave: 'ev' + compacta(ev) + '-' + d, tipo: 'evaluacion', cat: 'evaluacion', ms, fecha: f, hora: prefs.evaluacion.hora, ref: ev, siHecho: false, texto: '', dias: d });
    });
    return out.sort((a, b) => a.ms - b.ms || (a.clave < b.clave ? -1 : 1));
  }

  /* ---------- Qué decir ---------- */
  const RUTAS = { estudio: '#/plan', gemas: '#/gemas', evidencias: '#/gemas', jurado: '#/jurado', tarjetas: '#/flashcards', requisitos: '#/estudiar', tareas: '#/checklist', evaluacion: '#/listo', club: '#/avisos', logros: '#/logros', nota: '#/avisos', prueba: '#/avisos' };
  /** Una dirección de la app que se puede abrir (cualquier otra cosa lleva al centro de notificaciones). */
  function rutaSegura(r) { return typeof r === 'string' && r.length <= 120 && /^#\/[A-Za-z0-9/_.-]*$/.test(r) && r.indexOf('..') < 0 ? r : '#/avisos'; }
  const cuantos = (n, uno, varios) => n + ' ' + (n === 1 ? uno : varios);

  function hechoPlan(est, f) { const d = est.plan.dias[f]; return !!(d && (d.hecha || (est.plan.min && d.estudiado >= est.plan.min))); }
  /** La gema que toca un día (como Gm.hoy de la app): la primera sin completar, si ya le llegó su día en el calendario. */
  function gemaDe(est, f) {
    const g = est.gemas;
    if (!g.total) return null;
    const cal = g.inicio ? Math.max(1, Math.min(g.total, diasEntre(g.inicio, f) + 1)) : 1;
    let falta = 0;
    for (let n = 1; n <= g.total; n++) if (g.hechas.indexOf(n) < 0) { falta = n; break; }
    if (!falta || falta > cal) return null;
    return { n: falta, atrasada: falta < cal, cita: g.citas[String(falta)] || '' };
  }

  function candidatos(est, f, cat, ctx, clave) {
    const lista = [], k = clave + ':';
    const add = (c) => { if (c && (cat === 'auto' || c.cat === cat)) lista.push(c); };
    const faltan = est.eval ? diasEntre(f, est.eval) : -1;
    const cerca = faltan >= 0 && faltan <= 7;
    const gema = gemaDe(est, f);
    const evidActivas = est.evid.activas || ctx.evidenciasActivas === true;
    const repetir = est.evid.repetir[0];
    if (repetir && evidActivas) add({ cat: 'evidencias', estilo: 'evidencia', tema: 'evid-rep-' + repetir.dia + '-v' + repetir.v, titulo: 'Tu instructor pidió repetir una evidencia', prioridad: 'alta', ruta: '#/gemas/' + repetir.dia,
      texto: 'Revisa la Gema del Día ' + repetir.dia + ' y graba de nuevo tu evidencia' + (repetir.com ? ': «' + repetir.com.slice(0, 90) + (repetir.com.length > 90 ? '…' : '') + '»' : '.') });
    if (cerca && faltan <= 3) add({ cat: 'evaluacion', estilo: 'evaluacion', tema: 'eval-cerca-' + f, prioridad: 'alta', ruta: faltan === 0 ? '#/listo' : '#/simulacro',
      titulo: faltan === 0 ? 'Hoy es tu evaluación' : faltan === 1 ? 'Mañana es tu evaluación' : 'Faltan ' + faltan + ' días para tu evaluación',
      texto: faltan === 0 ? 'Repasa con calma lo más importante y confía en lo que estudiaste.' : faltan === 1 ? 'Haz un simulacro y repasa lo que fallaste. ¡Ya casi llegas a la cima!' : variante(['Prioriza los requisitos pendientes y haz un simulacro.', 'Es buen momento para un simulacro y para repasar tus errores.'], k + 'ev') });
    if (gema) add({ cat: 'gemas', estilo: 'gema', tema: 'gema-' + gema.n, prioridad: gema.atrasada ? 'alta' : 'normal', ruta: '#/gemas/' + gema.n,
      titulo: 'Gema Bíblica del día ' + gema.n,
      texto: (gema.atrasada ? 'Tienes pendiente la Gema del Día ' + gema.n + '. ' : '') + variante(['Tu Gema Bíblica de hoy te espera. Dedica unos minutos a memorizarla.', 'Unos minutos con tu Gema Bíblica y quedará guardada en tu memoria.', 'Repite tu Gema Bíblica en voz alta: así se aprende mejor.'], k + 'gema') + (gema.cita ? ' (' + gema.cita + ')' : '') });
    if (evidActivas) {
      const falta = est.evid.faltan.filter((n) => !est.evid.repetir.some((r) => r.dia === n))[0];
      if (falta) add({ cat: 'evidencias', estilo: 'evidencia', tema: 'evid-' + falta, prioridad: 'normal', ruta: '#/gemas/' + falta, titulo: 'Evidencia pendiente',
        texto: 'Recuerda enviar tu evidencia de la Gema Bíblica del Día ' + falta + '.' });
    }
    const debil = est.req.debil && est.req.debil.fallos >= 3 ? est.req.debil : null;
    const conReq = (r, urgente) => r && add({ cat: 'requisitos', estilo: 'requisito', tema: 'req-' + r.mid + '-' + f, prioridad: urgente ? 'alta' : 'normal', ruta: '#/modulo/' + r.mid,
      titulo: urgente ? 'Requisito por reforzar' : 'Requisito pendiente',
      texto: urgente ? 'Has fallado varias preguntas de «' + r.nombre + '». Un repaso corto te ayudará a dominarlo.' : 'Tienes ' + cuantos(est.req.pendientes || 1, 'requisito pendiente', 'requisitos pendientes') + ' de la clase de Amigo. Retoma «' + r.nombre + '» y sigue preparándote.' });
    const conTareas = () => est.tareas.pendientes > 0 && est.eval && add({ cat: 'tareas', estilo: 'tarea', tema: 'tareas-' + f, prioridad: cerca ? 'alta' : 'normal', ruta: '#/checklist',
      titulo: 'Tareas de graduación', texto: 'Antes de la evaluación te ' + (est.tareas.pendientes === 1 ? 'falta 1 tarea' : 'faltan ' + est.tareas.pendientes + ' tareas') + ' de la lista.' + (est.tareas.primera ? ' La primera: ' + est.tareas.primera + '.' : '') });
    if (cerca) { conReq(debil || est.req.sugerido, !!debil); conTareas(); } else if (debil) conReq(debil, true);
    const dia = est.plan.dias[f];
    if (dia && dia.frase && !hechoPlan(est, f)) add({ cat: 'estudio', estilo: 'mision', tema: 'plan-' + f, prioridad: 'normal', ruta: '#/plan', titulo: 'Tu misión de hoy', texto: dia.frase.replace(/^Hoy necesitas /, 'Tu plan de hoy incluye ') });
    if (est.tarjetas.pendientes > 0) add({ cat: 'tarjetas', estilo: 'tarjetas', tema: 'tarjetas-' + f, prioridad: 'normal', ruta: '#/flashcards', titulo: 'Flashcards por repasar',
      texto: 'Tienes ' + cuantos(est.tarjetas.pendientes, 'tarjeta', 'tarjetas') + ' para repasar. ' + variante(['Unos minutos ahora y no se te olvidan.', 'Repasarlas hoy te ayuda a dominarlas.'], k + 'fc') });
    if (est.jurado.fallidas > 0) add({ cat: 'jurado', estilo: 'jurado', tema: 'jurado-' + f, prioridad: 'normal', ruta: '#/jurado', titulo: 'Modo Jurado',
      texto: 'Practica en el Modo Jurado: tienes ' + cuantos(est.jurado.fallidas, 'respuesta', 'respuestas') + ' por reforzar. Respóndelas en voz alta o por escrito.' });
    if (!cerca) { if (!debil) conReq(est.req.sugerido, false); conTareas(); }
    if (!hechoPlan(est, f)) add({ cat: 'estudio', estilo: 'estudio', tema: 'estudio-' + f, prioridad: 'normal', ruta: '#/plan', titulo: 'Hora de estudiar',
      texto: variante(['¡Es hora de continuar tu expedición de aprendizaje!', 'Tu sesión de estudio está programada. Hoy puedes avanzar un poco más.',
        est.plan.min ? 'Tienes ' + est.plan.min + ' minutos para estudiar hoy. Aprovecha para repasar tus flashcards.' : 'Aprovecha unos minutos para repasar tus flashcards.'], k + 'est') });
    if (est.gemas.total && !gema && est.gemas.hechas.length === est.gemas.total && est.gemas.dominio < 90) add({ cat: 'gemas', estilo: 'gema', tema: 'gemas-repaso-' + f, prioridad: 'normal', ruta: '#/gemas/repaso',
      titulo: 'Repaso de tus gemas', texto: 'Ya completaste tus Gemas Bíblicas. Repásalas seguidas para no olvidarlas.' });
    return lista;
  }
  /** ¿Ya está hecho lo que pide un recordatorio de esa categoría? (para «no avisar si ya lo hice»). */
  function hechoCat(est, f, cat) {
    if (cat === 'estudio' || cat === 'auto') return hechoPlan(est, f);
    if (cat === 'gemas') return !gemaDe(est, f);
    if (cat === 'evidencias') return !est.evid.faltan.length && !est.evid.repetir.length;
    if (cat === 'tarjetas') return !est.tarjetas.pendientes;
    if (cat === 'jurado') return !est.jurado.fallidas;
    if (cat === 'requisitos') return !est.req.pendientes;
    if (cat === 'tareas') return !est.tareas.pendientes;
    return false;
  }

  function mensajeEvaluacion(oc, est) {
    const d = oc.dias, cuando = oc.ref;
    const titulo = d === 0 ? 'Hoy es tu evaluación' : d === 1 ? 'Mañana es tu evaluación' : d === 7 ? 'Falta una semana para tu evaluación' : 'Faltan ' + d + ' días para tu evaluación';
    let texto;
    if (d === 0) texto = 'Repasa con calma lo más importante. ¡Tú puedes!';
    else if (d === 1) texto = 'Haz un último simulacro y repasa lo que fallaste.';
    else {
      const p = [];
      if (est.req.pendientes) p.push(cuantos(est.req.pendientes, 'requisito pendiente', 'requisitos pendientes'));
      if (est.tareas.pendientes) p.push(cuantos(est.tareas.pendientes, 'tarea de graduación', 'tareas de graduación'));
      texto = (p.length ? 'Te ' + (p.length > 1 || (est.req.pendientes || est.tareas.pendientes) > 1 ? 'quedan ' : 'queda ') + p.join(' y ') + '. ' : '') + 'Revisa tu preparación y haz un simulacro.';
    }
    return { cat: 'evaluacion', estilo: 'evaluacion', tema: 'eval-' + cuando + '-' + d, prioridad: d <= 1 ? 'alta' : 'normal', ruta: d <= 1 ? '#/simulacro' : '#/listo', titulo, texto };
  }

  /**
   * ¿Sirve este recordatorio ahora y qué dice? oc: una ocurrencia; est: estado de estudio (normalizarEstado);
   * prefs: preferencias (normalizarPrefs); ctx: { ahora, canal: 'push' | 'app', hoyEnviados, temas: [temas ya avisados hoy], evidenciasActivas }.
   * Devuelve { accion: 'enviar', msj } | { accion: 'cancelar', motivo } | { accion: 'aplazar', ms, motivo }.
   */
  function decidir(oc, est, prefs, ctx) {
    ctx = ctx || {};
    const ahora = typeof ctx.ahora === 'number' ? ctx.ahora : oc.ms;
    const temas = ctx.temas || [];
    if (!prefs.activo) return { accion: 'cancelar', motivo: 'Recordatorios automáticos apagados' };
    if (oc.tipo === 'evaluacion') {
      if (!est.eval || compacta(est.eval) !== compacta(oc.ref)) return { accion: 'cancelar', motivo: est.eval ? 'La fecha de la evaluación cambió' : 'No hay fecha de evaluación' };
      if (!prefs.cats.evaluacion || !prefs.evaluacion.activo) return { accion: 'cancelar', motivo: 'Categoría apagada' };
    }
    if (ctx.canal === 'push' && enSilencio(ahora, prefs)) {
      // Lo que el alumno pidió para una hora concreta, y los avisos de evaluación, esperan a que termine el silencio;
      // los recordatorios de rutina de ese momento se omiten (habrá otro en el siguiente horario).
      if (oc.tipo === 'unico' || oc.tipo === 'evaluacion') return { accion: 'aplazar', ms: finSilencio(ahora, prefs), motivo: 'Hora de silencio' };
      return { accion: 'cancelar', motivo: 'Hora de silencio' };
    }
    if (oc.tipo !== 'unico' && (ctx.hoyEnviados || 0) >= prefs.maxDia) return { accion: 'cancelar', motivo: 'Tope diario de recordatorios' };
    if (oc.tipo === 'evaluacion') {
      const m = mensajeEvaluacion(oc, est);
      return temas.indexOf(m.tema) > -1 ? { accion: 'cancelar', motivo: 'Ya avisado hoy' } : { accion: 'enviar', msj: m };
    }
    if (oc.cat !== 'auto' && oc.cat !== 'nota' && !prefs.cats[oc.cat]) return { accion: 'cancelar', motivo: 'Categoría apagada' };
    if (oc.tipo === 'unico' && oc.texto) {
      if (oc.siHecho && oc.cat !== 'nota' && hechoCat(est, oc.fecha, oc.cat)) return { accion: 'cancelar', motivo: 'Ya lo hiciste' };
      const cat = oc.cat === 'nota' || oc.cat === 'auto' ? 'estudio' : oc.cat;
      return { accion: 'enviar', msj: { cat, estilo: 'nota', tema: 'u-' + oc.ref, titulo: 'Recordatorio', texto: oc.texto, ruta: oc.cat === 'nota' ? '#/plan' : RUTAS[cat] || '#/plan', prioridad: 'normal' } };
    }
    const cat = oc.cat === 'nota' ? 'auto' : oc.cat;
    if (oc.siHecho && cat !== 'auto' && hechoCat(est, oc.fecha, cat)) return { accion: 'cancelar', motivo: 'Ya lo hiciste' };
    let lista = candidatos(est, oc.fecha, cat, ctx, oc.clave).filter((c) => prefs.cats[c.cat]);
    // Con la sesión de hoy cumplida, un horario «lo que más me sirva» solo avisa de lo urgente.
    const cumplido = hechoPlan(est, oc.fecha);
    if (cat === 'auto' && oc.siHecho && cumplido) lista = lista.filter((c) => c.prioridad === 'alta');
    if (!lista.length) return { accion: 'cancelar', motivo: cat === 'auto' && cumplido ? 'Ya cumpliste lo de hoy' : 'No hay nada pendiente de eso' };
    const nuevo = lista.filter((c) => temas.indexOf(c.tema) < 0)[0];
    if (!nuevo) return { accion: 'cancelar', motivo: 'Ya avisado hoy' };
    return { accion: 'enviar', msj: nuevo };
  }

  /**
   * Un aviso del club por notificación: { accion: 'enviar' } | { accion: 'aplazar', ms, motivo } | { accion: 'cancelar', motivo }.
   * Política: los importantes y urgentes llegan siempre como notificación; los informativos y educativos, solo si
   * el alumno tiene activada la categoría «Avisos del Club» (si no, solo los ve dentro de la app). En horas de
   * silencio esperan a que terminen, salvo los URGENTES si el alumno eligió que suenen igual.
   */
  function decidirClub(aviso, prefs, ahora) {
    if (aviso.cancelado) return { accion: 'cancelar', motivo: 'El equipo canceló el aviso' };
    if (aviso.expira && ahora >= aviso.expira) return { accion: 'cancelar', motivo: 'El aviso venció' };
    const fuerte = aviso.tipo === 'importante' || aviso.tipo === 'urgente';
    if (!fuerte && !prefs.cats.club) return { accion: 'cancelar', motivo: 'El alumno apagó los avisos informativos del club (lo ve dentro de la app)' };
    if (enSilencio(ahora, prefs) && !(aviso.tipo === 'urgente' && prefs.urgentes === 'sonar')) {
      const fin = finSilencio(ahora, prefs);
      if (aviso.expira && fin >= aviso.expira) return { accion: 'cancelar', motivo: 'Vence antes de que termine la hora de silencio' };
      return { accion: 'aplazar', ms: fin, motivo: 'Hora de silencio' };
    }
    return { accion: 'enviar' };
  }

  /* ---------- Claves y carga ---------- */
  // La misma clave en la app y en el servidor: así nunca hay dos copias del mismo recordatorio.
  const idBandeja = (clave) => 'r-' + clave;
  const idEnvio = (uid, clave) => 'r-' + uid + '-' + clave;
  /** Lo que viaja dentro de una notificación (cifrado de punta a punta por Web Push). Menos de 4 KB. */
  function carga(item) {
    return { id: txt(item.id, 120), titulo: txt(item.titulo, 80) || 'Ruta de Amigo', texto: txt(item.texto, 300), ruta: rutaSegura(item.ruta), cat: txt(item.cat, 20), estilo: txt(item.estilo, 20), t: Number(item.t) || 0, envio: txt(item.envio, 160) };
  }

  /** Texto corto de cuándo toca un horario: «Lunes a viernes · 5:00 p. m.». */
  const NDIAS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  function horaBonita(h) { const a = h.split(':').map(Number); return (a[0] % 12 || 12) + ':' + dos(a[1]) + (a[0] < 12 ? ' a. m.' : ' p. m.'); }
  function diasBonitos(ds) {
    const s = ds.join(',');
    if (s === '1,2,3,4,5,6,7') return 'Todos los días';
    if (s === '1,2,3,4,5') return 'Lunes a viernes';
    if (s === '6,7') return 'Sábados y domingos';
    if (!ds.length) return 'Ningún día';
    const n = ds.map((d) => NDIAS[d]);
    return (n.length > 1 ? n.slice(0, -1).join(', ') + ' y ' + n[n.length - 1] : n[0]).replace(/^./, (c) => c.toUpperCase());
  }

  return {
    ZONA, CATEGORIAS, TEMAS_HORARIO, NOMBRES, TIPOS_CLUB, LIMITES, RUTAS,
    zonaValida, partes, instante, fechaEn, inicioDelDia, sumarDias, diasEntre, diaSemana,
    prefsBase, normalizarPrefs, nuevoId, enSilencio, finSilencio,
    normalizarEstado, ocurrencias, decidir, decidirClub, hechoCat, hechoPlan, gemaDe,
    idBandeja, idEnvio, carga, rutaSegura, horaBonita, diasBonitos, semilla
  };
});
