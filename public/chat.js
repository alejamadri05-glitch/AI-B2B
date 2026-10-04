import { applyBrand } from "/brand.js";

const params = new URLSearchParams(location.search);
const slug = params.get("client") || "demo-hvac";
const embed = params.get("embed") === "1";
if (embed) document.body.classList.add("embed");

const $ = (id) => document.getElementById(id);
const messages = $("messages");
const input = $("input");
const sendBtn = $("send");

function sessionId() {
  const key = `receptionist-session:${slug}`;
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return (window.__sid ??= crypto.randomUUID());
  }
}

function addMessage(text, kind) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.textContent = text;
  messages.append(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

function showTyping() {
  const div = addMessage("", "in");
  div.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  return div;
}

function profileFailed(message) {
  document.body.classList.add("ready");
  $("avatar").classList.add("offline");
  $("dashboard-link").closest("p").hidden = true;
  $("business-name").textContent = "Chat unavailable";
  $("agent-line").textContent = "";
  addMessage(message, "error");
  input.disabled = sendBtn.disabled = true;
}

async function loadProfile() {
  input.disabled = sendBtn.disabled = true;
  const typing = showTyping();
  let res;
  try {
    res = await fetch(`/api/clients/${encodeURIComponent(slug)}`);
  } catch {
    typing.remove();
    return profileFailed("Connection problem. Please check your internet and reload the page.");
  }
  typing.remove();
  if (!res.ok) return profileFailed(`No configuration found for "${slug}".`);
  const p = await res.json();
  document.title = `${p.business_name} · AI Receptionist`;
  applyBrand(p.brand_color);
  $("business-name").textContent = p.business_name;
  $("agent-line").textContent = `${p.agent_name} · Virtual assistant · replies instantly`;
  $("avatar").textContent = (p.agent_name || "A").charAt(0);
  $("demo-badge").hidden = !p.demo;
  if (p.phone) {
    const tel = `tel:${p.phone.replace(/[^\d+]/g, "")}`;
    $("header-call").href = $("call-link").href = tel;
    $("header-call").title = `Call ${p.phone}`;
    $("call-number").textContent = p.phone;
    $("header-call").hidden = false;
  }
  if (p.demo) {
    $("intro-title").textContent = `${p.business_name}'s 24/7 AI receptionist`;
    // The demo dashboard shows this visitor only their own chat.
    $("dashboard-link").href = `/dashboard.html?client=${encodeURIComponent(slug)}&session=${encodeURIComponent(sessionId())}`;
  } else {
    // A real client's page is for their customers, not a sales demo.
    document.title = p.business_name;
    $("intro-title").textContent = p.business_name;
    $("intro-text").textContent = "Questions, a quote or a service visit? Chat with us any time: we reply in seconds and can book your appointment.";
    $("dashboard-link").closest("p").hidden = true;
    $("features-demo").hidden = true;
    $("features-customer").hidden = false;
    $("call-line").hidden = !p.phone;
  }
  document.body.classList.add("ready");
  addMessage(p.greeting, "in");
  input.disabled = sendBtn.disabled = false;
  if (!embed && matchMedia("(pointer: fine)").matches) input.focus();
}

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addMessage(text, "out");
  input.disabled = sendBtn.disabled = true;
  const typing = showTyping();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: slug, session_id: sessionId(), message: text }),
    });
    const data = await res.json();
    typing.remove();
    if (res.ok) addMessage(data.reply, "in");
    else addMessage(data.error || "Something went wrong.", "error");
  } catch {
    typing.remove();
    addMessage("Connection problem. Please try again.", "error");
  } finally {
    input.disabled = sendBtn.disabled = false;
    input.focus();
  }
});

loadProfile();
