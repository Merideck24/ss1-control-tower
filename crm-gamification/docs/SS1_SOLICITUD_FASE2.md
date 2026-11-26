# Solicitud a SS1 · integración del CRM y Fidelidad con la plataforma

**Para:** responsable técnico de SS1 (admin.syssoft1.com)
**De:** equipo de SS1 Control Tower (CRM y Fidelidad)
**Estado:** pendiente de envío por el canal del equipo · sin respuesta registrada

---

Hola. Para conectar el CRM con la plataforma de SS1 (lectura de datos e interacción directa) necesitamos lo siguiente. Va ordenado por etapas: **la parte A habilita la prueba de contrato y el piloto de solo lectura**, que es lo primero; las partes B a D son para la etapa siguiente y pueden responderse después.

Ninguna credencial debe viajar por correo, chat ni tickets: solo por el gestor de secretos del equipo.

## Resumen de lo que pedimos

| # | Pedido | Parte | Para cuándo |
|---|---|---|---|
| 1 | URL del entorno sandbox o de preproducción | A | Ya (bloquea la prueba de contrato) |
| 2 | Credencial de servicio de solo lectura | A | Ya |
| 3 | `GET /admin/auth/me` y confirmar sus campos | A | Ya |
| 4 | Filas reales anonimizadas | A | Ya |
| 5 | Dónde están email, idioma, zona horaria, afiliado y consentimiento de marketing | A | Ya |
| 6 | Cinco operadores para validar la interfaz | A | Próximas dos semanas |
| 7 | Eventos en tiempo real (SS1 → CRM) | B | Antes del piloto con mensajes |
| 8 | Servicio de bonos, contactos y proveedores de mensajería | B | Antes de activar incentivos |
| 9 | Leaderboard, medallas y barra de progreso en el sitio y la app | C | Antes de mostrar gamificación al jugador |
| 10 | Despliegue, permisos, reglas por mercado y aprobación de Compliance | D | Antes de producción |

---

# Parte A · Prueba de contrato y piloto de solo lectura

## 1. Entorno

- URL base del entorno autorizado para la prueba (sandbox o preproducción), por ejemplo `https://api-sandbox.syssoft1.com`.
- Ventana horaria y límites de tasa que debamos respetar.

## 2. Credencial de solo lectura

- Una credencial de servicio por el gestor de secretos del equipo. Nosotros la cargamos como secreto del entorno de ejecución (`SS1_API_TOKEN`). No va al repositorio, a CI, a logs ni a herramientas de IA.
- Alcances: solo lectura de jugadores, transacciones financieras, retiros y movimientos de juego (`players:read`, `transactions:read`, `withdrawals:read` o su equivalente). Ninguno de escritura.
- Caducidad corta (sugerimos 14 días) y un contacto para revocarla.

## 3. `GET /admin/auth/me`

Hoy no existe: el usuario y sus permisos solo llegan en `POST /admin/auth/login`. Pedimos un GET con la misma forma del login, y la confirmación de estos campos:

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

## 5. Datos del jugador que no encontramos

| Dato | Para qué |
|---|---|
| Email | Canal email y para enmascararlo en Perfil 360 |
| Idioma | Elegir la plantilla (ES, EN o PT) |
| Zona horaria | Horario silencioso y conteos por día local |
| Afiliado o campaña de adquisición | Atribución y calidad por fuente |
| **Consentimiento de marketing por canal** (in-app, email, push, SMS, WhatsApp, Telegram) | Sin consentimiento no se envía marketing; hoy no sabemos dónde vive |
| Casos de soporte abiertos (o la ruta que los expone) | Etapa «Soporte» del recorrido del jugador en Perfil 360 |

## 6. Cinco operadores para validar la interfaz

Cinco operadores que hoy trabajen en CRM, soporte o cumplimiento, 45 minutos cada uno, en dos semanas. Usan la demo con datos sintéticos; no hace falta acceso a datos reales. El guion, los perfiles y la rúbrica están en `docs/usabilidad/GUION.md`. Pedimos además autorización para tomar notas anonimizadas y, si cada participante acepta, grabar la pantalla.

---

# Parte B · Interacción directa

## 7. Eventos en tiempo real (SS1 → CRM)

El CRM ya recibe eventos firmados en `POST /api/ingest/ss1` (HMAC-SHA256, lotes de hasta 500, reenvíos seguros por `event_id`; detalle en `docs/INTEGRATION.md` §4). Sin esto, el CRM lee por sondeo cada pocos minutos.

| Pregunta | Detalle |
|---|---|
| ¿SS1 puede emitir estos eventos? | Registro, verificación KYC, depósito y retiro confirmados, apuesta liquidada (con juego y proveedor), cambio de juego responsable, cambio de consentimiento |
| ¿Webhook o broker? | Si tienen Kafka o RabbitMQ, el CRM se suscribe al tema; si no, webhook |
| Secreto de firma | Uno por tenant, por el gestor de secretos, con rotación |
| Garantía de entrega | ¿Al menos una vez? ¿Reintentos? ¿Orden por jugador? |

## 8. Acciones del CRM sobre SS1 (CRM → SS1)

Hoy están simuladas en el CRM. Para activarlas necesitamos:

