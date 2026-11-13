# 4Running

PWA móvil para empezar a correr con una próxima sesión concreta y una explicación de cómo cambia el plan después de cada intento.

## Ejecutar en local

Requiere Node 22.16+ (probado con Node 24) y npm.

```bash
npm ci --cache /tmp/4running-npm-cache
npm run db:migrate
npm start
```

Abrí `http://localhost:4174`. El servidor sirve el frontend HTML/CSS/JavaScript y la API en el mismo origen. Creá una cuenta con correo y contraseña de al menos 12 caracteres. Los datos se guardan en `work/data/4running.sqlite`, fuera de los archivos públicos y de Git. El secreto local se genera una vez en ese directorio; conservá el directorio al reiniciar.

Para probar recuperación sin enviar correos:

```bash
TEST_MAIL=1 npm start
```

Los enlaces se escriben en `work/data/mail-outbox.jsonl` (solo desarrollo; no se publican ni aparecen en respuestas de la API). Sin esta opción ni proveedor de correo, la interfaz explica que el envío no está configurado.

## Arquitectura

- `server.mjs`: Better Auth, SQLite, cookies de sesión, API autenticada, transacciones y archivos públicos permitidos explícitamente.
- `cloud.js`: arranque de cuenta, caché por identidad, importación confirmada, diario durable de operaciones en IndexedDB, reintentos y conflictos entre dispositivos.
- `workout-runtime.js`: reloj y registro de tramos, máximo continuo, distancia estimada por segmento y snapshots de recuperación.
- `adaptive-engine.js`: onboarding, prescripciones, una decisión de entrenamiento, límites de carga y calendario.
- `coach-engine.js`: coordinación de plan/intentos, historial local sincronizable, recuperación y reprogramación.
- `app.js`, `index.html`, `styles.css`: interfaz y cronómetro compartido para evaluación y entrenamiento.
- `sw.js`: caché del shell; excluye `/api/`.

El historial local sigue usando las claves `pace01.*` para poder importar los datos anteriores. No son una identidad de acceso: el servidor obtiene el propietario desde la cookie verificada, nunca del JSON enviado.

## Verificar

```bash
npm test
npm run test:browser
node tests/save-session-smoke.mjs
node tests/runtime-browser-regressions.mjs
node tests/sync-regressions.mjs
```

Las pruebas crean bases temporales y cuentas ficticias. Chromium debe estar instalado (`CHROMIUM_PATH` permite elegir su ejecutable; por defecto `/usr/bin/chromium`). Playwright se instala con las dependencias de desarrollo.

`npm test` cubre las suites previas, reglas actuales, simulación de 14 días y cuentas. El recorrido móvil cubre tres perfiles, evaluación, entrenamiento completo/incompleto, cinta/exterior, pausa, catch-up, recuperación de contraseña, otro navegador, importación repetida, edición del onboarding, reprogramación, guardado sin conexión y conflicto entre dispositivos. Las capturas y registros de pruebas se generan en `work/`.

## Alojamiento y pendientes externos

No se desplegó ni se migró producción. La versión de trabajo incorpora un servidor: **el alojamiento estático anterior por sí solo ya no alcanza para cuentas**.

`vercel.json` deshabilita los despliegues automáticos desde Git mientras se prepara esa infraestructura. Fusionar una solicitud de cambios no publica esta versión. GitHub Actions ejecuta la verificación; no despliega ni migra una base de producción. Para habilitar publicación deberá revisarse esa configuración junto con el backend y la persistencia elegidos.

El adaptador SQLite actual funciona en un proceso Node con disco persistente. **No usar este archivo SQLite en el filesystem efímero de Vercel Functions**. Para conservar Vercel hay que conectar una base remota, adaptar el acceso SQL de estado y ejecutar la migración de Better Auth únicamente en el entorno autorizado. Otra opción es alojar el servidor Node en un servicio con volumen persistente.

Para un despliegue Node persistente se requieren `NODE_ENV=production`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` HTTPS, `DATA_DIR`, `RESEND_API_KEY` y `MAIL_FROM` con dominio verificado. `TEST_MAIL` no se permite en producción. Hace falta configurar TLS, respaldos y dirección de cliente del proxy de alojamiento: este servidor confía en el socket y sobrescribe encabezados entrantes de IP para evitar suplantaciones. La configuración de producción y la entrega real de correo no fueron verificadas.

No hay GPS: distancia y ritmos por bloques se muestran como estimaciones hasta confirmar la distancia total. Un reparto estimado no habilita sugerencias de velocidad de carrera. El cronómetro registra tiempo en fase de carrera, no detecta por sensores si la persona efectivamente corre.

El cronómetro conserva un respaldo por cuenta en el mismo navegador y ofrece retomar o guardar tras recargar. El arranque sin conexión requiere una identidad verificada previamente y caché local; un primer acceso necesita red.

Al bloquear la pantalla, el sistema operativo puede suspender la PWA. No se prometen avisos en segundo plano; al volver se recalcula el bloque correcto. Falta validación física en iOS/Android y audio real.

Ver `FIXES.md` para las correcciones posteriores y sus regresiones. Ver `AUDIT.md` para la comparación antes/después, evidencia, reproducción y límites de la validación.
