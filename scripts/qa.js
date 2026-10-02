// Automated launch checklist: runs every scenario against a client's bot.
//
//   npm run qa -- --client demo-hvac
//   npm run qa -- --client demo-hvac --only gas-smell,book-visit
//   node scripts/qa.js --config-file draft.json --out report.json   (used by onboarding)
//
// Bookings and leads go to a temporary folder and webhooks are switched off,
// so the client never sees test data. Exits with code 1 if anything fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT_DIR, loadClientConfig } from "../src/store.js";
import { buildScenarios } from "../src/qa/scenarios.js";
import { runScenario } from "../src/qa/runner.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

const args = parseArgs(process.argv.slice(2));
const config = args["config-file"] ? JSON.parse(fs.readFileSync(args["config-file"], "utf8")) : loadClientConfig(args.client);
if (!config) {
  console.error("Usage: npm run qa -- --client <slug> | --config-file <file>  [--only id1,id2] [--concurrency 3] [--out report.json]");
  process.exit(1);
}

const reportDir = path.join(process.env.DATA_DIR || path.join(ROOT_DIR, "data"), "qa");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "receptionist-qa-"));
delete process.env.WEBHOOK_URL;
const testConfig = { ...config, webhook_url: "" };

const only = args.only?.split(",");
const scenarios = buildScenarios(testConfig).filter((s) => !only || only.includes(s.id));
const concurrency = Number(args.concurrency || 3);
console.log(`Probando ${config.business_name} con ${scenarios.length} escenarios…\n`);

const results = [];
const queue = [...scenarios];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const scenario = queue.shift();
      const result = await runScenario({ config: testConfig, scenario });
      results.push(result);
      console.log(`${result.pass ? "PASA " : "FALLA"}  ${result.title}`);
      for (const c of result.checks.filter((c) => !c.ok)) console.log(`       x ${c.what}`);
      if (!result.grade.pass) console.log(`       x ${result.grade.reason}`);
    }
  }),
);

const reportFile = args.out ?? path.join(reportDir, `${config.slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
const ordered = scenarios.map((s) => results.find((r) => r.id === s.id));
fs.writeFileSync(reportFile, JSON.stringify({ client: config.slug, at: new Date().toISOString(), results: ordered }, null, 2));

const failed = ordered.filter((r) => !r.pass);
console.log(`\n${ordered.length - failed.length}/${ordered.length} escenarios pasan. Conversaciones completas en ${path.relative(ROOT_DIR, reportFile)}`);
process.exit(failed.length ? 1 : 0);
