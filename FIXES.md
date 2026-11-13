# Correcciones de consistencia — 13 de noviembre de 2026

Esta revisión corrige las regresiones encontradas después de la primera auditoría y se prepara para integración por solicitud de cambios. El despliegue y las migraciones de producción permanecen fuera de esta entrega. `vercel.json` deshabilita el autodespliegue desde Git; GitHub Actions verifica la versión sin publicarla.

## Registro y sincronización

- La cola pendiente es un diario de operaciones en IndexedDB separado por cuenta. Cada operación conserva su identificador; una pestaña no reemplaza la cola de otra.
- El servidor combina sesiones por identificador y valida el propietario contra la sesión. Una divergencia del plan conserva los intentos y pide conciliación del plan.
- Los reintentos tras una respuesta perdida se procesan antes de declarar un conflicto al volver a abrir.
- Un conflicto de la cola anterior confirma primero la entrega de sus entrenamientos con un identificador estable. Elegir el plan de la cuenta conserva el conflicto hasta confirmar todos los intentos, incluso si fue archivado por una versión anterior.
- Las preferencias se cargan en memoria después de iniciar la cuenta; las pruebas verifican velocidad, sonido y voz en otro navegador.
- Un cierre sin conexión puede conservar pendientes por cuenta con confirmación explícita. Los datos de otra cuenta no se muestran ni se envían con una identidad distinta.
- El arranque sin conexión puede recuperar la última identidad previamente verificada y su caché local en el mismo navegador; al reconectar se vuelve a validar la sesión antes de enviar datos. Un acceso nuevo necesita conexión.
- La sesión activa del cronómetro queda respaldada por cuenta en el mismo navegador. Cerrar la cuenta no descarta silenciosamente el entrenamiento: primero ofrece revisarlo y guardarlo.

## Cronómetro

`workout-runtime.js` es la fuente del reloj y de las visitas/tramos realizados. Pausar divide el continuo; visitar otra vez un bloque suma el tiempo realizado sin juntar ambos tramos como carrera continua. Las velocidades se registran por segmento, conservando la historia al cambiarlas.

Se conserva la prescripción original por separado del realizado. Cuarenta más treinta segundos producen setenta segundos acumulados y cuarenta segundos de máximo continuo. Cumplir tiempo acumulado con interrupciones puede mantener la prescripción hasta confirmar el tramo continuo.

Los snapshots conservan identificación de intento, prescripción, estado en marcha/pausa/finalizado, entorno y segmentos. Se recuperan tras recargar o cerrar y volver al mismo navegador/cuenta. El reloj se presenta pausado para elegir retomar o guardar. No es transferencia de un cronómetro activo a otro dispositivo.

La confirmación para cambiar de bloque pausa el reloj. Una actualización del service worker se difiere mientras hay un intento abierto. La voz al regresar anuncia el tiempo restante y las velocidades numéricas solo se muestran/anuncian si hay una base confirmada. Las pruebas incluyen el service worker real, no solo el reloj aislado.

## Entrenamiento y producto

- Tendencia y confianza compartidas entre motor e indicadores.
- Deterioro de continuo con esfuerzo seis impide aumentar; una pausa larga se verifica antes de cualquier avance.
- Evidencia validada por rangos, coherencia de tiempos/bloques y tramos observados; las fuentes de cronómetro sin bloques permanecen provisionales.
- Intentos ordenados por fecha y momento/secuencia de creación, sin interpretar UUID como orden temporal.
- Calendario semanal de dos o tres carreras con descanso. Si se solicitan cuatro, la interfaz pide aceptar tres para este plan inicial; no cambia la frecuencia silenciosamente.
- Restauración y recalibración respetan evaluación, presupuesto de minutos, capacidad observada y recuperación.
- Después de una caminata suficiente y cómoda, sin síntomas y pudiendo conversar, Hoy ofrece una evaluación corta de trote. Requiere aceptación y conserva lo realizado.
- Corregir un entrenamiento conserva una auditoría y su decisión original; se revisan únicamente sesiones futuras sin reescribir las prescripciones ya intentadas.
- Un intento de una prescripción anterior se guarda sin avanzar una sesión distinta del plan actual.
- La fecha objetivo puede eliminarse. El esfuerzo cero es coherente entre cierre y corrección.
- Se retiró la carga de demostración de la cuenta normal. Los helpers de demostración se mantienen para entornos de prueba.

## Esquema y ejecución

El arranque ordinario no crea ni migra tablas. La migración local es un comando separado:

```bash
npm run db:migrate
npm start
```

Las pruebas crean bases temporales y solicitan migración explícita en ellas. SQLite sigue requiriendo disco persistente; para Vercel Functions es necesario adaptar la persistencia a una base remota.

## Verificación

```bash
npm test
npm run test:browser
node tests/save-session-smoke.mjs
node tests/runtime-browser-regressions.mjs
node tests/sync-regressions.mjs
```

Las regresiones cubren dos pestañas del mismo origen sin conexión, respuesta perdida y recarga, aislamiento/cierre offline, rehidratación de preferencias, deterioro/pausas/confianza, disponibilidad, calendario, edición auditada, transición opcional de caminata, visitas repetidas, recuperación de cronómetro y actualizaciones.

No hay integración con smartwatches todavía. No se acreditan mediciones físicas de movimiento, precisión GPS, audio entregado por un teléfono real ni validación clínica/deportiva presencial. Las pruebas de reloj y actividad son automatizadas. No se publica ni migra producción con estos comandos de verificación.
