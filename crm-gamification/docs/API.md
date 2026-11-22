# API REST (MVP)

Base: `/api`. Sesión de desarrollo por cabeceras — **reemplazar por identidad SS1 (OIDC) antes de producción**:

| Cabecera | Ejemplo | Uso |
|---|---|---|
| `x-tenant-id` | `tenant-rumbawin` | Frontera de tenant; todo se filtra por este valor |
| `x-actor` | `ana@ss1` | Autor en auditoría |
| `x-roles` | `crm_analyst,approver` | `crm_analyst`, `approver`, `support`, `rg_officer`, `tenant_admin`, `auditor` |

| Método y ruta | Descripción | Requisito |
|---|---|---|
| `GET /health` | Liveness | — |
| `GET /control-tower` | Recorridos, entregas, supresiones, fallos, presupuestos, alertas, métricas por fuente | Control Tower |
| `POST /events` | Ingesta de un evento normalizado (`202 applied/duplicate`, `422 rejected`) | CRM-01 |
| `GET /players?q=` | Búsqueda por player_id seudonimizado | CRM-01 |
| `GET /players/:id` | Perfil 360 con procedencia, explicación de elegibilidad, fidelidad, recibos, instancias | CRM-01, CRM-08 |
| `GET /segments/fields` · `POST /segments/preview` | Catálogo de campos y estimación de segmento | CRM-02 |
| `GET /journeys` · `POST /journeys` | Listado (con vista accesible en lista) y guardado de borrador | CRM-03 |
| `POST /journeys/:id/submit\|approve\|publish\|pause\|resume` | Ciclo de vida con aprobación separada | CRM-03, CRM-08 |
| `POST /journeys/:id/simulate` | Simulación sin efectos contra un jugador `{player_id, payload}` | CRM-03 |
| `POST /runtime/tick` | Procesa temporizadores vencidos (demo: `{advance_hours}`) | CRM-03 |
| `POST /runtime/pause` | Pausa general por tenant (`tenant_admin` / `rg_officer`) | CRM-08 |
| `GET /rewards` · `POST /rewards/reconcile` | Catálogo, presupuesto, otorgamientos y conciliación | CRM-07 |
| `GET /analytics/campaigns` | Tratamiento vs. control, IC 95 %, costo | CRM-09 |
| `GET /audit` | Registro encadenado (`auditor`, `tenant_admin`, `approver`) | CRM-08 |
| `GET /copilot/tools` · `POST /copilot/tools/:name` | Herramientas del copiloto según rol | IA |
| `POST /copilot/ask` | Pregunta en lenguaje natural (Claude, requiere credenciales) | IA |
