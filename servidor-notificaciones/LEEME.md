# Servidor de notificaciones del club (GitHub Actions)

Este programa envía las **notificaciones push** de Ruta de Amigo: los recordatorios automáticos de cada alumno, los
avisos del Club, las notificaciones de prueba y los avisos de evidencias devueltas. GitHub lo ejecuta cada 10 minutos
con el flujo `.github/workflows/notificaciones.yml` (pestaña **Actions** del repositorio). No es parte de la página
de la app: la app funciona igual sin él (los recordatorios aparecen dentro de la app), pero sin él no llegan con la
app cerrada.

## Qué hay aquí

| Archivo | Qué hace |
| --- | --- |
| `correr.js` | Arranca una vuelta: lee el secreto, se conecta a Firebase y escribe un resumen (solo cifras) |
| `lib/vuelta.js` | Lo que hace cada vuelta: atender lo que pidió la app, planificar, enviar y latir |
| `lib/nucleo.js`, `lib/envio.js`, `lib/avisos-motor.js` | Lo mismo que usa el servidor de Cloud Functions y la app (copias exactas: no se editan aquí) |
| `package.json`, `package-lock.json` | Las dos dependencias: `firebase-admin` (Firestore) y `web-push` (el estándar de notificaciones de los navegadores) |

## Seguridad

- La única clave que usa es el secreto **`FIREBASE_CUENTA`** del repositorio (Settings → Secrets and variables →
  Actions). **Nunca** pongas ese archivo `.json` en el repositorio: da acceso completo al proyecto de Firebase.
- Las claves de las notificaciones (VAPID) las crea la primera vuelta y quedan en Firestore, en `config/servidor`,
  que nadie puede leer desde la app (lo impiden las reglas). La clave pública se anuncia en `config/push`.
- Los registros de GitHub Actions de un repositorio público los puede ver cualquiera. Por eso aquí solo se escriben
  cifras y avisos sin datos de nadie: ningún nombre, identificador, dirección de dispositivo ni clave.
- Solo envía a los servicios de notificaciones de Google, Apple, Mozilla y Microsoft; cualquier otra dirección se
  rechaza.

La guía completa (cómo se instala, límites y qué hacer si algo falla) está en `github/LEEME.md` del proyecto.
