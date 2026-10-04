// Embeddable chat bubble. Install on a client's website with:
//   <script src="https://YOUR-HOST/widget.js" data-client="client-slug" defer></script>
(() => {
  const script = document.currentScript;
  const slug = script?.dataset.client;
  if (!slug) return console.warn("[receptionist] data-client is missing on the widget script tag");
  const host = new URL(script.src).origin;
  const color = /^#[0-9a-f]{6}$/i.test(script.dataset.color || "") ? script.dataset.color : "#1f6feb";

  // Black or white icon, whichever has more contrast on the brand color.
  const lum = [1, 3, 5]
    .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ink = 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.06 ? "#ffffff" : "#18181b";

  // Icons: Phosphor "chat-circle-dots" and "x" (regular), MIT License.
  const ICON_CHAT = "<svg viewBox=\"0 0 256 256\" width=\"28\" height=\"28\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128ZM84,116a12,12,0,1,0,12,12A12,12,0,0,0,84,116Zm88,0a12,12,0,1,0,12,12A12,12,0,0,0,172,116Zm60,12A104,104,0,0,1,79.12,219.82L45.07,231.17a16,16,0,0,1-20.24-20.24l11.35-34.05A104,104,0,1,1,232,128Zm-16,0A88,88,0,1,0,51.81,172.06a8,8,0,0,1,.66,6.54L40,216,77.4,203.53a7.85,7.85,0,0,1,2.53-.42,8,8,0,0,1,4,1.08A88,88,0,0,0,216,128Z\"/></svg>";
  const ICON_CLOSE = "<svg viewBox=\"0 0 256 256\" width=\"28\" height=\"28\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z\"/></svg>";

  const id = "ai-receptionist";
  const style = document.createElement("style");
  style.textContent = `
    #${id}-button { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; width: 60px; height: 60px;
      margin: 0; padding: 0; border: 0; border-radius: 50%; background: ${color}; color: ${ink}; cursor: pointer;
      display: grid; place-items: center; box-shadow: 0 2px 4px rgb(0 0 0 / .12), 0 10px 28px -6px rgb(0 0 0 / .35);
      transition: transform .15s ease; }
    #${id}-button:hover { transform: scale(1.05); }
    #${id}-button:active { transform: scale(.95); }
    #${id}-button:focus-visible { outline: 3px solid ${color}; outline-offset: 3px; }
    #${id}-frame { position: fixed; right: 20px; bottom: 92px; z-index: 2147483647; width: 380px; height: min(620px, calc(100vh - 120px));
      max-width: calc(100vw - 40px); border: 0; border-radius: 16px; background: #fff; color-scheme: normal;
      box-shadow: 0 2px 6px rgb(0 0 0 / .08), 0 24px 60px -12px rgb(0 0 0 / .35);
      opacity: 0; transform: translateY(12px) scale(.98); transform-origin: bottom right; pointer-events: none;
      transition: opacity .18s ease, transform .18s ease; }
    #${id}-frame.open { opacity: 1; transform: none; pointer-events: auto; }
    @media (max-width: 480px) {
      #${id}-frame { right: 8px; bottom: 88px; width: calc(100vw - 16px); max-width: none; height: calc(100dvh - 100px); }
      #${id}-button { right: 16px; bottom: 16px; }
    }
    @media (prefers-reduced-motion: reduce) { #${id}-button, #${id}-frame { transition: none; } }
  `;

  const button = document.createElement("button");
  button.type = "button";
  button.id = `${id}-button`;
  button.setAttribute("aria-label", "Chat with us");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = ICON_CHAT;

  // The chat loads on first open, so visitors who never open it cost nothing.
  let frame;
  function setOpen(open) {
    if (open && !frame) {
      frame = document.createElement("iframe");
      frame.id = `${id}-frame`;
      frame.title = "Chat";
      frame.allow = "clipboard-write";
      frame.src = `${host}/?client=${encodeURIComponent(slug)}&embed=1`;
      document.body.append(frame);
      frame.getBoundingClientRect(); // so the first open animates
    }
    if (!frame) return;
    frame.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close chat" : "Chat with us");
    button.innerHTML = open ? ICON_CLOSE : ICON_CHAT;
  }

  button.addEventListener("click", () => setOpen(!frame?.classList.contains("open")));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && frame?.classList.contains("open")) {
      setOpen(false);
      button.focus();
    }
  });

  document.head.append(style);
  document.body.append(button);
})();
