// Prospecting pipeline: Outscraper export -> ranked leads -> contacts and reviews
// -> personalized first line -> demo per prospect -> CSV ready for Instantly.
//
//   npm run prospects -- --input leads.xlsx --batch houston-oct            (free: rank only)
//   npm run prospects -- --input leads.xlsx --batch houston-oct --top 40 --enrich --personalize --demos
//
// Each paid step only runs for the top leads and is saved in
// data/prospects/<batch>/leads.json, so re-running never pays twice.
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, isValidSlug, loadClientConfig } from "../src/store.js";
import { loadOutscraperFile, toCsv } from "../src/prospects/load.js";
import { rankLeads } from "../src/prospects/score.js";
import { OutscraperClient, pickContact } from "../src/prospects/outscraper.js";
import { personalizeLead } from "../src/prospects/personalize.js";
import { extractProfile, profileToConfig, writeClientConfig } from "../src/demo-builder.js";

function parseArgs(argv) {
  const args = { top: 40 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (["enrich", "personalize", "demos"].includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  args.top = Number(args.top);
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !isValidSlug(args.batch ?? "")) {
  console.error("Usage: npm run prospects -- --input <outscraper.xlsx|csv|json> --batch <name> [--top 40] [--enrich] [--personalize] [--demos] [--demo-host https://your-server]");
  process.exit(1);
}
const demoHost = (args["demo-host"] || process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const outDir = path.join(process.env.DATA_DIR || path.join(ROOT_DIR, "data"), "prospects", args.batch);
const stateFile = path.join(outDir, "leads.json");
fs.mkdirSync(outDir, { recursive: true });

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

function slugify(name) {
  const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  let slug = base || "prospect";
  for (let n = 2; loadClientConfig(slug); n++) slug = `${base}-${n}`;
  return slug;
}

function save(leads) {
  fs.writeFileSync(stateFile, JSON.stringify(leads, null, 2));
}

// 1. Load and rank (free). Keep paid results from earlier runs of the same batch.
const previous = fs.existsSync(stateFile) ? new Map(JSON.parse(fs.readFileSync(stateFile, "utf8")).map((l) => [l.id, l])) : new Map();
const ranked = rankLeads(await loadOutscraperFile(args.input));
const leads = ranked.map((lead) => {
  const old = previous.get(lead.id);
  return old ? { ...lead, contact: old.contact, reviews_sample: old.reviews_sample, pitch: old.pitch, demo_slug: old.demo_slug } : lead;
});
const top = leads.filter((l) => !l.excluded && l.website).slice(0, args.top);
save(leads);
console.log(`${leads.length} negocios, ${leads.filter((l) => !l.excluded).length} dentro del nicho. Trabajando con los ${top.length} mejores con sitio web.`);

// 2. Contacts and reviews from Outscraper (paid).
if (args.enrich) {
  const outscraper = new OutscraperClient();
  const needContact = top.filter((l) => l.contact === undefined);
  if (needContact.length) {
    console.log(`Buscando contactos de ${needContact.length} dominios…`);
    const results = await outscraper.contactsFor(needContact.map((l) => l.domain));
    needContact.forEach((lead, i) => (lead.contact = pickContact(results[i])));
    save(leads);
  }
  const needReviews = top.filter((l) => l.reviews_sample === undefined);
  console.log(`Leyendo reseñas de ${needReviews.length} negocios…`);
  await mapLimit(needReviews, 3, async (lead) => {
    try {
      lead.reviews_sample = await outscraper.responsivenessReviews(lead.id);
    } catch (err) {
      console.error(`  reseñas de ${lead.name}: ${err.message}`);
    }
  });
  save(leads);
}

// 3. Personal first line with Claude (paid). Only for leads with an email.
if (args.personalize) {
  const todo = top.filter((l) => l.contact?.email && !l.pitch);
  console.log(`Personalizando ${todo.length} prospectos…`);
  await mapLimit(todo, 4, async (lead) => {
    try {
      lead.pitch = await personalizeLead(lead, lead.reviews_sample ?? []);
    } catch (err) {
      console.error(`  ${lead.name}: ${err.message}`);
    }
  });
  save(leads);
}

// 4. Demo per prospect, built from its website (paid). Skips weak fits.
if (args.demos) {
  const todo = top.filter((l) => l.pitch && l.pitch.fit !== "weak" && !l.demo_slug);
  console.log(`Creando ${todo.length} demos…`);
  await mapLimit(todo, 2, async (lead) => {
    try {
      const profile = await extractProfile(lead.website);
      if (!profile) throw new Error("no se pudo leer el sitio");
      const config = profileToConfig(profile, slugify(lead.name), lead.website);
      writeClientConfig(config);
      lead.demo_slug = config.slug;
    } catch (err) {
      console.error(`  demo de ${lead.name}: ${err.message}`);
    }
  });
  save(leads);
}

// 5. Exports: everything for your review, and the approved-looking subset for Instantly.
const demoLink = (l) => (l.demo_slug ? `${demoHost}/?client=${l.demo_slug}` : "");
const reviewRows = leads.map((l) => ({
  prioridad: l.priority ?? "fuera",
  puntaje: l.score,
  negocio: l.name,
  categoria: l.category,
  ciudad: l.city,
  resenas: l.reviews,
  calificacion: l.rating,
  telefono: l.phone,
  sitio: l.website,
  correo: l.contact?.email ?? "",
  tipo_correo: l.contact?.email_type ?? "",
  nombre: l.contact?.first_name ?? "",
  encaje: l.pitch?.fit ?? "",
  primera_linea: l.pitch?.first_line ?? "",
  citas_resenas: (l.pitch?.pain_quotes ?? []).join(" | "),
  nota: l.pitch?.note_es ?? "",
  demo: demoLink(l),
  motivos: l.reasons.join("; "),
  google_maps: l.maps_link,
}));
fs.writeFileSync(path.join(outDir, "revision.csv"), toCsv(reviewRows, Object.keys(reviewRows[0] ?? { prioridad: 1 })));

const ready = top.filter((l) => l.contact?.email && l.pitch && l.pitch.fit !== "weak");
const instantlyRows = ready.map((l) => ({
  email: l.contact.email,
  first_name: l.contact.first_name ?? "",
  company_name: l.name,
  website: l.website,
  city: l.city,
  personalization: l.pitch.first_line,
  demo_link: demoLink(l),
  spanish: l.pitch.spanish_angle ? "yes" : "no",
  phone: l.phone,
}));
const instantlyColumns = ["email", "first_name", "company_name", "website", "city", "personalization", "demo_link", "spanish", "phone"];
fs.writeFileSync(path.join(outDir, "instantly.csv"), toCsv(instantlyRows, instantlyColumns));

const withEmail = top.filter((l) => l.contact?.email).length;
console.log(`
Listo. Archivos en ${path.relative(ROOT_DIR, outDir)}/
  revision.csv   ${reviewRows.length} filas, con puntaje y motivos (revísalo antes de enviar)
  instantly.csv  ${instantlyRows.length} prospectos listos para subir a Instantly
De los ${top.length} mejores: ${withEmail} con correo, ${top.filter((l) => l.pitch).length} personalizados, ${top.filter((l) => l.demo_slug).length} con demo.`);
if (!args.enrich && !args.personalize) {
  console.log("Siguiente paso: agrega --enrich --personalize --demos (usan Outscraper y Claude, tienen costo).");
}
