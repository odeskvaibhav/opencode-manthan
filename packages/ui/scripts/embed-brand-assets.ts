import fs from "fs"
import path from "path"

const root = path.join(import.meta.dir, "../src/assets/brand")
const files = {
  monogramBadgeDark: "monogram/manthan-monogram-badge-dark.svg",
  monogramInverse: "monogram/manthan-monogram-inverse.svg",
  wordmarkInverse: "wordmark/manthan-wordmark-inverse.svg",
  loaderWordmarkSequenceFast: "loaders/manthan-loader-wordmark-sequence-fast.svg",
  faviconBase: "favicons/favicon-base.svg",
}

const lines = ["/** Auto-generated from src/assets/brand — run scripts/embed-brand-assets.ts */", ""]
for (const [name, rel] of Object.entries(files)) {
  const raw = fs.readFileSync(path.join(root, rel), "utf8").trim()
  lines.push(`export const ${name} = ${JSON.stringify(raw)}`, "")
}
const out = path.join(import.meta.dir, "../src/components/manthan-brand-assets.ts")
fs.writeFileSync(out, lines.join("\n"))
console.log("wrote", out)
