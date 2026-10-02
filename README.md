# Recepcionista IA para servicios del hogar (EE.UU.)

Plantilla de un agente que atiende el chat del sitio web (y luego SMS) de empresas de aire acondicionado (HVAC), plomería, electricidad o techos. El agente:

- **Agenda visitas** en ventanas de llegada reales (8–11, 11–2, 2–5), revisando el ZIP y la capacidad de cada ventana.
- **Captura leads** cuando el cliente no agenda: quiere una cotización o una llamada, o está fuera del área.
- **Escala emergencias y quejas** a una persona de inmediato, con instrucciones de seguridad (olor a gas, chispas, fugas de agua).
- **Responde preguntas** usando solo la información aprobada del negocio. Nunca inventa precios.
- Contesta en el idioma del cliente, inglés o español.

Funciona con Claude (por defecto `claude-opus-5-5`) a través del SDK oficial de Anthropic. Si el modelo rechaza una solicitud, la API la reintenta automáticamente con otro modelo (`fallbacks: "default"`).

## Estructura

```
clients/            Un JSON por negocio: datos, servicios, precios, horarios
  demo-hvac.json    Negocio ficticio para demos (Bluebonnet Heating & Air, Austin TX)
  _template.json    Plantilla para clientes nuevos
src/
  prompt.js         Instrucciones del agente (seguridad, flujo de agenda, reglas)
  tools.js          Herramientas: check_availability, book_appointment, capture_lead, escalate_to_human
  agent.js          Ciclo de conversación con Claude
  calendar.js       Calendario de demo basado en ventanas de llegada
  server.js         Servidor HTTP: demo, widget, API de chat, panel
public/             Página de demo, widget para instalar y panel de leads
scripts/new-prospect.js   Genera la demo de un prospecto a partir de su sitio web
scripts/prospects.js      Pipeline de prospección: Outscraper → ranking → contactos → primera línea → demos → CSV
scripts/qa.js             Pruebas automáticas del bot con clientes simulados (checklist de lanzamiento)
scripts/report.js         Reporte mensual por cliente (HTML para el dueño + sugerencias internas)
scripts/onboard.js        Crea invitaciones de onboarding y lista su estado
onboarding/         Formulario para el cliente (inglés) y checklist de lanzamiento (español)
test/               Pruebas con un cliente simulado (no gastan API)
```

## Arranque rápido

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # tu clave de console.anthropic.com
npm start
```

Abre `http://localhost:3000/?client=demo-hvac` para chatear y `http://localhost:3000/dashboard.html?client=demo-hvac` para ver las citas, leads y alertas en vivo.

Para correr las pruebas: `npm test`.

Variables de entorno opcionales:

| Variable | Para qué sirve |
|---|---|
| `PORT` | Puerto del servidor (por defecto 3000) |
| `MODEL` | Modelo de Claude (por defecto `claude-opus-5-5`) |
| `EFFORT` | Esfuerzo de razonamiento: `low` (por defecto) o `medium` si las respuestas se quedan cortas |
| `ADMIN_TOKEN` | Tu llave maestra: ve el panel de todos los clientes y el reporte. `dashboard.html?client=...&token=...` |
| `PUBLIC_URL` | URL pública del servidor, para los enlaces de demos, formularios y revisión |
| `CLIENTS_DIR` | Carpeta persistente donde se guardan los clientes publicados (en producción, un disco que no se borre) |
| `ONBOARDING_WEBHOOK_URL` | Webhook de n8n que recibe los eventos del onboarding y manda los correos |
| `REPORT_WEBHOOK_URL` | Webhook de n8n que envía el reporte mensual por correo (para `npm run report -- --send`) |
| `WEBHOOK_URL` | Webhook global para eventos. Cada cliente puede tener el suyo en `webhook_url` |
| `DATA_DIR` | Carpeta donde se guardan los eventos (por defecto `data/`) |

Cada llamada a la API imprime en la consola los tokens usados (`in`, `cache_read`, `out`). Úsalos para medir el costo real por conversación antes de fijar tus precios.

## Cómo usarlo para vender

1. **Demo personalizada para cada prospecto** (2 minutos):
   ```bash
   npm run new-prospect -- --url https://su-sitio.com --slug su-negocio
   ```
   Claude lee el sitio y crea `clients/su-negocio.json`. **Revísalo antes de enseñarlo**: el script te muestra lo que conviene verificar, y lo que no está en el sitio queda vacío.
2. En el correo o en la llamada: *"I built a demo of your receptionist, trained on your website: [link]. Try asking it to book a repair."*
3. En la llamada, abre el chat y el panel lado a lado. Agenda una cita y deja que el prospecto vea cómo aparece en el panel al instante. Ese es el momento que vende.

## Prospección automática

