# PACE/01 — Producto y motor adaptativo v4

Entrenador de running por intervalos (PWA). El motor **no** depende de una lista fija de 10 sesiones: genera un horizonte móvil según el perfil funcional del atleta.

## A. Arquitectura

| Capa | Archivo | Rol |
|------|---------|-----|
| Generador + perfil + carga | `adaptive-engine.js` | `PaceAdaptive` — puro, testeable, reloj inyectable |
| Fachada / persistencia | `coach-engine.js` | `PaceCoach` — localStorage, attempts, API UI |
| UI / timer | `app.js` | Cierre, adaptación explicable, HUD |
| Caché PWA | `sw.js` | `pace01-v2.0.0` incluye `adaptive-engine.js` |

Flujo: cierre de sesión → `decideAdaptive` → attempt (ejecución + acción) → si `advance` regenera horizonte pendiente sin reescribir historial.

Claves: `pace01.plan.v3` (contenido versionado a plan.version=4), `pace01.logs.v3`, `pace01.settings.v1`.

## B. Reglas implementadas

Prioridad: **seguridad → cumplimiento → RPE → tendencia → límites de carga**.

Acciones: `progress` | `consolidate` | `repeat` | `reduce` | `recovery` | `reassess`.

Compat attempts: `progression` = `advance` | `repeat` | `recovery` + campo `adaptiveAction`.

Parámetros propios (`DEFAULT_PARAMS`, configurables en `plan.params`):

- `continuousStepSec`: 30 (mín. 15)
- `maxRunVolumeIncreasePct`: 15
- `trendWindow`: 3 / `minGoodSessionsForProgress`: 2
- `pauseDaysForReassess`: 10
- `horizonPendingRuns`: 2
- Una variable principal por transición (continuo / reps / walk), o reorganización continuo+reps si el volumen cabe

## C. Bibliografía y trazabilidad

| Fuente | Qué usamos | Qué NO atribuimos |
|--------|------------|-------------------|
| NHS Couch to 5K | Progresión walk/jog → continuo; ~3 sesiones/sem; consolidación | Calendario fijo de semanas |
| Jeff Galloway Run-Walk-Run | Alternancia estratégica; no eliminar caminatas solo por mejorar | Ratios propietarios exactos |
| CDC intensidad | RPE 1–10, talk test / percepción | Umbrales FC obligatorios |
| Runna (pública) | Plan según capacidad, adaptación, pausas | Algoritmos internos no públicos |
| BJSM carga | Precaución ante saltos bruscos de distancia/volumen | “Regla del 10%” como ley |

Los números de paso y % son **diseño 4Running**, no garantías clínicas.

## D. Archivos tocados

- `adaptive-engine.js` (nuevo)
- `coach-engine.js`, `app.js`, `index.html`, `styles.css`, `sw.js`
- `tests/adaptive-engine.test.js`, `tests/simulation-14d-report.json`
- `PRODUCT.md`

## E. Migración

`migratePlanToV4` es idempotente: conserva sesiones/attempts, marca `engineVersion`, rellena horizonte si no hay pendientes (corrige “PLAN AL DÍA”). No inventa distancias ni RPE ausentes.

## F. Pruebas

```bash
node tests/adaptive-engine.test.js
```

Perfiles A–G + límites de carga + migración. Informe JSON en `tests/simulation-14d-report.json`.

## G. Comparación 14 días (A vs B)

Misma semilla `7×(2'/2')`. A (RPE 3–4) progresa el continuo (p. ej. 2:00 → 2:30×6 → 3:00…). B (RPE 8 / incompletas) repite o reduce reps. Prescripciones divergentes.

## H. Ejemplo generado

Anterior: `2 min correr / 2 min caminar ×7`  
Nuevo: `2:30 correr / 2 min caminar ×6`  
Cambio: continuo +30 s; carrera total 14→15 min; duración 38→37 min.

## I. Limitaciones

- Sin GPS: distancia estimada vs confirmada manual.
- Velocidades de cinta siguen siendo manuales (sugerencia solo con evidencia futura).
- Etapas 5–6 (tempo/10K) son base; se ampliarán sin romper el generador.
- No es herramienta diagnóstica médica.

## J. Verificar en UI

1. Recargar (SW `v2.0.0`).
2. Completar sesión con RPE 3–4 → pantalla de adaptación con **Progresar/Consolidar** y diff.
3. RPE 7–8 → **Repetir**.
4. Señal de seguridad → **Recuperación**.
5. Agotar restos del plan v3 → siguen apareciendo sesiones nuevas.
6. Historial intacto tras migración.
