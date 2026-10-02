// Monthly report for a client: what the receptionist did, in numbers, plus a
// short AI summary of what customers asked. The email is in English for the
// owner; the suggestions in Spanish are only for you (internal).
import Anthropic from "@anthropic-ai/sdk";
import { readConversations, readEvents } from "./store.js";
import { isAfterHours, localNow } from "./calendar.js";

const MODEL = process.env.MODEL || "claude-opus-5-5";

export function monthOf(at, timeZone) {
  return localNow(new Date(at), timeZone).date.slice(0, 7);
}

export function previousMonth(now, timeZone) {
  const [y, m] = localNow(now, timeZone).date.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function monthLabel(month) {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function computeMetrics(config, month) {
  const inMonth = (at) => monthOf(at, config.timezone) === month;
  const conversations = readConversations(config.slug).filter(
    (c) => inMonth(c.started_at) && c.messages.some((m) => m.role === "customer"),
  );
  const events = readEvents(config.slug).filter((e) => inMonth(e.at));
  const bookings = events.filter((e) => e.type === "booking");
  const leads = events.filter((e) => e.type === "lead");
  const escalations = events.filter((e) => e.type === "escalation");
  const avgTicket = Number(config.report?.avg_ticket) || null;

  return {
    month,
    conversations: conversations.length,
    after_hours_conversations: conversations.filter((c) => isAfterHours(config, c.started_at)).length,
    bookings: bookings.length,
    after_hours_bookings: bookings.filter((e) => isAfterHours(config, e.at)).length,
    leads: leads.length,
    leads_with_phone: leads.filter((e) => e.data.phone).length,
    escalations: escalations.length,
    urgent_escalations: escalations.filter((e) => e.data.urgency === "immediate").length,
    avg_ticket: avgTicket,
    estimated_revenue: avgTicket ? bookings.length * avgTicket : null,
    booking_list: bookings.map((e) => ({
      date: e.data.date,
      arrival_window: e.data.arrival_window,
      customer_name: e.data.customer_name,
      service_type: e.data.service_type,
    })),
    conversation_list: conversations,
  };
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    highlights: { type: "array", items: { type: "string" } },
    faq_gaps: { type: "array", items: { type: "string" } },
    suggestions_es: { type: "array", items: { type: "string" } },
  },
  required: ["highlights", "faq_gaps", "suggestions_es"],
  additionalProperties: false,
};

// Reads the month's conversations and returns { highlights, faq_gaps, suggestions_es }.
export async function summarizeConversations(config, conversations, client = new Anthropic()) {
  if (!conversations.length) return { highlights: [], faq_gaps: [], suggestions_es: [] };
  const transcripts = conversations
    .map((c, i) => `#${i + 1} (${c.channel}, ${c.started_at})\n` + c.messages.map((m) => `${m.role}: ${m.text}`).join("\n").slice(0, 3000))
    .join("\n\n");
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SUMMARY_SCHEMA } },
    system: `You review a month of conversations between the AI receptionist of ${config.business_name} (${config.trade}) and its customers. Return:
- highlights: up to 3 short sentences in English for the business owner about what customers wrote in about (main issues, services requested, busy patterns). Use counts only when you can count them in the transcripts. No marketing tone.
- faq_gaps: up to 5 questions customers asked that the assistant could not answer from the business information, written as questions in English, so the owner can provide answers.
- suggestions_es: up to 3 suggestions in Spanish for the founder who maintains the assistant: prompt or configuration changes, mistakes the assistant made, upsell opportunities.
Never include customers' names, phone numbers or addresses.`,
    messages: [{ role: "user", content: `Business information (JSON):\n${JSON.stringify(config, null, 2)}\n\nConversations:\n\n${transcripts}` }],
  });
  const text = response.content.find((b) => b.type === "text")?.text;
  if (response.stop_reason === "refusal" || !text) return { highlights: [], faq_gaps: [], suggestions_es: ["El resumen con IA no se pudo generar este mes."] };
  return JSON.parse(text);
}

const escape = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

