# PACE/01 — Motor de progresión 5K (spec v1.0 consolidada)

Objetivo: progresar con seguridad hacia completar 5 km run/walk.  
**Listo** = preparado para *intentar finalizar* 5K con run/walk, no correr 5K continuos.

## Flujo canónico (prioridad)
1. Realizar entrenamiento  
2. Guardar attempt en `attempts[]`  
3. Overrides de seguridad  
4. Cumplimiento de prescripción  
5. Confianza  
6. RPE  
7. Tendencia reciente (si RPE = 6)  
8. Resolver `advance` / `repeat` / `recovery`  
9. Próxima prescripción  

## Ejecución ≠ progresión
- Ejecución: `completed` | `aborted` | `skipped`  
- Progresión: `advance` | `repeat` | `recovery`  
- Cumplimiento = bloques prescritos correr/caminar (no distancia GPS).  

## Tendencia reciente favorable
Últimos **3 intentos válidos** de entrenamiento (incluye repeticiones del mismo PlanItem).  
**Excluye** intentos/sesiones de recovery.

Favorable cuando:
1. Al menos **2 de 3** completaron la prescripción  
2. RPE de los completados **≤ 6**  
3. Sin dolor progresivo, marcha alterada ni parada forzada  
4. Sin deterioro sostenido (heurística: RPE +2 o continuo −20% entre primero y último completado de la ventana)  
5. Confianza **media o alta**  

Con **menos de 3** intentos válidos → RPE 6 produce **repeat** por defecto.

## Matriz RPE + cumplimiento

| Situación | Resultado |
|-----------|-----------|
| Cumplido + RPE ≤5 + sin alertas + confianza ≥ media | **advance** |
| Cumplido + RPE 6 + tendencia favorable + confianza ≥ media | **advance** |
| Cumplido + RPE 6 + tendencia no favorable | **repeat** |
| Cumplido + RPE ≥7 | **repeat** |
| No completó prescripción + sin alertas | **repeat** |
| Alerta de seguridad (override) | **recovery** (prioridad máx.) |
| Confianza baja / datos esenciales incompletos | **repeat** provisional (no advance) |

## Overrides
`worseningDuringRun` | `alteredGait` | `forcedStop` | alerta severa → **recovery** + aviso no diagnóstico.

## Confianza
- **Alta**: registro completo/coherente  
- **Media**: esenciales completos, algunos estimados  
- **Baja**: faltan RPE/cumplimiento/seguridad → no advance ni «Listo»  

## Carga
Una variable principal por paso; duración/volumen antes que velocidad; exterior cómodo/conversacional.

## Home
> Sin dolor y RPE ≤5 confirma una buena tolerancia al entrenamiento. Con RPE 6 miramos la tendencia reciente antes de avanzar.

## Reprogramar
Mismo `planItemId` + `scheduledDate`; no duplica; no crea attempt ficticio; no avanza.
