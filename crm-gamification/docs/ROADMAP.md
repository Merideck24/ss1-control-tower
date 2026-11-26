# Hoja de ruta: SS1 CRM y Gamificación en producción

**Objetivo:** pasar de una solución completa en funciones y demostrada con datos sintéticos a un módulo del admin de SS1 en producción, con datos reales, persistencia completa y vistas nativas.

**Fecha:** 2026-11-24. Las duraciones son estimaciones para un equipo de 2 a 3 personas y dependen de las decisiones de SS1 listadas al final.

## Dónde estamos

| Frente | Estado |
|---|---|
| Funciones (paridad con Fast Track, GR8 Tech y Optimove) | 54 de 59 filas hechas. Las 5 restantes dependen de terceros: datos de producción, proveedores reales, broker de eventos, certificaciones y agentes autónomos, que se descartaron a propósito |
| Base de datos | **Fase 1 hecha.** Ver el detalle abajo |
| API de integración v1 | **Hecha.** Ver el detalle abajo |
| Admin de SS1 | **4 vistas nativas** (Juego responsable, Políticas, Integraciones y el Control Tower, que va enchufado en el tablero «CRM» del admin). Las otras 11 siguen embebidas |
| Pruebas | 141 automáticas, más 4 contra PostgreSQL en CI. Las vistas Vue se renderizan con Vue y Vuetify reales |

**Base de datos (fase 1):**

- esquema completo con aislamiento por tenant (RLS);
- eventos y auditoría persistentes, solo-anexar;
- reconstrucción al reiniciar (probada con 28.895 eventos).

**API de integración v1:**

- OpenAPI 3.1 de 86 operaciones, verificada contra el código;
- llaves de servicio con alcances, límite de tasa y CORS.

## Fase 1 · Conexión con SS1 (2 a 3 semanas)

1. **Contrato de datos** (leído del código del admin; ver `docs/SS1_DATA_CONTRACT.md`):
   - hecho: rutas y campos de jugadores, transacciones financieras y apuestas (`/admin/transactions/report/all`), y la definición de GGR del admin;
   - SS1 agrega `GET /admin/auth/me` (hoy no existe una ruta que resuelva el token);
   - SS1 entrega un token de servicio válido para comprobar los campos con datos reales;
   - SS1 indica dónde están el email, el idioma, la zona horaria, el afiliado y el consentimiento de marketing.
2. Desplegar en staging con PostgreSQL. Variables: `DATABASE_URL`, `CRM_ALLOWED_ORIGINS`, `SS1_API_BASE`, `SS1_PROFILE_PATH` y `CRM_TENANT_MAP`.
3. Crear en el backend del admin los permisos CASL de `integrations/ss1-admin/permissions.json` y asignarlos a los roles.
4. Crear las llaves de servicio: el PAM con `events:write`, y el sitio con `players:read`, `players:write` y `onsite:serve`. Conectar los eventos en tiempo real (webhook firmado o `POST /api/v1/events`).
5. Hacer la carga histórica (CSV o conectores) y conciliarla contra los reportes del admin.

**Criterio de salida:** depósitos, GGR y NGR por día y por marca cuadran con el admin dentro de ±0,5 %.

## Fase 2 · Persistencia completa (3 a 4 semanas)

Cada módulo pasa a su tabla y escribe antes de ejecutar el efecto, en la misma transacción. El orden es por riesgo de pérdida:

1. Recompensas y presupuesto.
2. Recorridos en curso y A/B.
3. Recibos y bandeja.
4. Fidelidad, monedas y canjes.
5. Casos de juego responsable, revisiones y políticas.
6. Configuración. Desde aquí el sembrado de demostración deja de ejecutarse.
7. Webhooks y outbox.

**Criterio de salida:** matar el proceso en cualquier punto no pierde ni duplica efectos. Se comprueba con pruebas de caos. Detalle en `docs/DATABASE.md`.

## Fase 3 · Admin nativo (4 a 6 semanas, en paralelo con la fase 2)

Migrar las pestañas embebidas a componentes Vuexy, en orden de uso:

1. Perfil 360.
2. Segmentos.
3. Analítica y rendimiento.
4. Gamificación y fidelidad.
5. Aprobación.
6. Plantillas y contenido en sitio.
7. Constructor visual (es la más compleja).
8. Copiloto y auditoría.

Cada migración agrega su prueba de renderizado.

**Criterio de salida:** `CRM_VIEWS.embedded` queda vacío y se retira el iframe.

## Fase 4 · Proveedores y calibración (3 a 4 semanas)

1. Gateway de SS1 con las credenciales de email, WhatsApp (con plantillas aprobadas por Meta), SMS y push. El CRM no guarda teléfonos ni secretos.
2. Cumplimiento y el equipo de juego responsable fijan por mercado: topes de envío, horario silencioso, umbrales de riesgo y de abuso, e impuesto sobre GGR (hoy el 15 % es un valor de ejemplo).
3. Reentrenar y validar los modelos con datos reales.
4. Grupo de control en todos los recorridos de marketing (j4 no lo tiene).
5. Probar la redacción de plantillas con IA usando credenciales reales.

**Criterio de salida:** un primer recorrido real medido contra su grupo de control, con incremento y ROI reportados.

## Fase 5 · Operación y escala (continuo)

- **Observabilidad:** OpenTelemetry, métricas y alertas (latencia, entregas, feed de juego responsable, presupuestos).
- **Carga:** pruebas con 1 millón de jugadores y 100 eventos por segundo. Particionar `events` por mes, réplica de lectura y agregados diarios materializados.
- **Bus de eventos:** Kafka o RabbitMQ a través de la interfaz `EventBus` y el outbox.
- **Seguridad:** prueba de penetración, gestor de secretos y cifrado por KMS de los secretos de webhooks. Pruebas de extremo a extremo de navegador en CI.
- **Cumplimiento:** preparación GDPR y SOC (retención, borrado y exportación de datos del jugador).

## Decisiones que necesitamos de SS1

1. Contrato de datos: `GET /admin/auth/me`, token de servicio válido y campos del jugador que faltan (ver `docs/SS1_DATA_CONTRACT.md`).
2. PostgreSQL gestionado: proveedor, región, copias de seguridad y retención.
3. Dominio del CRM (p. ej. `crm.syssoft1.com`) y entornos (staging y producción).
4. Responsables de cumplimiento y juego responsable que aprueban políticas por mercado.
5. Gateway de mensajería y proveedores.
6. Broker de eventos, si lo hay.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Las cifras no cuadran con el admin | La conciliación es el criterio de salida de la fase 1. Nada se activa antes |
| Pérdida de estado al reiniciar, antes de la fase 2 | Mientras tanto no hay envíos reales; los efectos son idempotentes por clave |
| Umbrales calibrados con datos sintéticos | La fase 4 los recalibra con aprobación de cumplimiento; los cambios son versionados y auditados |
| El constructor visual es costoso de migrar | Se migra al final; mientras tanto sigue embebido y funcional |
