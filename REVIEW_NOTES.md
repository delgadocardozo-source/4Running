# PACE/01 v1.3 — Review Notes

Ver `PRODUCT.md` (especificación).

## Separación clave
- Ejecución: `completed | aborted | skipped`
- Progresión: `advance | repeat | recovery`
- Cada `PlanItem` tiene `attempts[]`. Un RPE 7 completed + repeat **no borra** el entrenamiento.

## Checklist manual
1. Completar cierre con RPE 7 sin dolor → historial `ejec. completed` + `prog. repeat`; Home sigue en la misma sesión; attempts = 1.
2. Segundo cierre RPE 4 sin dolor → `advance`; cursor a recuperación.
3. RPE 6 con historial limpio → advance; con tendencia mala → repeat.
4. Marcar “fue empeorando” → recovery + gate, aunque RPE sea 4.
5. Reprogramar no duplica id.
6. Distancia estimada hasta confirmar.
