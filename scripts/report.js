// Monthly report for one client or all of them.
//
//   npm run report -- --client demo-hvac                 (last month)
//   npm run report -- --all --month 2026-10 --send
//
// Writes data/reports/<slug>-<month>.html and .json. With --send, POSTs
// { to, subject, html } to REPORT_WEBHOOK_URL (an n8n flow that sends the email).
import "../src/env.js";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, listClientSlugs, loadClientConfig } from "../src/store.js";
import { buildReport, previousMonth } from "../src/report.js";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => argv[argv.indexOf(`--${name}`) + 1];

const slugs = flag("all") ? listClientSlugs() : [value("client")];
const configs = slugs.map(loadClientConfig).filter(Boolean).filter((c) => !c.demo || !flag("all"));
if (!configs.length) {
  console.error("Usage: npm run report -- --client <slug> | --all  [--month YYYY-MM] [--no-ai] [--send]");
  process.exit(1);
}
const webhook = process.env.REPORT_WEBHOOK_URL;
if (flag("send") && !webhook) {
  console.error("Set REPORT_WEBHOOK_URL to the n8n webhook that emails the report.");
  process.exit(1);
}

const outDir = path.join(process.env.DATA_DIR || path.join(ROOT_DIR, "data"), "reports");
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;

for (const config of configs) {
  const month = flag("month") ? value("month") : previousMonth(new Date(), config.timezone);
  const report = await buildReport(config, month, { ai: !flag("no-ai") });
  const base = path.join(outDir, `${config.slug}-${month}`);
  fs.writeFileSync(`${base}.html`, report.html);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  const m = report.metrics;
  console.log(`\n${config.business_name} · ${month}`);
  console.log(`  ${m.conversations} conversaciones (${m.after_hours_conversations} fuera de horario), ${m.bookings} citas, ${m.leads} leads, ${m.urgent_escalations} alertas urgentes`);
  if (m.estimated_revenue !== null) console.log(`  Ingreso estimado: $${m.estimated_revenue}`);
  for (const s of report.internal_suggestions_es) console.log(`  Sugerencia: ${s}`);
  console.log(`  ${path.relative(ROOT_DIR, base)}.html`);

  if (flag("send")) {
    if (!report.to) {
      console.log("  No se envió: falta report.email en la configuración del cliente.");
      failures++;
      continue;
    }
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: report.client, to: report.to, subject: report.subject, html: report.html, metrics: report.metrics }),
    });
    console.log(res.ok ? `  Enviado a ${report.to}` : `  Error al enviar: ${res.status}`);
    if (!res.ok) failures++;
  }
}
process.exit(failures ? 1 : 0);
