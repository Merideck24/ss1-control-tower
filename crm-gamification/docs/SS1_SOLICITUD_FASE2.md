# Solicitud a SS1 · prueba de contrato del PAM (Fase 2)

**Para:** responsable técnico de SS1 (admin.syssoft1.com)
**De:** equipo de SS1 Control Tower (CRM y Fidelidad)
**Estado:** pendiente de envío por el canal del equipo · sin respuesta registrada

---

Hola. Para cerrar la prueba de contrato entre el CRM y el PAM de SS1 necesitamos, en un solo paquete, lo siguiente. Ninguna credencial debe viajar por correo, chat ni tickets: solo por el gestor de secretos del equipo.

## 1. Entorno

- URL base del entorno autorizado para la prueba (sandbox o preproducción), por ejemplo `https://api-sandbox.syssoft1.com`.
- Ventana horaria y límites de tasa que debamos respetar.

## 2. Credencial de solo lectura

- Una credencial de servicio por el gestor de secretos del equipo. Nosotros la cargamos como secreto del entorno de ejecución (`SS1_API_TOKEN`). No va al repositorio, a CI, a logs ni a herramientas de IA.
- Alcances: solo lectura de jugadores, transacciones financieras, retiros y movimientos de juego (`players:read`, `transactions:read`, `withdrawals:read` o su equivalente). Ninguno de escritura.
- Caducidad corta (sugerimos 14 días) y un contacto para revocarla.

## 3. `GET /admin/auth/me`

Acceso al endpoint con esa credencial y la confirmación de estos campos:

| Pregunta | Qué suponemos hoy |
|---|---|
| ¿Qué campo identifica al usuario o servicio autenticado? | `userData.id` (o `id`) |
| ¿Dónde vienen los permisos? | `userAbilities: [{ action, subject }]` (CASL) |
| ¿Qué campo da el tenant (cliente)? | `userData.clientId` (o `client_id`) |
| ¿Viene la marca, o hay que derivarla del cliente? | No viene; se deriva |
| ¿Cómo distingue una credencial de servicio de una de operador? | Sin dato |
| Respuesta con credencial inválida y con credencial válida sin permiso | `401` y `403` |

Si el contrato real difiere, lo registramos y ajustamos el adaptador; no hace falta que SS1 cambie nada.

## 4. Filas reales anonimizadas

Entre 20 y 50 filas por recurso, con los identificadores reemplazados de forma consistente (el mismo jugador conserva el mismo id falso en todos los recursos), sin email, teléfono, documento ni dirección reales, y con permiso escrito para usarlas en pruebas. **No las versionaremos en el repositorio** salvo autorización expresa; vivirán en el almacenamiento seguro del equipo.

Pedimos que incluyan, como mínimo:

| Recurso | Casos |
|---|---|
| Jugadores (`/admin/players`) | KYC aprobado, pendiente y rechazado; autoexclusión vigente y vencida; límites de depósito; país como objeto `{ value }` y como texto; sin `username`; campos nulos u opcionales vacíos |
| Financieras (`/admin/transactions/financial`) | Depósito confirmado, pendiente y fallido; retiro; bono; ajuste; montos con coma decimal; moneda como texto y como objeto |
| Retiros (`/admin/withdrawal-requests`) | Aprobado, rechazado y pendiente |
| Juego (`/admin/transactions/report/all`) | DEBIT, CREDIT, ROLLBACK y FREE_SPIN; movimiento rechazado por la wallet; jugador sin mapeo |
| Errores | Una respuesta de ejemplo con credencial inválida (`401`) y una sin permiso (`403`), con su cuerpo |

Y la confirmación del cliente (tenant) y la marca a las que pertenecen las filas.

## 5. Cinco operadores para validar la interfaz

Cinco operadores que hoy trabajen en CRM, soporte o cumplimiento, 45 minutos cada uno, en dos semanas. Usan la demo con datos sintéticos; no hace falta acceso a datos reales. El guion, los perfiles y la rúbrica están en `docs/usabilidad/GUION.md`. Pedimos además autorización para tomar notas anonimizadas y, si cada participante acepta, grabar la pantalla.

## 6. Qué haremos con todo esto

1. Llamar primero a `GET /admin/auth/me` y comprobar identidad, permisos, tenant y que no haya permisos de escritura. Si falla, la prueba se detiene sin leer datos.
2. Correr la suite de contrato (`test/pam_contract.test.ts` y la validación de filas) contra el entorno, con la credencial solo en memoria.
3. Entregar un informe redactado: conteos, discrepancias y decisiones, sin datos de jugadores ni la credencial.
4. Revocar o dejar caducar la credencial al terminar.

Gracias.
