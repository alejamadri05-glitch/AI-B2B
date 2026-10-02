// Embeddable chat bubble. Install on a client's website with:
//   <script src="https://YOUR-HOST/widget.js" data-client="client-slug" defer></script>
(() => {
  const script = document.currentScript;
  const slug = script?.dataset.client;
  if (!slug) return console.warn("[receptionist] data-client is missing on the widget script tag");
  const host = new URL(script.src).origin;
  const color = script.dataset.color || "#1f6feb";

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Chat with us");
  button.innerHTML =
    '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  Object.assign(button.style, {
    position: "fixed", right: "20px", bottom: "20px", width: "60px", height: "60px",
    borderRadius: "50%", border: "0", background: color, cursor: "pointer",
    boxShadow: "0 6px 20px rgba(0,0,0,.25)", zIndex: "2147483646",
    display: "grid", placeItems: "center",
  });

  const frame = document.createElement("iframe");
  frame.title = "Chat";
  frame.src = `${host}/?client=${encodeURIComponent(slug)}&embed=1`;
  Object.assign(frame.style, {
    position: "fixed", right: "20px", bottom: "92px", width: "min(380px, calc(100vw - 40px))",
    height: "min(600px, calc(100vh - 120px))", border: "0", borderRadius: "16px",
    boxShadow: "0 12px 40px rgba(0,0,0,.25)", zIndex: "2147483647", display: "none",
    background: "#fff",
  });

  button.addEventListener("click", () => {
    frame.style.display = frame.style.display === "none" ? "block" : "none";
  });

  document.body.append(frame, button);
})();
