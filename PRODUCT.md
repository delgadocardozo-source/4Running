# 4Running — comportamiento actual

El producto responde tres preguntas: desde dónde empiezo, qué hago hoy y qué cambia después de correr.

## Flujo

Cuenta real → privacidad → onboarding en 4 pantallas → sesión concreta y motivo → selección cinta/exterior → cronómetro → esfuerzo, conversación y molestias → resultado observado y próxima decisión.

El onboarding registra objetivo, actividad de cuatro semanas, capacidad continua declarada, tolerancia caminando, días/minutos disponibles, entorno y molestia limitante. Solo solicita fecha cuando hay una carrera. La evaluación es opcional; con molestias limitantes se pospone. Se pueden corregir respuestas conservando sesiones anteriores.

## Evaluación

- Desconoce tolerancia: caminata de 15 minutos.
- Camina cómodamente y quiere trotar: 5 min de caminata, 4 bloques de 30–60 s de trote y 90 s de caminata, 5 min de calma.
- Ya corre: evaluación cómoda acorde a su capacidad y tiempo disponible.
- Historial suficiente: puede usarse capacidad observada; si falta evidencia se informa y se mantiene provisional.
- Siempre se puede pasar a caminata o terminar y guardar lo realizado.

Tiempo de carrera observado significa tiempo del cronómetro en esa fase, no detección física de movimiento. Se registra conversación, RPE 0–10 y molestias; no se inventan datos faltantes.

## Orden de decisión

1. Síntomas que empeoran, alteración de marcha, parada por síntomas o molestia relevante: recuperación.
2. Intento incompleto sin alertas: misma prescripción.
3. Datos esenciales ausentes/confianza explícitamente baja: propuesta provisional.
4. Completa, RPE ≥7: repetir.
5. Completa, RPE 6: avanzar únicamente con últimos tres intentos válidos, al menos dos completos ≤6, sin alertas ni deterioro.
6. Completa, RPE ≤5 con evidencia suficiente: ajuste gradual desde la primera sesión.

La única decisión es `PaceAdaptive.decideAdaptive`, coordinada por `PaceCoach.confirmNextSession`. Se guarda el motivo en el log y el intento. Hoy, vista breve del plan e Historial consumen el mismo estado.

El continuo cómodo tiene prioridad. Se limita el volumen y el tiempo disponible, se mantiene la velocidad salvo aceptación y evidencia adecuada, y se explica el cambio. Si no hay candidato compatible se consolida con explicación. La capacidad declarada no acredita hitos. Completar 5K alternando no equivale a correr 2 km continuos.

## Persistencia

Better Auth + cookies y servidor Node con SQLite persistente local. Estado por identidad comprobada en servidor. Revisión optimista, mutaciones idempotentes, unicidad de sesión por cuenta, cola local y conciliación explícita de conflictos. Importación heredada con confirmación de destino.

El frontend sigue siendo JavaScript sin framework. El servidor ya es necesario: para Vercel se requiere adaptar la persistencia a una base remota. No hay despliegue autorizado.

## Verificación y límites

Ver `AUDIT.md` y `README.md`. Se verifican suites, integración de cuentas y recorrido móvil automatizado. No se acredita audio con pantalla bloqueada ni dispositivo real. No hay GPS. Distancia y ritmos de segmentos estimados se señalan como tales y no justifican decisiones de velocidad.


## Revisión de consistencia 3.1

Ver `FIXES.md`. El cronómetro usa tramos persistentes y el diario de sincronización usa operaciones en IndexedDB. Las ediciones conservan la decisión histórica y revisan solo lo futuro. Hoy ofrece una prueba corta de trote tras caminata cómoda con aceptación explícita. El calendario de dos o tres carreras es semanal; cuatro requiere acordar la alternativa de tres con descanso.
