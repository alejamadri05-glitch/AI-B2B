// HTTP server for the demo page, the embeddable widget and the chat API.
//   GET  /?client=<slug>            chat demo (add &embed=1 inside the widget iframe)
//   GET  /dashboard.html?client=... live list of bookings, leads and escalations
//   GET  /api/clients/<slug>        public branding for the chat page
//   POST /api/chat                  { client, session_id, message, channel? } -> { reply }
//   GET  /api/events?client=...     events for the dashboard (token: ADMIN_TOKEN or the client's dashboard_token)
//   GET  /api/conversations?client=... conversation log for the dashboard (same token)
//   GET  /api/report?client=...&month=YYYY-MM  monthly report { to, subject, html, metrics } (ADMIN_TOKEN)
//   GET  /healthz                    for the hosting provider's health check
//   GET  /api/admin/clients         live (non-demo) clients, for n8n's monthly report loop (ADMIN_TOKEN)
//   POST /api/admin/invites         { business_name, contact_email?, website? } -> onboarding links (ADMIN_TOKEN)
//   GET|POST /api/onboarding/<invite>             the client's onboarding form
//   GET  /api/onboarding/<invite>/review?key=...  config + QA results for your review
//   POST /api/onboarding/<invite>/{publish|changes|retest}?key=...
import "./env.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runTurn, MODEL } from "./agent.js";
import { ROOT_DIR, appendMessage, dataDir, isValidSlug, listClientSlugs, loadClientConfig, readConversations, readEvents } from "./store.js";
import { buildReport, previousMonth } from "./report.js";
import { extractProfile } from "./demo-builder.js";
import * as onboarding from "./onboarding.js";

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_ENTRIES = 120;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
// Public demos cost API money per message: cap messages per IP.
const RATE_LIMIT = { max: 40, windowMs: 10 * 60 * 1000 };

const sessions = new Map(); // `${slug}:${sessionId}` -> { history, busy, updatedAt }
const hits = new Map(); // ip -> timestamps

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, { error: "Not found" });
  }
  const type = MIME[path.extname(file)] || "application/octet-stream";
  res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
  fs.createReadStream(file).pipe(res);
}

async function readJson(req, limit = 16 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, "Request too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT.max;
}

function getSession(slug, sessionId) {
  const now = Date.now();
  for (const [key, s] of sessions) if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  const key = `${slug}:${sessionId}`;
  if (!sessions.has(key)) sessions.set(key, { history: [], busy: false, updatedAt: now });
  const session = sessions.get(key);
  session.updatedAt = now;
  return session;
}

async function handleChat(req, res) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) throw new HttpError(429, "Too many messages. Please wait a few minutes.");

  const { client: slug, session_id: sessionId, message, channel } = await readJson(req);
  const config = loadClientConfig(slug);
  if (!config) throw new HttpError(404, "Unknown client");
  if (typeof sessionId !== "string" || !/^[\w+:.-]{6,80}$/.test(sessionId)) {
    throw new HttpError(400, "session_id must be 6-80 characters (letters, digits, + : . _ -)");
  }
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw new HttpError(400, "message is required");
  if (text.length > MAX_MESSAGE_CHARS) throw new HttpError(400, "Message is too long");

  const session = getSession(slug, sessionId);
  if (session.busy) throw new HttpError(409, "Still answering the previous message");
  if (session.history.length > MAX_HISTORY_ENTRIES) {
    return send(res, 200, { reply: `This chat is getting long. Please call us at ${config.phone} so we can help you directly.` });
  }

  const turnChannel = channel === "sms" ? "sms" : "web";
  const log = (role, msg, extra = {}) => appendMessage(slug, { session_id: sessionId, channel: turnChannel, role, text: msg, ...extra });
  session.busy = true;
  log("customer", text);
  try {
    const { reply } = await runTurn({ config, history: session.history, userText: text, sessionId, channel: turnChannel });
    log("assistant", reply);
    send(res, 200, { reply });
  } catch (err) {
    log("assistant", "(no reply: the assistant failed)", { error: err.message });
    throw err;
  } finally {
    session.busy = false;
  }
}

// Dashboard data: ADMIN_TOKEN sees every client, a client's dashboard_token only its own.
// With no token configured at all (local development), access is open.
function canView(url, config) {
  const token = url.searchParams.get("token");
  if (!ADMIN_TOKEN && !config.dashboard_token) return true;
  return Boolean(token) && (token === ADMIN_TOKEN || token === config.dashboard_token);
}

function clientFromQuery(url) {
  const slug = url.searchParams.get("client");
  const config = isValidSlug(slug) ? loadClientConfig(slug) : null;
  if (!config) throw new HttpError(404, "Unknown client");
  return config;
}

function publicProfile(config) {
  const { slug, business_name, agent_name, greeting, phone, brand_color, demo } = config;
  return { slug, business_name, agent_name, greeting, phone, brand_color, demo: Boolean(demo) };
}

function isAdmin(req, url) {
  if (!ADMIN_TOKEN) return true;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return (bearer || url.searchParams.get("token")) === ADMIN_TOKEN;
}

