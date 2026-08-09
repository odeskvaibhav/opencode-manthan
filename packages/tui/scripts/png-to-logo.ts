import fs from "fs"
import path from "path"

/** Source of truth: manthan-loader-wordmark-sequence-fast.svg */
const svgPath = path.join(import.meta.dir, "../assets/loaders/manthan-loader-wordmark-sequence-fast.svg")
const svg = fs.readFileSync(svgPath, "utf8")

const STEP = 20
const LETTER_ORIGINS = [16, 128, 240, 352, 464, 576, 688]
const LETTER_PITCH = 6
const INK = "#F5F5F5"
const ACCENT = "#C6FF00"

function colOf(x: number): number | null {
  for (let i = 0; i < LETTER_ORIGINS.length; i++) {
    const local = x - LETTER_ORIGINS[i]!
    if (local < -1 || local > 4 * STEP + 18) continue
    const cell = Math.round(local / STEP)
    if (cell < 0 || cell > 4) continue
    return i * LETTER_PITCH + cell
  }
  return null
}

function rowOf(y: number): number | null {
  const row = Math.round((y - 16) / STEP)
  if (row < 0 || row > 4) return null
  return row
}

type Cell = { kind: "ink" | "accent"; beginMs?: number }

const cells = new Map<string, Cell>()
let maxCol = 0
let pulseDurMs = 800
const pulseKeyframes = [0.18, 1, 0.18] as [number, number, number]

const rectRe = /<rect\b([^>]*?)(?:\/>|>([\s\S]*?)<\/rect>)/g
for (const m of svg.matchAll(rectRe)) {
  const attrs = m[1] ?? ""
  const inner = m[2] ?? ""
  const x = Number(/x="([\d.]+)"/.exec(attrs)?.[1])
  const y = Number(/y="([\d.]+)"/.exec(attrs)?.[1])
  const fill = /fill="([^"]+)"/.exec(attrs)?.[1]
  if (!Number.isFinite(x) || !Number.isFinite(y) || (fill !== INK && fill !== ACCENT)) continue
  const col = colOf(x)
  const row = rowOf(y)
  if (col == null || row == null) {
    console.warn("unmapped rect", { x, y, fill })
    continue
  }
  const key = `${col},${row}`
  if (fill === ACCENT) {
    const beginS = Number(/begin="([\d.]+)s"/.exec(inner)?.[1] ?? 0)
    const durS = Number(/dur="([\d.]+)s"/.exec(inner)?.[1] ?? 0.8)
    const values = /values="([^"]+)"/.exec(inner)?.[1]
    pulseDurMs = Math.round(durS * 1000)
    if (values) {
      const parts = values.split(";").map(Number)
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        pulseKeyframes[0] = parts[0]!
        pulseKeyframes[1] = parts[1]!
        pulseKeyframes[2] = parts[2]!
      }
    }
    cells.set(key, { kind: "accent", beginMs: Math.round(beginS * 1000) })
  } else {
    cells.set(key, { kind: "ink" })
  }
  maxCol = Math.max(maxCol, col)
}

const rows = 5
const grid: Array<Array<" " | "#" | "*">> = []
const accentBeginMs: Record<string, number> = {}
for (let row = 0; row < rows; row++) {
  const line: Array<" " | "#" | "*"> = []
  for (let col = 0; col <= maxCol; col++) {
    const cell = cells.get(`${col},${row}`)
    if (cell?.kind === "accent") {
      line.push("*")
      accentBeginMs[`${col},${row}`] = cell.beginMs ?? 0
    } else {
      line.push(cell?.kind === "ink" ? "#" : " ")
    }
  }
  grid.push(line)
}

for (const row of grid) console.log(row.join(""))

const out = path.join(import.meta.dir, "../src/logo-grid.ts")
fs.writeFileSync(
  out,
  `/** Generated from assets/loaders/manthan-loader-wordmark-sequence-fast.svg */\n` +
    `export type LogoCell = " " | "#" | "*"\n` +
    `export const logoGrid: LogoCell[][] = ${JSON.stringify(grid)}\n` +
    `export const accentBeginMs: Record<string, number> = ${JSON.stringify(accentBeginMs)}\n` +
    `export const pulseDurMs = ${pulseDurMs}\n` +
    `export const pulseKeyframes = ${JSON.stringify(pulseKeyframes)} as [number, number, number]\n`,
)
console.log("wrote", out, `${grid.length}x${grid[0]?.length}`, "cells", cells.size, "accents", Object.keys(accentBeginMs).length)
