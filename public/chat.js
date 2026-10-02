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

async function loadProfile() {
  const res = await fetch(`/api/clients/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    $("business-name").textContent = "Unknown business";
    addMessage(`No configuration found for "${slug}".`, "error");
    input.disabled = sendBtn.disabled = true;
    return;
  }
  const p = await res.json();
  document.title = `${p.business_name} · AI Receptionist`;
  document.documentElement.style.setProperty("--brand", p.brand_color || "#1f6feb");
  $("business-name").textContent = p.business_name;
  $("agent-line").textContent = `${p.agent_name} · Virtual assistant · replies instantly`;
  $("avatar").textContent = (p.agent_name || "A").charAt(0);
  $("intro-title").textContent = `${p.business_name}'s 24/7 AI receptionist`;
  $("demo-badge").hidden = !p.demo;
  $("dashboard-link").href = `/dashboard.html?client=${encodeURIComponent(slug)}`;
  addMessage(p.greeting, "in");
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