const ONBOARDING_RE = /^\/api\/onboarding\/([\w-]{20,40})(?:\/(review|publish|changes|retest))?$/;

async function handleOnboarding(req, res, url, tok, action) {
  const key = url.searchParams.get("key");
  const reply = (r) => (r.status === 200 ? send(res, 200, onboarding.reviewInvite(r.invite)) : send(res, r.status, { error: r.error, errors: r.errors }));

  if (!action && req.method === "GET") {
    const invite = onboarding.loadInvite(tok);
    return invite ? send(res, 200, onboarding.publicInvite(invite)) : send(res, 404, { error: "Invite not found" });
  }
  if (!action && req.method === "POST") {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) throw new HttpError(429, "Too many requests. Please wait a few minutes.");
    const result = await onboarding.submitForm(tok, await readJson(req, 128 * 1024));
    if (result.status !== 200) return send(res, result.status, { error: result.error ?? "Please fix the highlighted fields", errors: result.errors });
    return send(res, 200, { ok: true, status: result.invite.status });
  }
  if (action === "review" && req.method === "GET") {
    const invite = onboarding.loadInvite(tok);
    if (!onboarding.checkKey(invite, key)) throw new HttpError(401, "Invalid review link");
    const reportPath = invite.qa?.report_file ? path.join(dataDir(), invite.qa.report_file) : null;
    const qaResults = reportPath && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")).results : [];
    return send(res, 200, { ...onboarding.reviewInvite(invite), qa_results: qaResults });
  }
  if (req.method === "POST" && action === "publish") return reply(await onboarding.publish(tok, key));
  if (req.method === "POST" && action === "changes") return reply(await onboarding.requestChanges(tok, key, (await readJson(req)).note));
  if (req.method === "POST" && action === "retest") return reply(await onboarding.retest(tok, key));
  throw new HttpError(405, "Method not allowed");
}

async function prefillFromWebsite(website) {
  const profile = await extractProfile(website);
  if (!profile) throw new Error("Could not read the website");
  return onboarding.profileToForm(profile);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res);

    if (req.method === "GET" && url.pathname.startsWith("/api/clients/")) {
      const config = loadClientConfig(url.pathname.slice("/api/clients/".length));
      return config ? send(res, 200, publicProfile(config)) : send(res, 404, { error: "Unknown client" });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      const config = clientFromQuery(url);
      if (!canView(url, config)) throw new HttpError(401, "Invalid token");
      return send(res, 200, { events: readEvents(config.slug).reverse() });
    }

    if (req.method === "GET" && url.pathname === "/api/conversations") {
      const config = clientFromQuery(url);
      if (!canView(url, config)) throw new HttpError(401, "Invalid token");
      return send(res, 200, { conversations: readConversations(config.slug).slice(0, 200) });
    }

    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

    if (req.method === "GET" && url.pathname === "/api/admin/clients") {
      if (!isAdmin(req, url)) throw new HttpError(401, "Invalid token");
      const clients = listClientSlugs()
        .map(loadClientConfig)
        .filter((c) => c && !c.demo)
        .map((c) => ({ slug: c.slug, business_name: c.business_name, report_email: c.report?.email ?? null }));
      return send(res, 200, { clients });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/invites") {
      if (!isAdmin(req, url)) throw new HttpError(401, "Invalid token");
      const body = await readJson(req);
      let invite;
      try {
        ({ invite } = onboarding.createInvite(body, { prefill: body.prefill === false ? null : prefillFromWebsite }));
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      return send(res, 200, onboarding.reviewInvite(invite));
    }

    const match = url.pathname.match(ONBOARDING_RE);
    if (match) return await handleOnboarding(req, res, url, match[1], match[2]);

    if (req.method === "GET" && url.pathname === "/api/report") {
      const config = clientFromQuery(url);
      if (ADMIN_TOKEN && url.searchParams.get("token") !== ADMIN_TOKEN) throw new HttpError(401, "Invalid token");
      const month = url.searchParams.get("month") || previousMonth(new Date(), config.timezone);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "month must be YYYY-MM");
      const report = await buildReport(config, month, { ai: url.searchParams.get("ai") !== "0" });
      if (url.searchParams.get("format") === "html") return send(res, 200, report.html, "text/html");
      return send(res, 200, report);
    }

    if (req.method === "GET") return serveStatic(res, url.pathname);
    send(res, 405, { error: "Method not allowed" });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (err instanceof Anthropic.APIError) {
      console.error(`[claude] API error ${err.status}: ${err.message}`);
      return send(res, 502, { error: "The assistant is temporarily unavailable. Please try again or call us." });
    }
    console.error(err);
    send(res, 500, { error: "Something went wrong" });
  }
});

server.listen(PORT, () => {
  console.log(`AI receptionist running on http://localhost:${PORT}/?client=demo-hvac (model ${MODEL})`);
  if (!ADMIN_TOKEN) console.log("Note: ADMIN_TOKEN is not set, so the dashboard is open to anyone with the link.");
});
