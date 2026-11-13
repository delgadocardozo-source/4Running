# Auditoría inicial — 11 de noviembre de 2026

**Revisión posterior:** los puntajes y afirmaciones de completitud de este documento corresponden a los escenarios iniciales. La revisión crítica encontró regresiones adicionales. Ver `FIXES.md` para las correcciones, la nueva verificación y los límites vigentes. No interpretar un puntaje inicial de tres como una certificación de producción.

## Alcance y base

Repositorio `delgadocardozo-source/4Running`, rama `main`. Auditoría antes de editar la implementación: lectura de README, PRODUCT, REVIEW_NOTES y módulos; dos suites originales ejecutadas; recorrido en Chromium móvil 390 × 844 con perfil nuevo y datos de demostración en origen local. No se encontraron instrucciones AGENTS.md. No se enviaron datos de prueba a producción.

El stack original era HTML/CSS/JavaScript estático con `app.js`, `coach-engine.js`, `adaptive-engine.js`, `product.js`, service worker y localStorage. Se conservó el frontend y el motor. El README original describía algunas capacidades anteriores: la cuenta de producto seguía siendo solo local.

Escala: 0 ausente; 1 incompleta/con fallas; 2 operativa con brechas; 3 completa y probada dentro del alcance indicado. Una prueba automatizada no acredita facilidad de uso observada con personas ni funcionamiento del audio de un teléfono real.

| Área | Antes | Después | Evidencia y brechas |
|---|---:|---:|---|
| Cuentas y datos | 0 | 2 | Antes: `product.js` generaba un ID local y exportaba JSON. Ahora: Better Auth, cookie, API y SQLite; dos cuentas aisladas, otro cliente, cierre, reset de contraseña y transacciones probados. Pendiente proveedor de correo real y alojamiento/base de producción. |
| Onboarding | 2 | 3 | Antes: 4 pantallas, sin actividad reciente, tolerancia caminando ni minutos disponibles; rehacer borraba datos. Ahora: objetivo, 4 semanas, capacidad/«No sé», caminata, disponibilidad, entorno, molestia limitante y evaluación opcional. Fecha solo si hay carrera. Corrección conserva intentos y archiva la antigua prescripción abierta. Pruebas de tres niveles y reprogramación. |
| Evaluación de nivel | 1 | 2 | Antes: declaración y tests de control posteriores. Ahora: caminata de 15 min, 4 trotes cortos con caminata, evaluación fácil del corredor, opción posterior/historial y aplazamiento por molestia. Misma ejecución, bloques observados, RPE 0–10, conversación y molestias. Tiempo observado es tiempo del cronómetro en esa fase, sin sensores; historial insuficiente queda provisional. Sin validación deportiva presencial. |
| Motor de entrenamiento | 2 | 3 | Antes: suites pasaban, pero RPE ausente se convertía en 0; incompleta RPE 8 y completa RPE 9 reducían carga en contra de las reglas pedidas. Ahora: una decisión compartida; recuperación prioritaria; incompletas/RPE ≥7 repiten; faltantes mantienen provisional; primer intento suficiente ≤5 ajusta; RPE 6 usa últimos tres intentos. Simulación de 14 días y suites largas pasan. Calendario estable, frecuencia y límites de tiempo; próximo paso siempre disponible en simulación. |
| Cronómetro | 1 | 2 | Antes: el reloj esperaba la voz, catch-up no consumía todos los bloques y podían acumularse pitidos. Ahora: deadline independiente de voz, salto correcto tras inactividad, 5–4–3–2–1 sin ráfaga, pausa/reanudación, caminar/terminar. Verificado con reloj virtual Chromium y tolerancia de polling de 100 ms. Audio físico, cambio real de app y pantalla bloqueada: **Sin verificar en dispositivo real**. |
| Historial | 2 | 3 | Antes: ejecución y decisión separadas, pero faltaba protección de cuenta e idempotencia extremo a extremo. Ahora: UUID por intento, unicidad cuenta/sesión, clave de mutación reintentable, intento incompleto preservado y motivo guardado. Importar dos veces conserva un único registro; offline/reintento y conflicto de revisión probados. Registro manual sin medición no inventa continuo. |
| UX móvil | 2 | 2 | Antes: Hoy y onboarding operativos, capacidad declarada aparecía como logro. Ahora: marca 4Running, cuenta, sesión/motivo/duración, plan breve, controles de 52–64 px y resumen con resultado, observaciones y siguiente decisión. Guardar visible a 390 × 844, sin errores de JS en el recorrido. Falta prueba con corredores reales y dispositivos físicos. |

