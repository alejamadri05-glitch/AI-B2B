// Create an onboarding invite for a new client, or list the existing ones.
//
//   npm run onboard -- --business "Bayou Plumbing" --email owner@bayouplumbing.com --website https://bayouplumbing.com
//   npm run onboard -- --list
//
// Send the form link to the client. The review link is only for you.
// With --website, Claude pre-fills the form from the site (takes about a minute).
import "../src/env.js";
import { createInvite, links, listInvites, profileToForm } from "../src/onboarding.js";
import { extractProfile } from "../src/demo-builder.js";

const argv = process.argv.slice(2);
const value = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);

if (argv.includes("--list")) {
  const invites = listInvites().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (!invites.length) console.log("No hay invitaciones todavía.");
  for (const i of invites) {
    const qa = i.qa && !i.qa.error ? ` · pruebas ${i.qa.passed}/${i.qa.total}` : "";
    console.log(`${i.status.padEnd(18)} ${i.business_name}${qa}\n${"".padEnd(19)}${links(i).review}`);
  }
  process.exit(0);
}

const business = value("business");
if (!business) {
  console.error('Usage: npm run onboard -- --business "Name" [--email owner@x.com] [--website https://...] | --list');
  process.exit(1);
}
const website = value("website");
const prefill = website && !argv.includes("--no-prefill")
  ? async (url) => {
      const profile = await extractProfile(url);
      if (!profile) throw new Error("Could not read the website");
      return profileToForm(profile);
    }
  : null;

const { invite, ready } = createInvite({ business_name: business, contact_email: value("email"), website }, { prefill });
if (prefill) console.log("Prellenando el formulario desde el sitio web…");
await ready;
const l = links(invite);
console.log(`
Invitación creada para ${invite.business_name} (${invite.slug})
  Formulario para el cliente: ${l.form}
  Tu página de revisión:      ${l.review}`);
