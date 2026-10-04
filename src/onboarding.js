// Self-serve onboarding: invite -> client fills the form -> config is built ->
// QA runs automatically -> you get a review link -> one click publishes it.
//
// Each invite is a JSON file in data/onboarding/<token>.json. Statuses:
//   prefilling -> open -> testing -> review -> live
//                  ^                    |
//                  +-- changes_requested+
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ROOT_DIR, dataDir, liveClientsDir, loadClientConfig } from "./store.js";

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const US_TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function onboardingDir() {
  const dir = path.join(dataDir(), "onboarding");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const token = () => crypto.randomBytes(18).toString("base64url");
const publicUrl = () => (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");

export function links(invite) {
  const base = publicUrl();
  return {
    form: `${base}/onboarding.html?invite=${invite.token}`,
    review: `${base}/review.html?invite=${invite.token}&key=${invite.approve_key}`,
    dashboard: `${base}/dashboard.html?client=${invite.slug}&token=${invite.config?.dashboard_token ?? ""}`,
    widget: `<script src="${base}/widget.js" data-client="${invite.slug}" data-color="${invite.config?.brand_color ?? "#1f6feb"}" defer></script>`,
  };
}

// ---------- storage ----------

export function loadInvite(tok) {
  if (typeof tok !== "string" || !/^[\w-]{20,40}$/.test(tok)) return null;
  const file = path.join(onboardingDir(), `${tok}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

export function listInvites() {
  return fs
    .readdirSync(onboardingDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(onboardingDir(), f), "utf8")));
}

function saveInvite(invite, status, note) {
  if (status) {
    invite.status = status;
    invite.history.push({ at: new Date().toISOString(), status, ...(note ? { note } : {}) });
  }
  invite.updated_at = new Date().toISOString();
  fs.writeFileSync(path.join(onboardingDir(), `${invite.token}.json`), JSON.stringify(invite, null, 2));
  return invite;
}

// Tells n8n what happened (it emails you or the client). Without a webhook, logs it.
export async function notify(type, invite, extra = {}) {
  const payload = {
    type,
    slug: invite.slug,
    business_name: invite.business_name,
    contact_email: invite.contact_email,
    status: invite.status,
    links: links(invite),
    ...extra,
  };
  const url = process.env.ONBOARDING_WEBHOOK_URL;
  if (!url) {
    console.log(`[onboarding] ${type} ${invite.slug}: ${JSON.stringify(extra)}`);
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`[onboarding] webhook failed for ${type}: ${err.message}`);
  }
}

export function uniqueSlug(name) {
  const base =
    String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) ||
    "client";
  const taken = new Set(listInvites().map((i) => i.slug));
  let slug = base;
  for (let n = 2; taken.has(slug) || loadClientConfig(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// ---------- invite ----------

// prefill: async (website) => partial form, e.g. from the website via Claude.
// Returns { invite, ready }: ready resolves when the prefill has finished.
export function createInvite({ business_name, contact_email, website }, { prefill } = {}) {
  if (!business_name?.trim()) throw new Error("business_name is required");
  if (contact_email && !EMAIL_RE.test(contact_email)) throw new Error("contact_email is not a valid email");
  const now = new Date().toISOString();
  const invite = {
    token: token(),
    approve_key: token(),
    slug: uniqueSlug(business_name),
    business_name: business_name.trim(),
    contact_email: contact_email?.trim() || null,
    website: website?.trim() || null,
    status: null,
    created_at: now,
    updated_at: now,
    prefill: { business_name: business_name.trim(), website: website?.trim() || "", report_email: contact_email?.trim() || "" },
    form: null,
    config: null,
    qa: null,
    history: [],
  };
  saveInvite(invite, website && prefill ? "prefilling" : "open");
  if (website && prefill) {
    // Re-read before saving: the client may have submitted the form meanwhile.
    const finish = (update, note) => {
      const current = loadInvite(invite.token);
      if (current?.status !== "prefilling") return;
      update(current);
      saveInvite(current, "open", note);
    };
    const ready = prefill(website)
      .then((data) => finish((cur) => (cur.prefill = { ...data, ...cur.prefill, website })))
      .catch((err) => {
        console.error(`[onboarding] prefill failed for ${invite.slug}: ${err.message}`);
        finish(() => {}, "Prefill failed; the form starts empty.");
      });
    return { invite, ready };
  }
  return { invite, ready: Promise.resolve() };
}

// Converts a profile from src/demo-builder.js into the form's shape.
export function profileToForm(profile) {
  return {
    business_name: profile.business_name,
    trade: profile.trade,
    city_state: profile.city_state,
    phone: profile.phone ?? "",
    timezone: US_TIMEZONES.includes(profile.timezone) ? profile.timezone : "America/Chicago",
    brand_color: profile.brand_color ?? "",
    service_area_description: profile.service_area_description,
    zip_codes: profile.zip_codes.join(", "),
    services: profile.services,
    diagnostic_fee: profile.diagnostic_fee ?? "",
    other_prices: profile.pricing_notes.join("\n"),
    financing: profile.financing ?? "",
    warranties: profile.warranties ?? "",
    emergency_24_7: profile.emergency_service_24_7,
    faqs: profile.faqs,
    transfer_phone: profile.phone ?? "",
  };
}

// ---------- form -> config ----------

const str = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const lines = (v) => str(v, 4000).split("\n").map((l) => l.trim()).filter(Boolean);

function hoursText(officeHours, emergency) {
  const open = DAYS.filter((d) => officeHours[d]).map((d) => `${d} ${officeHours[d][0]}-${officeHours[d][1]}`);
  const closed = DAYS.filter((d) => !officeHours[d]);
  return `${open.join(", ")}.${closed.length ? ` Closed ${closed.join(", ")}.` : ""}${emergency ? " 24/7 emergency service." : ""}`;
}

// Returns { errors } (field -> message) or { config }.
export function formToConfig(form, invite, template = readTemplate()) {
  const errors = {};
  const need = (field, label) => {
    if (!str(form[field])) errors[field] = `${label} is required`;
  };
  need("business_name", "Business name");
  need("trade", "Trade");
  need("city_state", "City and state");
  need("phone", "Main phone number");
  need("service_area_description", "Service area");

  const timezone = US_TIMEZONES.includes(form.timezone) ? form.timezone : null;
  if (!timezone) errors.timezone = "Choose a time zone";

  const officeHours = {};
  for (const day of DAYS) {
    const d = form.office_hours?.[day];
    if (!d?.open) {
      officeHours[day] = null;
      continue;
    }
    if (!TIME_RE.test(d.from ?? "") || !TIME_RE.test(d.to ?? "") || d.from >= d.to) {
      errors[`office_hours.${day}`] = `${day}: enter valid opening and closing times`;
    }
    officeHours[day] = [d.from, d.to];
  }
  if (!DAYS.some((d) => officeHours[d])) errors.office_hours = "Open at least one day";

  const services = (form.services ?? []).map((s) => ({ name: str(s.name, 80), description: str(s.description, 300) })).filter((s) => s.name);
  if (!services.length) errors.services = "Add at least one service";

  const windows = (form.arrival_windows ?? [])
    .map((w) => ({ label: str(w.label, 40), start_hour: Number(w.start_hour) }))
    .filter((w) => w.label);
  if (!windows.length) errors.arrival_windows = "Add at least one arrival window";
  if (windows.some((w) => !Number.isInteger(w.start_hour) || w.start_hour < 0 || w.start_hour > 23)) {
    errors.arrival_windows = "Each arrival window needs a start hour between 0 and 23";
  }

  const daysAhead = Number(form.days_ahead);
  if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > 30) errors.days_ahead = "Booking range must be 1-30 days";
  const perWindow = Number(form.jobs_per_window);
  if (!Number.isInteger(perWindow) || perWindow < 1 || perWindow > 50) errors.jobs_per_window = "Jobs per window must be 1-50";

  const reportEmail = str(form.report_email, 200);
  if (!EMAIL_RE.test(reportEmail)) errors.report_email = "Enter a valid email for the monthly report";
  const avgTicket = Number(form.avg_ticket || 0);
  if (!Number.isFinite(avgTicket) || avgTicket < 0) errors.avg_ticket = "Average ticket must be a number";

  if (form.consent !== true) errors.consent = "Please confirm the information and authorize the assistant";
  need("consent_name", "Your name");

  if (Object.keys(errors).length) return { errors };

  const zipCodes = [...new Set(String(form.zip_codes ?? "").match(/\b\d{5}\b/g) ?? [])];
  const agentName = str(form.agent_name, 30) || template.agent_name;
  const businessName = str(form.business_name, 120);
  const emergency = form.emergency_24_7 === true;
  const brand = /^#[0-9a-f]{6}$/i.test(str(form.brand_color)) ? str(form.brand_color) : template.brand_color;
  const closedDays = DAYS.filter((d) => (form.closed_days ?? []).includes(d));

  const config = {
    ...template,
    slug: invite.slug,
    demo: false,
    business_name: businessName,
    agent_name: agentName,
    trade: str(form.trade, 120),
    city_state: str(form.city_state, 120),
    phone: str(form.phone, 40),
    website: str(form.website, 300),
    timezone,
    brand_color: brand,
    greeting: `Hi! I'm ${agentName}, the virtual assistant for ${businessName}. How can I help you today?`,
    hours: hoursText(officeHours, emergency),
    office_hours: officeHours,
    service_area: { description: str(form.service_area_description), zip_codes: zipCodes },
    services,
    pricing: {
      how_we_quote: str(form.how_we_quote),
      diagnostic_fee: str(form.diagnostic_fee),
      after_hours_fee: str(form.after_hours_fee),
      other_prices: lines(form.other_prices),
      notes: [
        "Never quote a repair or installation total in chat.",
        ...lines(form.never_share).map((l) => `Never share: ${l}`),
      ],
    },
    financing: str(form.financing),
    warranties: str(form.warranties),
    emergency: {
      available_24_7: emergency,
      examples: str(form.emergency_examples),
      on_call_response: str(form.on_call_response) || template.emergency.on_call_response,
    },
    booking: {
      arrival_windows: windows,
      closed_days: closedDays,
      days_ahead: daysAhead,
      jobs_per_window: perWindow,
    },
    faqs: (form.faqs ?? []).map((f) => ({ q: str(f.q, 300), a: str(f.a, 1000) })).filter((f) => f.q && f.a),
    escalation: { transfer_phone: str(form.transfer_phone, 40) || str(form.phone, 40) },
    webhook_url: invite.config?.webhook_url ?? "",
    report: { email: reportEmail, avg_ticket: avgTicket },
    dashboard_token: invite.config?.dashboard_token ?? "",
    _onboarding: {
      scheduling_software: str(form.scheduling_software, 100),
      alerts_phone: str(form.alerts_phone, 40),
      alerts_email: str(form.alerts_email, 200),
      consent: { name: str(form.consent_name, 120), title: str(form.consent_title, 120), at: new Date().toISOString() },
    },
  };
  return { config };
}

function readTemplate() {
  return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "clients", "_template.json"), "utf8"));
}

