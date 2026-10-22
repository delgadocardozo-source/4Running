# PACE/01 — Motor adaptativo v4.1 (Fase 2)

Entrenador de running por intervalos (PWA). Evolución individual: caminar/trotar → carrera continua → 5K → rendimiento / 10K / mantenimiento.

## 1. Resumen de cambios (Fase 2)

- Progresión multidimensional (`continuous` | `volume` | `performance` | `recovery` | `consistency`).
- Acciones: `progress_continuous`, `progress_volume`, `progress_performance`, `consolidate`, `repeat`, `reduce`, `recovery`, `reassess`.
- Escalera de continuo hasta 20–30+ min (no lista fija); fusión a carrera continua cuando corresponde.
- Explicación continuo↑ / volumen↓ (no es pérdida de rendimiento).
- Sugerencias de velocidad **con aceptación explícita** (nunca silenciosas).
- Calendario con `scheduledDate`, descanso entre corridas, sin dos corridas el mismo día.
- UX: recuperación “habilita el próximo”; confianza ≠ precaución.
- Reloj de pruebas: `window.PaceTestClock`.
- SW `pace01-v2.1.0`.

## 2. Reglas deportivas y referencias

| Referencia | Criterio usado | Qué no atribuimos |
|------------|----------------|-------------------|
| NHS Couch to 5K (UK) | Progresión gradual a continuo; ~3 sesiones/sem; consolidación | Calendario fijo de 9 semanas |
| Jeff Galloway, Run Walk Run | Alternancia estratégica; caminatas no se eliminan solo por mejorar | Ratios propietarios exactos |
| CDC Physical Activity Basics | RPE / talk test como intensidad práctica | FC obligatoria |
| ACSM Guidelines (prescripción) | Individualización, progresión, FITT como marco | Umbrales clínicos exactos copiados |
| Runna (docs públicas) | Adaptación a capacidad/pausas; pace insights como *idea de producto* | Algoritmos no públicos |
| Garmin Run Coach (concepto público) | Personalización y recuperación | Lógica interna Garmin |
| BJSM / gestión de carga | Precaución ante saltos bruscos de volumen/distancia | “Regla del 10%” como ley |

**Decisiones 4Running (configurables en `plan.params` / `DEFAULT_PARAMS`):** paso continuo 15–30–60–120 s según nivel; tope ~15 % volumen carrera; ventana tendencia 3; pausa reevaluación 10 días; merge a continuo desde ~8 min o pocas reps.

## 3. Arquitectura

| Módulo | Rol |
|--------|-----|
| `adaptive-engine.js` | Perfil, candidatos, decisión, calendario, velocidad, diffs |
| `coach-engine.js` | Persistencia, attempts, `confirmNextSession`, accept/reject speed |
| `app.js` | UI adaptación, confianza/precaución, `PaceTestClock` |
| `tests/fase2-evolution.test.js` | 8–12 sem + A–H + 14d |

## 4. Archivos modificados

`adaptive-engine.js`, `coach-engine.js`, `app.js`, `index.html`, `styles.css`, `sw.js`, `PRODUCT.md`, `tests/*`.

## 5. Progresión continua

Prioridad principiantes: **continuo** antes que velocidad. Candidatos: +paso, reorganizar (−reps/+continuo), acortar caminata, fusionar a `walkSeconds:0 ×1`. Tope de volumen; si continuo↑ y volumen↓ → dimensión `continuous` con texto explícito.

## 6. Velocidades

`suggestSpeed()`: keep / suggest_up. No estima ritmo de carrera desde distancia total mixta. No escribe `settings.runSpeed` sin `acceptSpeedSuggestion`.

## 7. UX corregida

- Recuperación: “habilitó el próximo entrenamiento” (no “no avanzó”).
- Confianza = evidencia; Precaución = moderar carga; ambas visibles.
- Diff con carrera acumulada + interpretación.

## 8. Calendario

`allocateScheduleDates`: frecuencia/`minRestDaysBetweenRuns`; fechas en pendientes; reprogramar sigue siendo la misma sesión; tras pausa → `reassess`.

## 9–12. Pruebas

```bash
node tests/adaptive-engine.test.js
node tests/fase2-evolution.test.js
```

Escenario A (28 sesiones favorables): **hasta 20 min continuo** en simulación. B no progresa. F/G no vuelven a 2/2×7. Informes: `tests/fase2-scenario-a.json`, `tests/fase2-sim-14d.json`.

## 13. Limitaciones

- Sin GPS: segmentos de cinta no instrumentados → sugerencias de ritmo conservadoras.
- Bloques mixtos heterogéneos: modelo listo (`blocks`), UI timer sigue en modo classic.
- Prueba de 14 días “solo clic en navegador” automatizada vía misma API que la UI (`confirmNextSession` / `markRestComplete`); reloj `PaceTestClock` para UI manual.

## 14. Verificar en interfaz

1. Recargar (SW 2.1.0).
2. Completar sesión RPE 3–4 → ver “Progresión de continuo” + interpretación si baja el volumen.
3. Registrar recuperación → mensaje de habilitación.
4. Historial: Confianza y Precaución separados.
5. Consola (solo prueba): `PaceTestClock.setISO('2026-06-01')` para simular fechas.
6. Si aparece sugerencia de velocidad, aceptar/rechazar; la config no cambia sola.
