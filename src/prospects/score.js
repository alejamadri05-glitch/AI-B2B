// Rule-based lead scoring for Outscraper Google Maps rows. Free and instant:
// it decides which businesses are worth paying to enrich and personalize.
// Every point comes with a reason in Spanish so the ranking can be audited.

export const METROS = {
  houston: { name: "Houston", lat: 29.7604, lng: -95.3698, radiusKm: 65 },
  "san-antonio": { name: "San Antonio", lat: 29.4241, lng: -98.4936, radiusKm: 50 },
};

// Google Maps categories by how well the receptionist fits them.
// A: urgent, phone-driven work. B: home services with steady inbound calls.
// C: project work with fewer urgent calls. Anything else is excluded.
const TRADE_TIERS = {
  A: [
    "HVAC contractor",
    "Air conditioning contractor",
    "Air conditioning repair service",
    "Heating contractor",
    "Furnace repair service",
    "Plumber",
    "Drainage service",
    "Water heater installation service",
    "Water damage restoration service",
    "Septic system service",
  ],
  B: [
    "Electrician",
    "Electrical installation service",
    "Electrical repair shop",
    "Roofing contractor",
    "Garage door repair service",
    "Air duct cleaning service",
    "Appliance repair service",
  ],
  C: [
    "General contractor",
    "Contractor",
    "Remodeler",
    "Bathroom remodeler",
    "Kitchen remodeler",
    "Siding contractor",
    "Gutter service",
    "Window installation service",
    "Waterproofing service",
    "Insulation contractor",
    "Handyman/Handywoman/Handyperson",
    "Fire damage restoration service",
  ],
};
const TRADE_POINTS = { A: 30, B: 22, C: 10 };

// National franchises and big brands usually run their own call centers.
const BIG_BRANDS = [
  "roto-rooter",
  "mr. rooter",
  "mister sparky",
  "mr. electric",
  "benjamin franklin plumbing",
  "one hour heating",
  "aire serv",
  "service experts",
  "ars rescue rooter",
];

const SPANISH_NAME_WORDS = /\b(plomer[oi]a?|electricista|techos|construcci[oó]n(es)?|servicios|hermanos)\b/i;

export const MAX_REVIEWS = 1500;

function tierOf(row) {
  const categories = [row.type, ...String(row.subtypes ?? "").split(",")].map((s) => String(s ?? "").trim());
  // The primary category decides; a secondary category only lifts it within the allowed tiers.
  const primary = categories[0];
  const primaryTier = Object.keys(TRADE_TIERS).find((t) => TRADE_TIERS[t].includes(primary));
  if (!primaryTier) return null;
  return Object.keys(TRADE_TIERS).find((t) => categories.some((c) => TRADE_TIERS[t].includes(c)));
}

