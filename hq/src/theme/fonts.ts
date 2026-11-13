// UI font styles for panels, drawers and settings. The office
// canvas keeps its pixel font. Saved per browser, not in the project config,
// because it's a personal choice, not a team setting.

export type FontStyle = "pixel" | "clean" | "mono";

export const FONT_STYLES: { id: FontStyle; label: string; hint: string }[] = [
  { id: "pixel", label: "Pixel", hint: "Pixelify Sans, the game look" },
  { id: "clean", label: "Clean", hint: "Inter, easiest to read" },
  { id: "mono", label: "Mono", hint: "JetBrains Mono, like a terminal" },
];

const KEY = "fleet.font";
export const FONT_EVENT = "fleet:font";

export function savedFont(): FontStyle {
  try {
    const v = localStorage.getItem(KEY);
    return FONT_STYLES.some((f) => f.id === v) ? (v as FontStyle) : "pixel";
  } catch {
    return "pixel";
  }
}

export function applyFont(font: FontStyle) {
  if (font === "pixel") delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = font;
}

export function setFont(font: FontStyle) {
  applyFont(font);
  window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: font }));
  try {
    localStorage.setItem(KEY, font);
  } catch {
    /* private window: still applies until reload */
  }
}
