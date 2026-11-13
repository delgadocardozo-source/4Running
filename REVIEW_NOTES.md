# Revisión local de 4Running

Consultar `FIXES.md` para la revisión posterior y `AUDIT.md` para la auditoría inicial.

```bash
npm ci --cache /tmp/4running-npm-cache
npm test
npm run test:browser
node tests/save-session-smoke.mjs
node tests/runtime-browser-regressions.mjs
node tests/sync-regressions.mjs
```

Las pruebas usan cuentas y bases temporales. No ejecutan despliegues ni migraciones de producción.

Casos principales: identidad validada en servidor; aislamiento; reintento tras respuesta perdida; importación repetida; conflicto entre dispositivos; historial conservado al corregir respuestas; aviso 5–4–3–2–1; transición independiente de voz; evaluación y entrenamiento con el mismo reloj; incompleta y RPE alto repiten; señales de seguridad prevalecen; reprogramar no quita recuperación; abrir el calendario no mueve fechas; 14 días calendario con próxima acción.

SQLite es el adaptador local/persistente de un servidor Node, no una solución para el filesystem efímero de Vercel. Correo real, base remota, despliegue y pruebas físicas permanecen pendientes explícitos.