function parseJson(value) {
  if (!value || typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function cleanWebsite(url) {
  if (!url) return null;
  let s = String(url).trim();
  // Outscraper sometimes keeps tracking params URL-encoded in the path (…/%3Futm_source%3D…).
  s = s.split(/%3F|\?/i)[0];
  try {
    const u = new URL(s);
    return { url: `${u.protocol}//${u.host}${u.pathname}`, domain: u.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function metroOf(row, metros) {
  const lat = Number(row.latitude);
  const lng = Number(row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return metros.find((m) => distanceKm(lat, lng, m.lat, m.lng) <= m.radiusKm) ?? null;
}

export function normalizeLead(row, metros) {
  const site = cleanWebsite(row.website);
  const hours = parseJson(row.working_hours);
  const about = parseJson(row.about);
  const reviews = Number(row.reviews) || 0;
  return {
    id: row.place_id || row.google_id || `${row.name}|${row.phone}`,
    google_id: row.google_id ?? null,
    name: row.name,
    category: row.type ?? null,
    subtypes: row.subtypes ?? "",
    tier: tierOf(row),
    metro: metroOf(row, metros)?.name ?? null,
    city: row.city ?? null,
    state: row.state_code ?? row.state ?? null,
    postal_code: row.postal_code ? String(row.postal_code) : null,
    phone: row.phone ?? null,
    website: site?.url ?? null,
    domain: site?.domain ?? null,
    rating: Number(row.rating) || null,
    reviews,
    one_star: Number(row.reviews_per_score_1) || 0,
    hours_24: Boolean(hours && Object.values(hours).length === 7 && Object.values(hours).every((d) => String(d).includes("24 hours"))),
    latino_owned: Boolean(about?.Other?.["Identifies as Latino-owned"]),
    has_booking_link: Boolean(row.booking_appointment_link),
    status: row.business_status ?? null,
    maps_link: row.location_link ?? null,
  };
}

// Returns { score, reasons, excluded } for one normalized lead.
export function scoreLead(lead) {
  const reasons = [];
  const exclude = (why) => ({ score: 0, reasons: [why], excluded: why });

  if (lead.status && lead.status !== "OPERATIONAL") return exclude("No está operando");
  if (!lead.metro) return exclude("Fuera de Houston y San Antonio");
  if (!lead.tier) return exclude(`Categoría fuera del nicho (${lead.category ?? "sin categoría"})`);
  if (!lead.phone) return exclude("Sin teléfono");
  if (lead.reviews > MAX_REVIEWS) return exclude(`Empresa grande (${lead.reviews} reseñas): seguro tiene call center`);
  if (BIG_BRANDS.some((b) => lead.name.toLowerCase().includes(b))) return exclude("Franquicia nacional");

  let score = TRADE_POINTS[lead.tier];
  reasons.push(`Nicho ${lead.tier} (${lead.category})`);

  if (lead.reviews >= 20 && lead.reviews <= 400) {
    score += 25;
    reasons.push(`Tamaño ideal (${lead.reviews} reseñas)`);
  } else if (lead.reviews >= 5) {
    score += lead.reviews > 400 ? 12 : 10;
    reasons.push(`${lead.reviews} reseñas`);
  } else {
    reasons.push(`Muy pocas reseñas (${lead.reviews}): negocio pequeño o nuevo`);
  }

  if (lead.website) {
    score += 10;
    reasons.push("Tiene sitio web para instalar el chat");
  } else {
    reasons.push("Sin sitio web: solo aplicaría SMS");
  }

  if (lead.hours_24) {
    score += 10;
    reasons.push("Dice abrir 24 horas: necesita contestar fuera de horario");
  }

  if (lead.latino_owned || SPANISH_NAME_WORDS.test(lead.name)) {
    score += 8;
    reasons.push("Señales de clientela hispana: ofrecer el bot en español");
  }

  if (lead.reviews >= 20 && lead.one_star / lead.reviews >= 0.05) {
    score += 5;
    reasons.push(`${lead.one_star} reseñas de 1 estrella: revisar si son por falta de respuesta`);
  }

  if (lead.has_booking_link) {
    score -= 5;
    reasons.push("Ya tiene un enlace para agendar en línea");
  }

  if (lead.rating && lead.rating < 3.8) {
    score -= 10;
    reasons.push(`Calificación baja (${lead.rating})`);
  }

  return { score, reasons, excluded: null };
}

export function priorityOf(score) {
  return score >= 60 ? "A" : score >= 40 ? "B" : "C";
}

// Normalizes, de-duplicates (same place or same website) and ranks the rows.
export function rankLeads(rows, metroKeys = Object.keys(METROS)) {
  const metros = metroKeys.map((k) => METROS[k]);
  const seen = new Set();
  const leads = [];
  for (const row of rows) {
    if (!row?.name) continue;
    const lead = normalizeLead(row, metros);
    const keys = [lead.id, lead.domain].filter(Boolean);
    const duplicate = keys.some((k) => seen.has(k));
    keys.forEach((k) => seen.add(k));
    const result = duplicate ? { score: 0, reasons: ["Duplicado"], excluded: "Duplicado" } : scoreLead(lead);
    leads.push({ ...lead, ...result, priority: result.excluded ? null : priorityOf(result.score) });
  }
  return leads.sort((a, b) => (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0) || b.score - a.score || b.reviews - a.reviews);
}