// ---------- QA ----------

// Runs scripts/qa.js in a child process (its own temporary data folder) and
// resolves with { passed, total, failures, report_file }.
export function runQaProcess(config, invite) {
  const dir = path.join(onboardingDir(), invite.token);
  fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, "config.json");
  const reportFile = path.join(dir, `qa-${Date.now()}.json`);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT_DIR, "scripts", "qa.js"), "--config-file", configFile, "--out", reportFile], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", () => {
      if (!fs.existsSync(reportFile)) return reject(new Error(`QA did not produce a report. ${stderr.slice(-500)}`));
      const { results } = JSON.parse(fs.readFileSync(reportFile, "utf8"));
      resolve({
        passed: results.filter((r) => r.pass).length,
        total: results.length,
        failures: results.filter((r) => !r.pass).map((r) => ({ id: r.id, title: r.title, reason: r.grade.reason, checks: r.checks.filter((c) => !c.ok).map((c) => c.what) })),
        report_file: path.relative(dataDir(), reportFile),
        at: new Date().toISOString(),
      });
    });
  });
}

function startQa(invite, runQa) {
  saveInvite(invite, "testing");
  return runQa(invite.config, invite)
    .then((qa) => {
      invite.qa = qa;
      saveInvite(invite, "review");
      return notify("ready_for_review", invite, { qa: { passed: qa.passed, total: qa.total, failures: qa.failures.map((f) => f.title) } });
    })
    .catch((err) => {
      invite.qa = { passed: 0, total: 0, failures: [], error: err.message, at: new Date().toISOString() };
      saveInvite(invite, "review", `QA could not run: ${err.message}`);
      return notify("ready_for_review", invite, { qa: { error: err.message } });
    });
}