```bash
# 1. Gratis: califica la exportación de Outscraper (.xlsx, .csv o .json de la API)
npm run prospects -- --input outscraper.xlsx --batch houston-oct

# 2. Con costo: contactos y reseñas (Outscraper), primera línea (Claude) y demo para los 40 mejores
export OUTSCRAPER_API_KEY=...  ANTHROPIC_API_KEY=...  PUBLIC_URL=https://tu-servidor
npm run prospects -- --input outscraper.xlsx --batch houston-oct --top 40 --enrich --personalize --demos
```

Resultado en `data/prospects/<batch>/`:
- `revision.csv`: todos los negocios con prioridad, puntaje, motivos, correo, primera línea, citas de reseñas y demo. Revísalo antes de enviar.
- `instantly.csv`: los prospectos listos, con columnas `first_name`, `company_name`, `city`, `personalization` y `demo_link` para usarlas como variables en Instantly. Cuando no hay nombre, configura el texto de respaldo "there".

Cómo califica: nicho (HVAC y plomería primero), tamaño (20–400 reseñas), sitio web, horario de 24 horas, señales de clientela hispana y quejas de 1 estrella. Excluye franquicias, empresas con más de 1,500 reseñas, negocios fuera de Houston y San Antonio y categorías fuera del nicho. Cada punto aparece explicado en la columna `motivos`.

Los resultados con costo se guardan en `leads.json`. Si vuelves a correr el mismo `--batch`, no se paga dos veces. Las citas de reseñas que Claude devuelve se verifican contra el texto original y se descartan si no aparecen tal cual.

## Pruebas automáticas del bot

```bash
npm run qa -- --client demo-hvac
npm run qa -- --client demo-hvac --only gas-smell,book-visit
```

Un cliente simulado por Claude conversa con el bot en 11 escenarios: agendar, ZIP fuera del área, precio de equipo nuevo, olor a gas, emergencia, "¿eres humano?", queja, número de tarjeta, intento de manipulación, cliente en español y día cerrado. Para cada uno se verifica que el bot haya creado (o no) la cita, el lead o la alerta, y otro modelo califica la conversación con una rúbrica. Las citas de prueba van a una carpeta temporal y el webhook del cliente se desactiva. El reporte completo queda en `data/qa/`, y el comando termina con error si algo falla.

Córrelo antes de cada lanzamiento y cada vez que cambies `src/prompt.js`.

## Registro de conversaciones

Cada mensaje del cliente y cada respuesta del bot se guardan en `data/<slug>.messages.jsonl`. En el panel, la pestaña **Conversations** muestra cada conversación completa. Úsala para revisar qué dice el bot durante las primeras semanas de cada cliente.

- Dale a cada cliente su propio `dashboard_token` en su JSON. Con ese token solo ve su panel; tu `ADMIN_TOKEN` ve todos.
- Las conversaciones incluyen nombres, teléfonos y direcciones. `data/` está fuera de git: no lo subas a ningún lado. Define con cada cliente cuánto tiempo guardar las conversaciones (por ejemplo 12 meses) y borra lo anterior.

## Reporte mensual

```bash
npm run report -- --client demo-hvac                  # mes anterior, solo genera el archivo
npm run report -- --all --month 2026-10 --send        # todos los clientes reales (no las demos), y lo envía
```

El reporte va en inglés para el dueño. Empieza con el ingreso estimado (citas × `report.avg_ticket`) y sigue con:
- conversaciones, citas, leads y alertas urgentes;
- cuántas conversaciones llegaron fuera del horario de oficina (`office_hours`);
- un resumen de Claude con los temas más consultados y las preguntas que el bot no supo contestar. Esto último es tu excusa para actualizar la configuración y mantener el contacto.

Las sugerencias internas en español se imprimen en la consola y quedan en el `.json`, nunca en el correo. Los archivos se guardan en `data/reports/`.

**Envío automático con n8n** (el día 1 de cada mes):
1. Schedule Trigger: mensual, día 1, 8:00 AM.
2. HTTP Request: `GET https://TU-SERVIDOR/api/report?client=<slug>&token=<ADMIN_TOKEN>`. Devuelve `{ to, subject, html, metrics }` del mes anterior. Usa un nodo por cliente, o una lista de slugs con Split Out.
3. Gmail (o SMTP): envía `html` a `to` con el asunto `subject` y con copia para ti.

Para ver el correo en el navegador, agrega `&format=html` a la URL.

## Onboarding automático

Del pago a "en vivo" sin configurar nada a mano:

