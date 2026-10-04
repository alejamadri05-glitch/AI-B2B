// Tools the receptionist can call. Each successful action is written to the
// client's event log and, if configured, POSTed to a webhook (e.g. an n8n flow
// that texts the owner, adds the job to the CRM or appends to a Google Sheet).
import { appendEvent } from "./store.js";
import { availableWindows, isWindowBookable } from "./calendar.js";

const nullableString = { type: ["string", "null"] };

export const TOOLS = [
  {
    name: "check_availability",
    description:
      "List open arrival windows for a service visit. Call this before offering any appointment times; never invent availability.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        preferred_date: {
          ...nullableString,
          description: "Earliest date the customer wants, YYYY-MM-DD, or null for the soonest openings.",
        },
      },
      required: ["preferred_date"],
      additionalProperties: false,
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a service visit in an open arrival window. Only call after the customer has confirmed the date, window and their details.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        phone: { type: "string", description: "Customer's callback phone number." },
        address: { type: "string", description: "Street address of the service location." },
        zip_code: { type: "string" },
        service_type: { type: "string", description: "Which of the business's services this visit is for." },
        issue_description: { type: "string", description: "What the customer reported, in their words." },
        date: { type: "string", description: "YYYY-MM-DD, taken from check_availability." },
        arrival_window: { type: "string", description: "Exact window label from check_availability." },
        notes: { ...nullableString, description: "Gate codes, pets, parking, anything the technician should know." },
      },
      required: [
        "customer_name",
        "phone",
        "address",
        "zip_code",
        "service_type",
        "issue_description",
        "date",
        "arrival_window",
        "notes",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "capture_lead",
    description:
      "Save a lead when the customer is not booking right now: wants a callback or quote, is outside the service area, or is undecided. Collect at least a name and phone or email first when possible.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        customer_name: nullableString,
        phone: nullableString,
        email: nullableString,
        zip_code: nullableString,
        service_type: nullableString,
        reason: {
          type: "string",
          enum: ["wants_callback", "quote_request", "outside_service_area", "undecided", "other"],
        },
        summary: { type: "string", description: "One or two sentences the owner can act on." },
      },
      required: ["customer_name", "phone", "email", "zip_code", "service_type", "reason", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Alert a person at the business right away: emergencies, safety issues, complaints, billing disputes, or when the customer asks for a human.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: ["emergency", "safety", "complaint", "billing", "requests_human", "other"],
        },
        urgency: { type: "string", enum: ["immediate", "today", "normal"] },
        customer_name: nullableString,
        phone: nullableString,
        summary: { type: "string", description: "What happened and what the customer needs." },
      },
      required: ["reason", "urgency", "customer_name", "phone", "summary"],
      additionalProperties: false,
    },
  },
];

function inServiceArea(config, zip) {
  const zips = config.service_area?.zip_codes ?? [];
  return zips.length === 0 || zips.includes(String(zip).trim().slice(0, 5));
}

async function notifyWebhook(config, record) {
  const url = config.webhook_url || process.env.WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: config.slug,
        business_name: config.business_name,
        // Where n8n should send the alert for this client.
        alerts: {
          email: config._onboarding?.alerts_email || config.report?.email || null,
          phone: config._onboarding?.alerts_phone || null,
        },
        ...record,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`[webhook] ${config.slug}: ${err.message}`);
  }
}

async function record(ctx, type, data) {
  const rec = appendEvent(ctx.config.slug, { type, session_id: ctx.sessionId, channel: ctx.channel, data });
  await notifyWebhook(ctx.config, rec);
  return rec;
}

// Returns { content: string, isError: boolean } for a tool_result block.
export async function executeTool(name, input, ctx) {
  const { config, now } = ctx;
  switch (name) {
    case "check_availability": {
      const slots = availableWindows(config, now, input.preferred_date);
      return ok({ open_windows: slots, note: slots.length ? undefined : "No openings in the booking range." });
    }
    case "book_appointment": {
      if (!inServiceArea(config, input.zip_code)) {
        return fail(`ZIP ${input.zip_code} is outside the service area (${config.service_area.description}).`);
      }
      const check = isWindowBookable(config, input.date, input.arrival_window, now);
      if (!check.ok) return fail(check.reason);
      const rec = await record(ctx, "booking", input);
      return ok({ booked: true, confirmation_number: rec.id, date: input.date, arrival_window: input.arrival_window });
    }
    case "capture_lead": {
      const rec = await record(ctx, "lead", input);
      return ok({ saved: true, lead_id: rec.id });
    }
    case "escalate_to_human": {
      const rec = await record(ctx, "escalation", input);
      return ok({
        notified: true,
        ticket: rec.id,
        what_happens_next:
          input.urgency === "immediate" && config.emergency?.on_call_response
            ? config.emergency.on_call_response
            : "A team member has been notified and will follow up.",
        direct_phone: config.escalation?.transfer_phone ?? config.phone,
      });
    }
    default:
      return fail(`Unknown tool: ${name}`);
  }
}

function ok(value) {
  return { content: JSON.stringify(value), isError: false };
}

function fail(message) {
  return { content: JSON.stringify({ error: message }), isError: true };
}