// ---------- actions ----------

export async function submitForm(tok, form, { runQa = runQaProcess } = {}) {
  const invite = loadInvite(tok);
  if (!invite) return { status: 404, error: "Invite not found" };
  if (!["open", "changes_requested", "prefilling"].includes(invite.status)) {
    return { status: 409, error: "This form was already submitted. We'll be in touch soon." };
  }
  const { errors, config } = formToConfig(form, invite);
  if (errors) return { status: 400, errors };
  invite.form = form;
  invite.config = config;
  invite.business_name = config.business_name;
  saveInvite(invite);
  await notify("submitted", invite);
  const done = startQa(invite, runQa);
  return { status: 200, invite, done };
}

export function checkKey(invite, key) {
  return invite && typeof key === "string" && key.length > 0 && crypto.timingSafeEqual(Buffer.from(sha(key)), Buffer.from(sha(invite.approve_key)));
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export async function publish(tok, key) {
  const invite = loadInvite(tok);
  if (!checkKey(invite, key)) return { status: 401, error: "Invalid review link" };
  if (invite.status !== "review") return { status: 409, error: `Can't publish from status "${invite.status}"` };
  const config = { ...invite.config, dashboard_token: invite.config.dashboard_token || token() };
  fs.writeFileSync(path.join(liveClientsDir(), `${invite.slug}.json`), JSON.stringify(config, null, 2) + "\n");
  invite.config = config;
  saveInvite(invite, "live");
  await notify("live", invite, { report_email: config.report.email });
  return { status: 200, invite };
}

export async function requestChanges(tok, key, note) {
  const invite = loadInvite(tok);
  if (!checkKey(invite, key)) return { status: 401, error: "Invalid review link" };
  if (invite.status !== "review") return { status: 409, error: `Can't request changes from status "${invite.status}"` };
  const message = str(note, 2000);
  if (!message) return { status: 400, error: "Write what the client should change" };
  saveInvite(invite, "changes_requested", message);
  await notify("changes_requested", invite, { note: message });
  return { status: 200, invite };
}

export async function retest(tok, key, { runQa = runQaProcess } = {}) {
  const invite = loadInvite(tok);
  if (!checkKey(invite, key)) return { status: 401, error: "Invalid review link" };
  // A run left in "testing" for 15+ minutes was interrupted (e.g. a server restart).
  const stuck = invite.status === "testing" && Date.now() - Date.parse(invite.updated_at) > 15 * 60 * 1000;
  if (!invite.config || !(invite.status === "review" || stuck)) return { status: 409, error: "Tests are running or there is nothing to test yet" };
  const done = startQa(invite, runQa);
  return { status: 200, invite, done };
}

// What the client's form may see (no keys, no internal notes beyond the latest request).
export function publicInvite(invite) {
  const lastNote = [...invite.history].reverse().find((h) => h.status === "changes_requested")?.note ?? null;
  return {
    business_name: invite.business_name,
    status: invite.status,
    form: invite.form ?? invite.prefill,
    changes_requested: invite.status === "changes_requested" ? lastNote : null,
  };
}

// What the review page shows (requires the approve key).
export function reviewInvite(invite) {
  const { approve_key, token: _t, ...rest } = invite;
  return { ...rest, links: links(invite) };
}
