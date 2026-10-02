// HTTP server for the demo page, the embeddable widget and the chat API.
//   GET  /?client=<slug>            chat demo (add &embed=1 inside the widget iframe)
//   GET  /dashboard.html?client=... live list of bookings, leads and escalations
//   GET  /api/clients/<slug>        public branding for the chat page
//   POST /api/chat                  { client, session_id, message, channel? } -> { reply }
//   GET  /api/events?client=...     events for the dashboard (needs ADMIN_TOKEN if set)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runTurn, MODEL } from "./agent.js";
import { ROOT_DIR, isValidSlug, loadClientConfig, readEvents } from "./store.js";

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

  session.busy = true;
  try {
    const { reply } = await runTurn({
      config,
      history: session.history,
      userText: text,
      sessionId,
      channel: channel === "sms" ? "sms" : "web",
    });
    send(res, 200, { reply });
  } finally {
    session.busy = false;
  }
}

function publicProfile(config) {
  const { slug, business_name, agent_name, greeting, phone, brand_color, demo } = config;
  return { slug, business_name, agent_name, greeting, phone, brand_color, demo: Boolean(demo) };
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
      if (ADMIN_TOKEN && url.searchParams.get("token") !== ADMIN_TOKEN) throw new HttpError(401, "Invalid token");
      const slug = url.searchParams.get("client");
      if (!isValidSlug(slug) || !loadClientConfig(slug)) throw new HttpError(404, "Unknown client");
      return send(res, 200, { events: readEvents(slug).reverse() });
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
