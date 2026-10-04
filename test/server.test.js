import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "receptionist-server-test-"));
const DATA_DIR = path.join(tmp, "data");
const CLIENTS_DIR = path.join(tmp, "clients");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CLIENTS_DIR, { recursive: true });
const PORT = 31000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${PORT}`;
const mine = "0b6f3c1e-5d2a-4f8e-9c7b-1a2b3c4d5e6f";
const theirs = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

// Two demo visitors and one real client, written the way the server writes them.
const line = (o) => JSON.stringify(o) + "\n";
fs.writeFileSync(path.join(DATA_DIR, "demo-hvac.jsonl"), [mine, theirs].map((s, i) => line({ id: `E${i}`, at: new Date().toISOString(), type: "lead", session_id: s, data: { name: s === mine ? "Me" : "Someone else" } })).join(""));
fs.writeFileSync(path.join(DATA_DIR, "demo-hvac.messages.jsonl"), [mine, theirs].map((s) => line({ at: new Date().toISOString(), session_id: s, channel: "web", role: "customer", text: `hi from ${s}` })).join(""));
const real = JSON.parse(fs.readFileSync(new URL("../clients/demo-hvac.json", import.meta.url), "utf8"));
fs.writeFileSync(path.join(CLIENTS_DIR, "real-co.json"), JSON.stringify({ ...real, slug: "real-co", demo: false, dashboard_token: "real-token-123456789012345" }));
fs.writeFileSync(path.join(DATA_DIR, "real-co.jsonl"), line({ id: "R1", at: new Date().toISOString(), type: "lead", session_id: mine, data: { name: "Customer" } }));

let server;
before(async () => {
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, CLIENTS_DIR, ADMIN_TOKEN: "admin-secret", ANTHROPIC_API_KEY: "test" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("running") && resolve()));
});
after(() => server.kill());

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};

test("a demo visitor sees only their own events and conversation", async () => {
  const events = await get(`/api/events?client=demo-hvac&session=${mine}`);
  assert.equal(events.status, 200);
  assert.deepEqual(events.body.events.map((e) => e.data.name), ["Me"]);
  const convs = await get(`/api/conversations?client=demo-hvac&session=${mine}`);
  assert.deepEqual(convs.body.conversations.map((c) => c.session_id), [mine]);
});

test("the admin token still sees every demo visitor", async () => {
  const { body } = await get("/api/events?client=demo-hvac&token=admin-secret");
  assert.equal(body.events.length, 2);
});

test("no token and no valid session is refused", async () => {
  assert.equal((await get("/api/events?client=demo-hvac")).status, 401);
  assert.equal((await get("/api/events?client=demo-hvac&session=abcdef")).status, 401, "short, guessable ids are not enough");
});

test("a session id never opens a real client's dashboard", async () => {
  assert.equal((await get(`/api/events?client=real-co&session=${mine}`)).status, 401);
  assert.equal((await get(`/api/conversations?client=real-co&session=${mine}`)).status, 401);
  assert.equal((await get("/api/events?client=real-co&token=real-token-123456789012345")).status, 200);
});
