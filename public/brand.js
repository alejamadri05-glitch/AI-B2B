// Per-client accent color. Text on the accent is black or white, whichever reads better (WCAG contrast).
const DEFAULT = "#1f6feb";

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function applyBrand(color) {
  const brand = /^#[0-9a-f]{6}$/i.test(color || "") ? color : DEFAULT;
  const l = luminance(brand);
  const onWhite = 1.05 / (l + 0.05);
  const onInk = (l + 0.05) / 0.06;
  const root = document.documentElement.style;
  root.setProperty("--brand", brand);
  root.setProperty("--on-brand", onWhite >= onInk ? "#ffffff" : "#18181b");
}
