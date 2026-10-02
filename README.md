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
| `ADMIN_TOKEN` | Protege el panel: `dashboard.html?client=...&token=...` |
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

## Instalar en un cliente

1. Llena `clients/<slug>.json` con el [formulario de onboarding](onboarding/intake-form.md).
2. Pasa el [checklist de lanzamiento](onboarding/launch-checklist.md).
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
