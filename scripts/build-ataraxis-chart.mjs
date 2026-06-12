// One-off: build the Ataraxis charte graphique JSON (oklch) from the brand RGB
// palette harvested off ataraxis-coaching.com, then VALIDATE it through the real
// import allowlist so we know the import will pass. Not shipped.
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- sRGB(0-255) -> OKLCH (Björn Ottosson) -------------------------------
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function rgb2oklch(r, g, b) {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  let C = Math.sqrt(a * a + bb * bb);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  const round = (x, n) => {
    const v = Number(x.toFixed(n));
    return Number.isInteger(v) ? String(v) : String(v);
  };
  // Near-neutral: clamp tiny chroma + hue noise to a stable hue.
  if (C < 0.004) { C = 0; H = 0; }
  return `oklch(${round(L, 3)} ${round(C, 3)} ${round(H, 1)})`;
}

const conv = (map) =>
  Object.fromEntries(Object.entries(map).map(([k, [r, g, b]]) => [k, rgb2oklch(r, g, b)]));

const light = conv({
  background: [251, 247, 236], foreground: [45, 47, 37],
  card: [254, 251, 245], "card-foreground": [45, 47, 37],
  popover: [254, 251, 245], "popover-foreground": [45, 47, 37],
  primary: [103, 107, 86], "primary-foreground": [251, 247, 236],
  secondary: [244, 237, 227], "secondary-foreground": [45, 47, 37],
  muted: [244, 237, 227], "muted-foreground": [97, 97, 87],
  accent: [177, 211, 187], "accent-foreground": [43, 83, 54],
  destructive: [237, 28, 36], "destructive-foreground": [251, 247, 236],
  border: [200, 197, 186], input: [200, 197, 186], ring: [103, 107, 86],
  "chart-1": [103, 107, 86], "chart-2": [64, 124, 81], "chart-3": [181, 171, 158],
  "chart-4": [127, 168, 139], "chart-5": [237, 28, 36],
  sidebar: [244, 237, 227], "sidebar-foreground": [45, 47, 37],
  "sidebar-primary": [103, 107, 86], "sidebar-primary-foreground": [251, 247, 236],
  "sidebar-accent": [177, 211, 187], "sidebar-accent-foreground": [43, 83, 54],
  "sidebar-border": [200, 197, 186], "sidebar-ring": [103, 107, 86],
});
const dark = conv({
  background: [26, 31, 23], foreground: [244, 237, 227],
  card: [45, 47, 37], "card-foreground": [244, 237, 227],
  popover: [45, 47, 37], "popover-foreground": [244, 237, 227],
  primary: [177, 211, 187], "primary-foreground": [21, 41, 27],
  secondary: [58, 62, 50], "secondary-foreground": [244, 237, 227],
  muted: [58, 62, 50], "muted-foreground": [200, 197, 186],
  accent: [64, 124, 81], "accent-foreground": [244, 237, 227],
  destructive: [235, 87, 87], "destructive-foreground": [21, 41, 27],
  border: [74, 78, 62], input: [74, 78, 62], ring: [177, 211, 187],
  "chart-1": [177, 211, 187], "chart-2": [127, 168, 139], "chart-3": [181, 171, 158],
  "chart-4": [64, 124, 81], "chart-5": [243, 167, 143],
  sidebar: [45, 47, 37], "sidebar-foreground": [244, 237, 227],
  "sidebar-primary": [177, 211, 187], "sidebar-primary-foreground": [21, 41, 27],
  "sidebar-accent": [64, 124, 81], "sidebar-accent-foreground": [244, 237, 227],
  "sidebar-border": [74, 78, 62], "sidebar-ring": [177, 211, 187],
});

const chart = {
  name: "Ataraxis",
  tokens: {
    colors: { light, dark },
    radius: "0.5rem",
    fontSans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
};

// --- Validate through the REAL allowlist ---------------------------------
const dir = mkdtempSync(join(tmpdir(), "atarax-"));
const out = join(dir, "v.mjs");
await build({
  entryPoints: ["convex/lib/chartValidation.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
});
const { validateChartImport } = await import(out);
const res = validateChartImport(chart);

// Two artifacts: the full {name, tokens} reference, and the TOKENS-ONLY file —
// the import UI's textarea takes tokens only (name is a separate form field);
// pasting the wrapped form there fails with "Unknown token field: name".
writeFileSync("ataraxis-chart.json", JSON.stringify(chart, null, 2) + "\n");
writeFileSync("ataraxis-tokens.json", JSON.stringify(chart.tokens, null, 2) + "\n");
console.log("=== validateChartImport ===");
console.log("ok:", res.ok, res.ok ? "" : res.error);
console.log("name:", res.ok ? res.name : "-");
console.log("light tokens:", res.ok ? Object.keys(res.tokens.colors.light).length : 0);
console.log("dark tokens:", res.ok ? Object.keys(res.tokens.colors.dark).length : 0);
console.log("\n=== written: ataraxis-tokens.json (PASTE THIS in the import textarea; name goes in the name field)");
console.log("===          ataraxis-chart.json (full {name, tokens} reference, NOT pasteable as-is)");
console.log("preview (light primary/background, dark background):");
console.log("light.background =", chart.tokens.colors.light.background);
console.log("light.primary    =", chart.tokens.colors.light.primary);
console.log("dark.background  =", chart.tokens.colors.dark.background);
console.log("dark.primary     =", chart.tokens.colors.dark.primary);