## Qué se conservó y qué fallaba

Se conservan el modelo de plan con intentos, separación ejecución/progresión, recuperación, calendario, distancias etiquetadas, exportación, PWA y base del diseño oscuro. Se corrigieron primero identidad/persistencia, reglas de decisión y medición; luego onboarding/evaluación y claridad móvil.

Reproducciones de la base y correcciones:

- En un navegador nuevo no había registro ni login: la identidad era un ID en localStorage. Ahora una sesión de Better Auth determina el propietario en cada lectura y escritura de `/api/state`.
- `decideAdaptive({... rpe:null ...})` convertía `null` a cero; ahora faltantes y confianza explícitamente baja repiten provisionalmente.
- Intento incompleto con RPE 8 o completo RPE 9 reducía carga. Ahora ambos repiten; las señales de seguridad prevalecen.
- Declarar 1–2 min durante onboarding mostraba un minuto «logrado» sin ningún registro. Ahora declaración y observado son campos diferentes.
- Ajustes → rehacer onboarding anunciaba borrado del historial. Ahora se guardan logs y prescripciones realizadas/con intentos y se regeneran solo las futuras.
- Abrir/recalcular el plan podía tomar su propia última fecha futura como punto de partida y desplazar pendientes. Ahora abrirlo es idempotente y la frecuencia modifica el espaciado.
- Reprogramar quitaba `blockedUntilRest`. Ahora conserva el bloqueo; omitir tampoco permite saltar la ruta de recuperación.
- El reloj iniciaba el nuevo deadline después del callback de voz. Ahora cambia a cero y la voz se anuncia sin detenerlo.
- Abrir «Más» mientras corría el reloj lo cerraba en el siguiente tick. Se corrigió y la prueba de confirmación anidada ahora ejecuta esa rama sin omitirla.
- Una sesión incompleta podía mostrarse como «Entrenamiento completado». Ahora dice «Intento incompleto guardado» y separa el motivo de repetir.
- La distancia estimada podía llegar al cálculo de ritmos como si fuese confirmada. Ahora conserva su fuente; los ritmos repartidos están señalados como estimados y no justifican subir velocidad.

## Recorrido y acciones

El onboarding conserva 4 pantallas. Desde una prescripción visible hasta el reloj son **3 pulsaciones**: Iniciar → Cinta/Exterior → Comenzar. La ruta mínima de una persona nueva ahora incluye 1 envío de registro (y completar correo/contraseña), 2 casillas y Continuar de privacidad, 3 Siguientes + Crear plan, y esas 3 pulsaciones de ejecución: **11 acciones de pulsación**, además de escritura y elecciones para personalizar. La base sin cuentas tenía 10 acciones en la ruta equivalente. No es una medición con usuarios; es el conteo de controles del recorrido verificado.

Durante la sesión: fase, tiempo restante, próximo bloque, pausa, caminar y terminar visibles. Al terminar se registran esfuerzo y molestias; el segundo paso permite confirmar datos, conversación y distancia antes de guardar. El test comprueba que el botón Guardar queda dentro del viewport.

Ejemplos verificados:

- Persona que camina cómoda y recién prueba trote: 5 min caminando + 4 × (30 s trote / 90 s caminata) + 5 min de calma = 18 min. Observado: 2 min corriendo, 16 caminando, máximo continuo 30 s. RPE 4 sin alertas ajusta la próxima prescripción gradualmente.
- Tolerancia desconocida y evaluación para después: caminata conservadora de 15 min, sin trote ni logros supuestos. El cierre conserva propuesta provisional y explica cómo elegir la prueba corta cuando caminar sea cómodo.
- Corredor de 30 min habituales y 45 min disponibles: evaluación fácil de 25 min de carrera + calentamiento/calma. Pasar a caminata a los 60 s y terminar guarda un intento incompleto; RPE 8 mantiene la misma prescripción.