| Acción | Qué necesitamos de SS1 |
|---|---|
| **Otorgar bonos, giros y apuestas gratis** | Endpoint para otorgar con **clave de idempotencia** (el mismo pedido dos veces no otorga dos veces) y para **consultar por esa clave** cuando la respuesta no llegó. Tipos de bono, campos obligatorios, vencimiento y moneda. Las rutas que vimos (`/admin/phoenix/free-bets`, `/admin/digitain/free-games`) ¿son las correctas para integraciones? |
| **Contacto para SMS, WhatsApp y Telegram** | El CRM no guarda teléfonos. Necesitamos una ruta que, en el momento de enviar, devuelva el contacto del jugador para ese canal (o que el envío lo haga SS1) |
| **Proveedores de mensajería** | Qué proveedores usa SS1 para email, SMS y WhatsApp; sus credenciales por el gestor de secretos; remitentes; plantillas de WhatsApp aprobadas por Meta |
| **Mensajes in-app y push** | Si el sitio y la app muestran la bandeja del CRM (`GET /api/v1/players/:id/inbox`) o si SS1 tiene su propio centro de mensajes donde publicarlos |
| **Confirmación de entrega** | Si los proveedores informan entrega (callback), a qué URL; así el CRM distingue «aceptado» de «entregado» |
| **Alertas en el admin** | Cómo crear detectores en el admin para que las alertas del CRM aparezcan ahí |
| **Avisos del CRM a SS1** | Una URL que reciba los avisos firmados del CRM (entregas, recompensas, casos de juego responsable, aprobaciones), si les sirve |

Alcances de escritura: solo los necesarios para estas acciones, en una credencial **distinta** de la de solo lectura.

---

# Parte C · Gamificación visible para el jugador

El CRM ya calcula las clasificaciones de los torneos, las medallas de cada jugador (con su catálogo) y el progreso de nivel y de misiones. Falta mostrarlos en el sitio y la app del operador.

## 9. Leaderboard, medallas y barra de progreso

| Pieza | Qué muestra | Qué necesitamos de SS1 |
|---|---|---|
| **Leaderboard** | Posición del jugador, los primeros puestos y los puntos de cada torneo | **Alias público** del jugador: no el username ni el nombre real. ¿Existe un apodo, o se genera uno (por ejemplo «Jug·4821»)? ¿El jugador puede elegir no aparecer? |
| **Medallas de progreso** | Medallas ganadas y por ganar (por ejemplo primer depósito, racha, nivel Oro) | Íconos con la marca de cada operador (SVG o PNG, versiones obtenida y bloqueada) o la aprobación de que los diseñe el equipo del CRM; textos aprobados por idioma |
| **Barra de progreso** | Avance al siguiente nivel de fidelidad y avance de cada misión | Ubicaciones en el sitio y la app (inicio, perfil, lobby, cajero) y si debe mostrar puntos, porcentaje o ambos |

Para las tres:

- **Dónde y cómo se integra:** ¿un componente del CRM incrustado (web component o iframe) o el sitio llama a la API y lo pinta con su propio diseño? Stack del sitio y de la app (web, Android, iOS).
- **Autenticación del jugador:** el CRM no debe recibir la sesión del jugador en el navegador sin validarla. Proponemos que el backend del sitio llame al CRM con una llave de servicio (`onsite:serve`) y el id del jugador, o que SS1 firme un token corto para el jugador. ¿Cuál prefieren?
- **Tiempo real:** ¿el leaderboard se actualiza en vivo durante el torneo? Si sí, depende de los eventos de apuesta del punto 7.
- **Juegos y proveedores que cuentan para cada torneo:** el catálogo (`/admin/games`, `/admin/providers`) y qué juegos excluir (por ejemplo, de baja volatilidad).
- **Reglas y términos por mercado:** términos y condiciones de torneos y premios aprobados por Legal para cada país.
- **Juego responsable:** el CRM ya oculta la gamificación a los jugadores autoexcluidos o con pausa, y respeta la exclusión voluntaria de fidelidad. Confirmar si el regulador de cada mercado pide algo más (por ejemplo, no mostrar ranking de montos apostados).

---

# Parte D · Operación y cumplimiento

## 10. Antes de producción

| Tema | Qué necesitamos |
|---|---|
| Despliegue | Dominio de SS1 para el CRM (por ejemplo `crm.syssoft1.com`), PostgreSQL gestionado y acceso de red entre el CRM y la API del admin |
| Permisos en el admin | Crear los permisos del CRM (ver `docs/INTEGRATION.md`) y asignarlos a los roles de operador |
| Reglas por mercado | Confirmar por país: topes de mensajes de marketing, horario silencioso, consentimiento requerido, incentivos permitidos y KYC exigido para recibir bonos |
| Compliance | Aprobación del piloto: RumbaWin Colombia, primero solo in-app y sin incentivos |
| Contactos | Un responsable técnico, un contacto de Compliance y el canal seguro para credenciales y filas |

---

## Qué haremos con lo de la parte A

1. Llamar primero a `GET /admin/auth/me` y comprobar identidad, permisos, tenant y que no haya permisos de escritura. Si falla, la prueba se detiene sin leer datos.
2. Correr la suite de contrato (`npm run pam:contract -- --live`) contra el entorno, con la credencial solo en memoria.
3. Entregar un informe redactado: conteos, discrepancias y decisiones, sin datos de jugadores ni la credencial.
4. Revocar o dejar caducar la credencial al terminar.

Gracias.
