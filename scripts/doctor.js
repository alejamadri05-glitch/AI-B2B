// Checks that everything is set up: keys, public URL, storage, n8n webhooks,
// Outscraper and every live client's config. Prints what to fix.
//
//   npm run doctor            (no side effects)
//   npm run doctor -- --ping  (also calls PUBLIC_URL/healthz and sends a test event to each n8n webhook)
import "../src/env.js";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../src/agent.js";
import { dataDir, listClientSlugs, liveClientsDir, loadClientConfig } from "../src/store.js";

const ping = process.argv.includes("--ping");
let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const section = (title) => console.log(`\n${title}`);
const isLocal = (url) => /localhost|127\.0\.0\.1/.test(url);

section("Node");
const major = Number(process.versions.node.split(".")[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node}: se necesita 20 o más`);

section("Claude (Anthropic)");
if (!process.env.ANTHROPIC_API_KEY) {
  fail("Falta ANTHROPIC_API_KEY (console.anthropic.com > API Keys)");
} else {
  try {
    const model = await new Anthropic().models.retrieve(MODEL);
    ok(`La clave funciona y tienes acceso a ${model.id}`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) fail("ANTHROPIC_API_KEY no es válida");
    else if (err instanceof Anthropic.NotFoundError) fail(`Tu cuenta no tiene acceso al modelo ${MODEL}; cambia MODEL`);
    else fail(`No se pudo verificar la clave: ${err.message}`);
  }
}

section("Seguridad y URL pública");
const admin = process.env.ADMIN_TOKEN ?? "";
if (!admin) fail("Falta ADMIN_TOKEN: sin él, los paneles, reportes e invitaciones quedan abiertos");
else if (admin.length < 20) fail("ADMIN_TOKEN es muy corto: usa al menos 20 caracteres aleatorios");
else ok("ADMIN_TOKEN configurado");

const publicUrl = process.env.PUBLIC_URL ?? "";
if (!publicUrl) fail("Falta PUBLIC_URL (la URL de tu servidor, p. ej. https://ai-receptionist.onrender.com)");
else if (isLocal(publicUrl)) warn(`PUBLIC_URL es ${publicUrl}: está bien en tu computadora, pero los enlaces que mandes no funcionarán`);
else if (!publicUrl.startsWith("https://")) fail("PUBLIC_URL debe empezar con https://");
else ok(`PUBLIC_URL = ${publicUrl}`);

if (ping && publicUrl && !isLocal(publicUrl)) {
  try {
    const res = await fetch(`${publicUrl.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(10000) });
    res.ok ? ok("El servidor público responde") : fail(`El servidor público respondió ${res.status}`);
  } catch (err) {
    fail(`No se pudo llegar a ${publicUrl}: ${err.message}`);
  }
}

section("Almacenamiento");
for (const [name, dir] of [["DATA_DIR", dataDir()], ["CLIENTS_DIR", liveClientsDir()]]) {
  try {
    const probe = path.join(dir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe);
    ok(`${name} se puede escribir: ${dir}`);
  } catch (err) {
    fail(`${name} no se puede escribir (${dir}): ${err.message}`);
  }
  if (!process.env[name] && !isLocal(publicUrl)) warn(`${name} no está definido: en producción apúntalo a un disco persistente o perderás datos en cada deploy`);
}

section("Webhooks de n8n");
for (const [name, purpose] of [
  ["WEBHOOK_URL", "citas, leads y alertas urgentes"],
  ["ONBOARDING_WEBHOOK_URL", "pasos del onboarding"],
]) {
  const url = process.env[name];
  if (!url) {
    fail(`Falta ${name} (${purpose}). Importa el flujo de n8n/ y pega aquí la Production URL de su Webhook`);
    continue;
  }
  if (url.includes("/webhook-test/")) warn(`${name} usa una URL de prueba de n8n: solo funciona con el editor abierto. Usa la Production URL y activa el flujo`);
  if (!ping) {
    ok(`${name} configurado`);
    continue;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "test", message: "Prueba de npm run doctor", at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10000),
    });
    res.ok ? ok(`${name} recibió el evento de prueba (míralo en Executions de n8n)`) : fail(`${name} respondió ${res.status}: ¿el flujo está activo?`);
  } catch (err) {
    fail(`${name} no responde: ${err.message}`);
  }
}

section("Outscraper (prospección)");
if (!process.env.OUTSCRAPER_API_KEY) {
  warn("Falta OUTSCRAPER_API_KEY: solo la necesitas para npm run prospects --enrich");
} else {
  try {
    const res = await fetch("https://api.outscraper.cloud/profile/balance", {
      headers: { "X-API-KEY": process.env.OUTSCRAPER_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    res.ok ? ok("La clave de Outscraper funciona") : fail(`Outscraper respondió ${res.status}: revisa la clave`);
  } catch (err) {
    fail(`No se pudo llegar a Outscraper: ${err.message}`);
  }
}

section("Clientes");
const live = listClientSlugs().map(loadClientConfig).filter((c) => c && !c.demo);
if (!live.length) warn("Todavía no hay clientes publicados (las demos no cuentan)");
for (const c of live) {
  const problems = [];
  const raw = JSON.stringify(c);
  if (raw.includes("REPLACE")) problems.push("tiene campos REPLACE sin llenar");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: c.timezone });
  } catch {
    problems.push(`zona horaria inválida (${c.timezone})`);
  }
  if (!c.phone) problems.push("sin teléfono");
  if (!c.services?.length) problems.push("sin servicios");
  if (!c.booking?.arrival_windows?.length) problems.push("sin ventanas de llegada");
  if (!c.office_hours) problems.push("sin office_hours (el reporte usará 8-17 de lunes a viernes)");
  if (!c.report?.email) problems.push("sin report.email");
  if (!c.dashboard_token) problems.push("sin dashboard_token propio");
  problems.length ? fail(`${c.slug}: ${problems.join("; ")}`) : ok(`${c.slug} (${c.business_name})`);
}

console.log(failures ? `\n${failures} cosa(s) por arreglar.` : "\nTodo listo.");
process.exit(failures ? 1 : 0);
