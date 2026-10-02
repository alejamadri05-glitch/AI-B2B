// Build a personalized demo for a prospect from their public website.
//
//   npm run new-prospect -- --url https://example-plumbing.com --slug example-plumbing
//
// Claude reads the site with the web fetch tool, extracts the business profile,
// and this script writes clients/<slug>.json from clients/_template.json.
// ALWAYS review the generated file before showing the demo to the prospect.
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, isValidSlug } from "../src/store.js";
import { extractProfile, profileToConfig, writeClientConfig } from "../src/demo-builder.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") args.force = true;
    else if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

const { url, slug, force } = parseArgs(process.argv.slice(2));
if (!url || !isValidSlug(slug)) {
  console.error("Usage: npm run new-prospect -- --url https://their-site.com --slug their-business [--force]");
  console.error("The slug must be lowercase letters, digits and dashes.");
  process.exit(1);
}
const outFile = path.join(ROOT_DIR, "clients", `${slug}.json`);
if (fs.existsSync(outFile) && !force) {
  console.error(`${outFile} already exists. Use --force to overwrite.`);
  process.exit(1);
}

const profile = await extractProfile(url);
if (!profile) {
  console.error("Could not extract a profile. Fill clients/_template.json by hand instead.");
  process.exit(1);
}
writeClientConfig(profileToConfig(profile, slug, url));
console.log(`Wrote ${path.relative(ROOT_DIR, outFile)}`);
if (profile.review_notes.length) {
  console.log("\nCheck these before showing the demo:");
  for (const note of profile.review_notes) console.log(`  - ${note}`);
}
if (!profile.zip_codes.length) console.log("  - No ZIP codes listed: the demo will accept any ZIP.");
console.log(`\nDemo: http://localhost:${process.env.PORT || 3000}/?client=${slug}`);
