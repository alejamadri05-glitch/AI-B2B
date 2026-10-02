const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const invite = new URLSearchParams(location.search).get("invite") || "";
const draftKey = `onboarding-draft:${invite}`;
const $ = (id) => document.getElementById(id);
const form = $("form");

const LISTS = {
  services: [
    { name: "name", label: "Service", placeholder: "AC repair" },
    { name: "description", label: "One-line description", placeholder: "Diagnosis and repair of all major brands" },
  ],
  arrival_windows: [
    { name: "label", label: "Window", placeholder: "8-11 AM" },
    { name: "start_hour", label: "Starts at (hour)", placeholder: "8", type: "number" },
  ],
  faqs: [
    { name: "q", label: "Question", placeholder: "Do you offer financing?" },
    { name: "a", label: "Answer", placeholder: "Yes, with approved credit…", textarea: true },
  ],
};

function addRow(listName, values = {}) {
  const row = document.createElement("div");
  row.className = "list-row";
  for (const f of LISTS[listName]) {
    const label = document.createElement("label");
    label.textContent = f.label;
    const input = document.createElement(f.textarea ? "textarea" : "input");
    if (!f.textarea) input.type = f.type || "text";
    if (f.textarea) input.rows = 2;
    input.dataset.field = f.name;
    input.placeholder = f.placeholder;
    input.value = values[f.name] ?? "";
    label.append(input);
    row.append(label);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    row.remove();
    saveDraft();
  });
  row.append(remove);
  $(listName).append(row);
}

function buildStatic() {
  for (const day of DAYS) {
    const weekend = day === "Saturday" || day === "Sunday";
    const row = document.createElement("div");
    row.className = "hours-row";
    row.dataset.day = day;
    row.innerHTML = `<label class="check"><input type="checkbox" data-part="open" ${weekend ? "" : "checked"}> ${day}</label>
      <input type="time" data-part="from" value="08:00" aria-label="${day} opens"> <span class="muted">to</span>
      <input type="time" data-part="to" value="17:00" aria-label="${day} closes">
      <span class="field-error" data-error="office_hours.${day}"></span>`;
    $("hours").append(row);

    const closed = document.createElement("label");
    closed.className = "check";
    closed.innerHTML = `<input type="checkbox" value="${day}" ${day === "Sunday" ? "checked" : ""}> ${day}`;
    $("closed_days").append(closed);
  }
  for (const btn of document.querySelectorAll("[data-add]")) btn.addEventListener("click", () => addRow(btn.dataset.add));
}

function collect() {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    data[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  data.office_hours = Object.fromEntries(
    [...document.querySelectorAll(".hours-row")].map((row) => [
      row.dataset.day,
      {
        open: row.querySelector('[data-part="open"]').checked,
        from: row.querySelector('[data-part="from"]').value,
        to: row.querySelector('[data-part="to"]').value,
      },
    ]),
  );
  data.closed_days = [...$("closed_days").querySelectorAll("input:checked")].map((i) => i.value);
  for (const list of Object.keys(LISTS)) {
    data[list] = [...$(list).querySelectorAll(".list-row")].map((row) =>
      Object.fromEntries([...row.querySelectorAll("[data-field]")].map((i) => [i.dataset.field, i.value])),
    );
  }
  return data;
}

function fill(data) {
  for (const el of form.elements) {
    if (!el.name || data[el.name] === undefined || data[el.name] === null) continue;
    if (el.type === "checkbox") el.checked = Boolean(data[el.name]);
    else el.value = data[el.name];
  }
  if (data.office_hours) {
    for (const row of document.querySelectorAll(".hours-row")) {
      const d = data.office_hours[row.dataset.day];
      if (!d) continue;
      row.querySelector('[data-part="open"]').checked = Boolean(d.open);
      if (d.from) row.querySelector('[data-part="from"]').value = d.from;
      if (d.to) row.querySelector('[data-part="to"]').value = d.to;
    }
  }
  if (Array.isArray(data.closed_days)) {
    for (const i of $("closed_days").querySelectorAll("input")) i.checked = data.closed_days.includes(i.value);
  }
  for (const list of Object.keys(LISTS)) {
    if (!Array.isArray(data[list]) || !data[list].length) continue;
    $(list).replaceChildren();
    data[list].forEach((values) => addRow(list, values));
  }
}

function saveDraft() {
  try {
    localStorage.setItem(draftKey, JSON.stringify(collect()));
  } catch {
    // Storage blocked (private mode): the form still works, it just won't remember.
  }
}

function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(draftKey) || "null");
  } catch {
    return null;
  }
}

function showBanner(text, isError = false) {
  const b = $("banner");
  b.textContent = text;
  b.classList.toggle("error", isError);
  b.hidden = false;
}

function showErrors(errors = {}) {
  for (const el of document.querySelectorAll("[data-error]")) el.textContent = errors[el.dataset.error] ?? "";
  const messages = Object.values(errors);
  $("error-summary").hidden = !messages.length;
  $("error-summary").textContent = messages.length ? `Please fix ${messages.length} item${messages.length > 1 ? "s" : ""}: ${messages.join(" · ")}` : "";
  const first = document.querySelector(".field-error:not(:empty)");
  first?.closest("fieldset")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function init() {
  buildStatic();
  const res = await fetch(`/api/onboarding/${encodeURIComponent(invite)}`);
  if (!res.ok) {
    showBanner("This setup link is not valid. Please check the link in your email.", true);
    return;
  }
  const data = await res.json();
  $("title").textContent = `Set up the AI receptionist for ${data.business_name}`;
  if (["testing", "review", "live"].includes(data.status)) {
    showBanner(
      data.status === "live"
        ? "Your assistant is live. Check your email for the install code and your dashboard link."
        : "Thanks! We received your answers and are testing your assistant. We'll email you when it's ready.",
    );
    return;
  }
  if (data.status === "changes_requested" && data.changes_requested) {
    showBanner(`A few changes are needed before we launch: ${data.changes_requested}`);
  }
  if (data.status === "prefilling") showBanner("We're pre-filling this form from your website. Refresh in a minute, or start typing.");

  // Defaults, then what we know (website prefill or last submission), then this browser's draft.
  addRow("services");
  [["8-11 AM", 8], ["11 AM-2 PM", 11], ["2-5 PM", 14]].forEach(([label, start_hour]) => addRow("arrival_windows", { label, start_hour }));
  fill(data.form || {});
  const draft = loadDraft();
  if (draft) fill(draft);
  form.hidden = false;
  form.addEventListener("input", saveDraft);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  try {
    const payload = collect();
    payload.avg_ticket = payload.avg_ticket === "" ? 0 : Number(payload.avg_ticket);
    const res = await fetch(`/api/onboarding/${encodeURIComponent(invite)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      try {
        localStorage.removeItem(draftKey);
      } catch {}
      form.hidden = true;
      $("error-summary").hidden = true;
      showBanner("Thanks! We received your answers and are testing your assistant now. We'll email you when it's ready to install.");
      scrollTo({ top: 0, behavior: "smooth" });
    } else if (data.errors) {
      showErrors(data.errors);
    } else {
      showBanner(data.error || "Something went wrong. Please try again.", true);
    }
  } catch {
    showBanner("Connection problem. Your answers are saved here; please try again.", true);
  } finally {
    $("submit").disabled = false;
  }
});

init();