1. **Invitación.** `npm run onboard -- --business "Bayou Plumbing" --email owner@bayou.com --website https://bayou.com`. También puede hacerla n8n después del pago, con `POST /api/admin/invites` y `Authorization: Bearer <ADMIN_TOKEN>`. Si hay sitio web, Claude prellena el formulario.
2. **El cliente llena el formulario** (`/onboarding.html?invite=…`, en inglés). Son 10 secciones con validación y autoguardado en su navegador.
3. **Pruebas automáticas.** Al enviar, se arma la configuración y corren los 11 escenarios de `npm run qa` en un proceso aparte, sin tocar datos reales. Cada corrida cuesta unas 11 conversaciones de Claude.
4. **Tu revisión** (`/review.html?invite=…&key=…`, en español). Ves los resultados con cada conversación, el resumen de la configuración, y tres botones: **Publicar**, **Repetir pruebas** o **Pedir cambios** (el cliente recibe tu nota y el formulario se reabre).
5. **Publicar** guarda el cliente en `CLIENTS_DIR`, le crea su `dashboard_token` y envía el evento `live` con el código del widget y el enlace al panel.

Estados: `prefilling → open → testing → review → live`, con `changes_requested` de vuelta a `open`. `npm run onboard -- --list` muestra todos con su enlace de revisión.

**Eventos al webhook** (`ONBOARDING_WEBHOOK_URL`). Todos traen `type`, `slug`, `business_name`, `contact_email` y `links` (`form`, `review`, `dashboard`, `widget`):

| `type` | A quién debería avisar n8n | Qué usar |
|---|---|---|
| `submitted` | A ti | Aviso de que el cliente envió el formulario |
| `ready_for_review` | A ti | `qa.passed`/`qa.total` y `links.review` |
| `changes_requested` | Al cliente | `note` y `links.form` |
| `live` | Al cliente (con copia para ti) | `links.widget` para pegar en su sitio y `links.dashboard` |

El enlace de revisión lleva una clave secreta: no lo reenvíes al cliente.

## Instalar en un cliente

1. Usa el onboarding automático (arriba). O, a mano, llena `clients/<slug>.json` con las preguntas de [onboarding/intake-form.md](onboarding/intake-form.md).
2. Corre `npm run qa -- --client <slug>` y revisa el [checklist de lanzamiento](onboarding/launch-checklist.md).
3. Pega una línea en el sitio del cliente:
   ```html
   <script src="https://TU-SERVIDOR/widget.js" data-client="slug" data-color="#1f6feb" defer></script>
   ```
4. Publica el servidor en cualquier hosting de Node (Render, Railway, Fly.io) con `ANTHROPIC_API_KEY` y `ADMIN_TOKEN` configurados. Usa almacenamiento persistente para `data/`, o deja que n8n guarde los eventos.

## Integración con n8n

Cada cita, lead o alerta se envía por `POST` al webhook del cliente:

```json
{
  "client": "demo-hvac",
  "business_name": "Bluebonnet Heating & Air",
  "id": "K3F9QA",
  "at": "2026-10-02T20:04:00.000Z",
  "type": "booking",
  "session_id": "…",
  "channel": "web",
  "data": { "customer_name": "Ana Lopez", "phone": "512-555-0199", "date": "2026-10-03", "arrival_window": "8-11 AM", "...": "..." }
}
```

`type` puede ser `booking`, `lead` o `escalation`. En n8n, ramifica según `type`. Por ejemplo: SMS al dueño cuando llega una `escalation`, una fila en Google Sheets o el CRM por cada `booking`, y un correo resumen diario.

**Canal SMS** (sin cambiar el código): Twilio Trigger → nodo HTTP Request `POST /api/chat` con `{ "client": "slug", "session_id": "<número del cliente>", "message": "<texto>", "channel": "sms" }` → Twilio Send SMS con el `reply`.

## Siguientes pasos

- **Calendario real:** cambia `availableWindows` y `isWindowBookable` en `src/calendar.js` por la API del software del cliente (Housecall Pro, Jobber, ServiceTitan) o por Google Calendar.
- **Llamadas perdidas:** un mensaje automático por SMS después de una llamada no contestada ("Sorry we missed your call, I can help you book here…") suele ser el gancho de venta más fuerte.
- **Voz:** el prompt y las herramientas se pueden reutilizar en una plataforma de agentes de voz.

## Antes de cobrarle a un cliente en EE.UU.

- **Aviso de IA:** el agente dice que es un asistente virtual. No quites esa regla; algunos estados exigen revelar que es un bot.
- **SMS:** necesitas el registro A2P 10DLC en Twilio (toma días o semanas) y el consentimiento del cliente antes de enviarle mensajes (TCPA). Responder a quien te escribió primero es lo más seguro.
- **Cobros:** para cobrar en dólares desde Costa Rica, la vía habitual es una LLC en EE.UU. con cuenta y pasarela de pagos. Verifica la disponibilidad de Stripe y los requisitos, y consulta a un contador sobre la tributación en Costa Rica.
- **Contrato:** deja por escrito que el cliente aprueba la información que usa el bot y que el bot no sustituye la atención de emergencias.
