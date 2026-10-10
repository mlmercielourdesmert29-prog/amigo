/* Envío de una notificación con Web Push (el estándar de los navegadores): el contenido va cifrado de punta a punta
   para ese dispositivo y firmado con la clave VAPID del club. En Android y Chrome lo entrega Firebase Cloud Messaging
   (la dirección es de fcm.googleapis.com); en iPhone, el servicio de Apple; en Firefox, el de Mozilla; en Edge, el de
   Windows. El servidor del club no habla con nadie más: una dirección de otro sitio se rechaza (así nadie puede usar
   este servidor para hacer peticiones a donde quiera). */
'use strict';
const crypto = require('node:crypto');

// Servicios de notificaciones de los navegadores. Solo a estas direcciones se envía.
const SERVICIOS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

function servicioConocido(endpoint, lista) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && (lista || SERVICIOS).some((r) => r.test(u.hostname));
  } catch (err) { return false; }
}

/** ¿La clave privada es la pareja de la pública? Si no, los servicios rechazarían todas las firmas. */
function clavesDelMismoPar(publica, privada) {
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(String(privada || ''), 'base64url'));
    return ecdh.getPublicKey('base64url') === String(publica || '').replace(/=+$/, '');
  } catch (err) { return false; }
}
const DETALLE_CLAVES = 'Las claves del servidor de notificaciones no son pareja (la pública de .env y la privada de Secret Manager): avisa a quien administra la app';

/** Un «tema» para el servicio de notificaciones: si llegan dos con el mismo tema sin entregar, solo queda el último. */
function temaDe(id) { return crypto.createHash('sha256').update(String(id)).digest('base64url').slice(0, 32); }

/**
 * opc: { webpush, publica, privada, contacto, servicios (para las pruebas), agente (para las pruebas) }.
 * enviar(suscripcion, texto, { ttl, urgencia, id }) devuelve
 *   { estado: 'aceptada', codigo }          el servicio la aceptó (eso no garantiza que el teléfono ya la mostrara)
 *   { estado: 'expirada', codigo, detalle }  la suscripción ya no vale (se marca el dispositivo)
 *   { estado: 'reintentar', codigo, detalle } fallo pasajero (sin red, servicio saturado): se vuelve a intentar
 *   { estado: 'fallida', codigo, detalle }   rechazo definitivo
 */
function crearEnviador(opc) {
  const { webpush, publica, privada, contacto } = opc;
  // Con las claves mal puestas no se envía nada (y no se marca ningún dispositivo como caducado: la culpa no es suya).
  const clavesBien = clavesDelMismoPar(publica, privada);
  return {
    clavesBien,
    async enviar(sub, texto, o) {
      o = o || {};
      if (!clavesBien) return { estado: 'fallida', codigo: 0, detalle: DETALLE_CLAVES };
      if (!sub || !servicioConocido(sub.endpoint, opc.servicios)) return { estado: 'expirada', codigo: 0, detalle: 'Servicio de notificaciones no reconocido' };
      if (!sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { estado: 'expirada', codigo: 0, detalle: 'Suscripción incompleta' };
      const opciones = {
        vapidDetails: { subject: contacto, publicKey: publica, privateKey: privada },
        TTL: Math.max(0, Math.min(2419200, Math.round(o.ttl || 14400))),
        urgency: o.urgencia === 'high' ? 'high' : 'normal',
        topic: temaDe(o.id || ''),
        timeout: 15000
      };
      if (opc.agente) opciones.agent = opc.agente;
      try {
        const r = await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, texto, opciones);
        return { estado: 'aceptada', codigo: (r && r.statusCode) || 201 };
      } catch (err) {
        const c = err && err.statusCode;
        const detalle = String((err && (err.body || err.message)) || err).replace(/\s+/g, ' ').slice(0, 200);
        if (c === 404 || c === 410) return { estado: 'expirada', codigo: c, detalle: 'La suscripción ya no existe' };
        if (c === 401 || c === 403) return { estado: 'expirada', codigo: c, detalle: 'La suscripción se hizo con otra clave del servidor' };
        if (!c || c === 408 || c === 429 || c >= 500) return { estado: 'reintentar', codigo: c || 0, detalle };
        return { estado: 'fallida', codigo: c, detalle };
      }
    }
  };
}

module.exports = { crearEnviador, servicioConocido, temaDe, clavesDelMismoPar, SERVICIOS, DETALLE_CLAVES };