Los pasos de 4–15 s en intervalos muy cortos son una decisión conservadora para no superar el límite configurable de volumen; no son umbrales clínicos. A partir de intervalos más largos se usan pasos mayores y reestructuración con explicación de volumen y continuo. Se mantiene la distinción entre 2 km continuos y completar 5 km con caminatas.

## Datos, cuentas y concurrencia

El servidor sirve una lista explícita de assets: no expone `.git`, bases, secretos, pruebas ni informes. Las cookies son gestionadas por Better Auth; las escrituras de datos validan origen y sesión. Los secretos no se guardan en el cliente. El secreto de desarrollo persiste junto a la base, sin versionarse.

El estado se escribe en transacción con revisión optimista. Los logs tienen clave compuesta `(user_id, session_id)`. Una clave de mutación estable permite repetir una petición cuyo guardado fue aceptado pero cuya respuesta se perdió sin generar otro registro ni otro avance. Una escritura concurrente distinta recibe 409; la UI conserva la copia local y exige descargarla antes de optar por la versión remota. La conciliación es explícita, no una fusión automática de dos planes divergentes.

Los datos heredados se guardan separados y solo se importan tras una confirmación que nombra la cuenta de destino. El plan activo se conserva y los logs se unen por ID. Cerrar sesión limpia la caché visible de la cuenta; si quedan cambios pendientes, la UI pide sincronizarlos antes de cerrar. La API comprueba la identidad incluso cuando el cliente envía un propietario falso.

## Verificación ejecutada

- `npm test`: suites originales actualizadas únicamente donde cambió una regla solicitada; regresiones nuevas; simulación de 14 días calendario; pruebas de cuentas contra el servidor real y bases temporales.
- `npm run test:browser`: Chromium 390 × 844, cuentas ficticias, servidor local, tres perfiles, sesión completa e incompleta, pausa, avisos, inactividad simulada, importación doble, reingreso, edición, reprogramación, offline/reintento, conflictos y recuperación desde enlace del buzón de pruebas.
- `node tests/save-session-smoke.mjs`: guardado manual y guardado del cronómetro con confirmación de tiempo anidada; sin ramas omitidas.
- Comprobaciones de sintaxis y `git diff --check`.

`tests/requirements-14d.json` registra 14 fechas reales de simulación (11–24 nov): prescripción anterior, resultado, RPE, decisión, próxima prescripción y motivo. Incluye esfuerzo alto, incompletas, avances y recuperación por seguridad. No se ocultaron días de descanso ni se llamaron «14 días» a varias semanas de sesiones.

Los informes anteriores `tests/fase2-*.json` y `tests/simulation-14d-report.json` se regeneraron con las nuevas reglas. Las capturas, resumen detallado del recorrido y logs se generan en `work/` (fuera de Git).

## Archivos principales y pendientes

`server.mjs`, `cloud.js`, `adaptive-engine.js`, `coach-engine.js`, `app.js`, `index.html`, `styles.css`, `product.js`, `sw.js`, `package.json` y pruebas de `tests/`. README explica ejecución y variables; este documento registra auditoría y límites.

Pendientes concretos antes de producción:

1. Elegir alojamiento Node con disco persistente o adaptar el servidor a base remota para mantener Vercel. No hay credencial de base remota configurada y SQLite en disco efímero no es una solución de producción.
2. Proporcionar secreto estable, URL HTTPS y credencial/dominio verificado del proveedor de correo; verificar entrega real. El buzón local solo acredita el flujo de recuperación de prueba.
3. Autorizar por separado despliegue y migraciones de producción, configurar respaldos y proxy/IP real para límites de autenticación. No se ejecutó ninguna de esas acciones.
4. Probar audio, voz, bloqueo, consumo y retorno de app en iOS y Android reales. El test acredita eventos y tiempos del navegador, no entrega acústica garantizada.
5. Evaluar comprensibilidad y esfuerzo de interacción con corredores principiantes. No se hicieron entrevistas ni sesiones de uso humanas.
6. Sin GPS ni sensores de movimiento, fases ejecutadas y distancia por velocidad son autorregistro/estimación. Una distancia total confirmada tampoco mide automáticamente la parte corrida de una sesión mixta.