export function renderReportHtml(config, metrics, summary) {
  const label = monthLabel(metrics.month);
  const color = /^#[0-9a-f]{6}$/i.test(config.brand_color ?? "") ? config.brand_color : "#1f6feb";
  const headline =
    metrics.estimated_revenue !== null
      ? `${money(metrics.estimated_revenue)} in estimated revenue from ${metrics.bookings} booked job${metrics.bookings === 1 ? "" : "s"}`
      : `${metrics.bookings} job${metrics.bookings === 1 ? "" : "s"} booked by your AI receptionist`;
  const afterHoursPct = metrics.conversations ? Math.round((metrics.after_hours_conversations / metrics.conversations) * 100) : 0;
  const stat = (n, label) =>
    `<td style="padding:12px;border:1px solid #e3e6ea;border-radius:8px;text-align:center;width:25%"><div style="font-size:24px;font-weight:700;color:#1c1f24">${n}</div><div style="font-size:12px;color:#5f6672">${label}</div></td>`;
  const list = (items) => `<ul style="margin:8px 0 0;padding-left:20px;color:#1c1f24">${items.map((i) => `<li style="margin:4px 0">${escape(i)}</li>`).join("")}</ul>`;
  const bookingsTable = metrics.booking_list.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">
<tr style="text-align:left;color:#5f6672"><th style="padding:6px 4px;border-bottom:1px solid #e3e6ea">Date</th><th style="padding:6px 4px;border-bottom:1px solid #e3e6ea">Window</th><th style="padding:6px 4px;border-bottom:1px solid #e3e6ea">Customer</th><th style="padding:6px 4px;border-bottom:1px solid #e3e6ea">Service</th></tr>
${metrics.booking_list.map((b) => `<tr><td style="padding:6px 4px;border-bottom:1px solid #f0f1f3">${escape(b.date)}</td><td style="padding:6px 4px;border-bottom:1px solid #f0f1f3">${escape(b.arrival_window)}</td><td style="padding:6px 4px;border-bottom:1px solid #f0f1f3">${escape(b.customer_name)}</td><td style="padding:6px 4px;border-bottom:1px solid #f0f1f3">${escape(b.service_type)}</td></tr>`).join("\n")}
</table>`
    : `<p style="color:#5f6672">No jobs were booked through the assistant this month.</p>`;

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border-collapse:separate;width:100%">
<tr><td style="padding:20px 24px;background:${color};color:#ffffff;border-radius:12px 12px 0 0">
<div style="font-size:13px;opacity:.85">${escape(config.business_name)} · ${escape(label)}</div>
<div style="font-size:20px;font-weight:700;margin-top:4px">${escape(headline)}</div>
</td></tr>
<tr><td style="padding:20px 24px">
<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px"><tr>
${stat(metrics.conversations, "Conversations")}${stat(metrics.bookings, "Jobs booked")}${stat(metrics.leads, "Leads captured")}${stat(metrics.urgent_escalations, "Urgent alerts")}
</tr></table>
<p style="color:#1c1f24;font-size:14px;margin:16px 0 0">${metrics.after_hours_conversations} of ${metrics.conversations} conversations (${afterHoursPct}%) came in outside your office hours.${metrics.after_hours_bookings ? ` ${metrics.after_hours_bookings} of the booked jobs came from those.` : ""}</p>
${metrics.estimated_revenue !== null ? `<p style="color:#5f6672;font-size:12px;margin:6px 0 0">Estimated revenue = jobs booked × your average ticket of ${money(metrics.avg_ticket)}.</p>` : ""}
${summary.highlights.length ? `<h3 style="font-size:15px;color:#1c1f24;margin:20px 0 0">What customers asked about</h3>${list(summary.highlights)}` : ""}
${summary.faq_gaps.length ? `<h3 style="font-size:15px;color:#1c1f24;margin:20px 0 0">Questions to add to your assistant</h3><p style="color:#5f6672;font-size:13px;margin:4px 0 0">Reply with answers to these and we'll teach them to your assistant.</p>${list(summary.faq_gaps)}` : ""}
<h3 style="font-size:15px;color:#1c1f24;margin:20px 0 0">Jobs booked</h3>
${bookingsTable}
</td></tr>
<tr><td style="padding:16px 24px;color:#5f6672;font-size:12px;border-top:1px solid #e3e6ea">Your AI receptionist answers your website chat 24/7. Questions about this report? Just reply to this email.</td></tr>
</table></body></html>`;
}

export async function buildReport(config, month, { ai = true, client } = {}) {
  const metrics = computeMetrics(config, month);
  const summary = ai ? await summarizeConversations(config, metrics.conversation_list, client) : { highlights: [], faq_gaps: [], suggestions_es: [] };
  const { conversation_list, ...publicMetrics } = metrics;
  return {
    client: config.slug,
    to: config.report?.email ?? null,
    subject: `${config.business_name}: your AI receptionist in ${monthLabel(month)}`,
    html: renderReportHtml(config, metrics, summary),
    metrics: publicMetrics,
    internal_suggestions_es: summary.suggestions_es,
  };
}
