#!/usr/bin/env node
/**
 * Minimal VSIX packager (no @vscode/vsce).
 * Reads sdks/vscode/package.json + .vscodeignore patterns (simple globs).
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const EXT = path.join(ROOT, "sdks/vscode")
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"))

const outName = `${pkg.name}-${pkg.version}.vsix`
const outPath = path.join(EXT, outName)

function ignored(rel) {
  const n = rel.replace(/\\/g, "/")
  if (n.startsWith("node_modules/")) return true
  if (n.startsWith(".vscode/") || n.startsWith(".vscode-test/")) return true
  if (n.startsWith("out/") || n.startsWith("src/")) return true
  if (n.startsWith("script/")) return true
  if (n === ".gitignore" || n === ".yarnrc" || n === "bun.lock" || n === "esbuild.js") return true
  if (n.endsWith("tsconfig.json") || n.endsWith("eslint.config.mjs")) return true
  if (n.endsWith(".map") || n.endsWith(".ts") || n.endsWith(".vsix")) return true
  if (n.includes(".vscode-test.")) return true
  if (n === "vsc-extension-quickstart.md") return true
  return false
}

function walk(dir, base = dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git") continue
    const abs = path.join(dir, ent.name)
    const rel = path.relative(base, abs)
    if (ignored(rel)) continue
    if (ent.isDirectory()) walk(abs, base, acc)
    else acc.push(rel)
  }
  return acc
}

const files = walk(EXT)
if (!files.includes("dist/extension.js")) {
  console.error("missing dist/extension.js — run: node esbuild.js --production")
  process.exit(1)
}
if (!files.includes("package.json")) {
  console.error("missing package.json")
  process.exit(1)
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "manthan-vsix-"))
const extRoot = path.join(staging, "extension")
fs.mkdirSync(extRoot, { recursive: true })

for (const rel of files) {
  const dest = path.join(extRoot, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(path.join(EXT, rel), dest)
}

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${escapeXml(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description || "")}</Description>
    <Tags></Tags>
    <Categories>${escapeXml((pkg.categories || ["Other"]).join(","))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(pkg.engines?.vscode || "^1.94.0")}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
    ${pkg.icon ? `<Icon>extension/${pkg.icon}</Icon>` : ""}
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    ${fs.existsSync(path.join(extRoot, "README.md")) ? `<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />` : ""}
    ${pkg.icon ? `<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${pkg.icon}" Addressable="true" />` : ""}
  </Assets>
</PackageManifest>
`

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="css" ContentType="text/css" />
</Types>
`

fs.writeFileSync(path.join(staging, "extension.vsixmanifest"), manifest)
fs.writeFileSync(path.join(staging, "[Content_Types].xml"), contentTypes)

if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
const zip = spawnSync(
  "zip",
  ["-r", "-q", outPath, "extension.vsixmanifest", "[Content_Types].xml", "extension"],
  { cwd: staging, stdio: "inherit" },
)
fs.rmSync(staging, { recursive: true, force: true })
if (zip.status !== 0) {
  console.error("zip failed")
  process.exit(zip.status ?? 1)
}
console.log(outPath)

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
