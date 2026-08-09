import { RGBA } from "@opentui/core"
import { For, createMemo, createSignal, createEffect, onCleanup } from "solid-js"
import { accentBeginMs, logoGrid, pulseDurMs, pulseKeyframes, type LogoCell } from "../logo-grid"

const SOFT_WHITE = RGBA.fromHex("#F5F5F5")
const ELECTRIC_LIME = RGBA.fromHex("#C6FF00")
const INK_BG = RGBA.fromHex("#0B0B0C")
const TICK_MS = 40

type Glyph = { ch: string; fg: RGBA; bg?: RGBA; key: string }

function smilOpacity(elapsedMs: number, beginMs: number, durMs: number): number {
  const [a, b, c] = pulseKeyframes
  if (elapsedMs < beginMs) return a
  const t = ((elapsedMs - beginMs) % durMs) / durMs
  if (t <= 0.5) return a + (b - a) * (t / 0.5)
  return b + (c - b) * ((t - 0.5) / 0.5)
}

function mix(from: RGBA, to: RGBA, t: number): RGBA {
  return RGBA.fromValues(from.r + (to.r - from.r) * t, from.g + (to.g - from.g) * t, from.b + (to.b - from.b) * t, 1)
}

function cellColor(cell: LogoCell, col: number, row: number, elapsedMs: number, animate: boolean): RGBA | null {
  if (cell === " ") return null
  if (cell === "#") return SOFT_WHITE
  if (!animate) return ELECTRIC_LIME
  return mix(INK_BG, ELECTRIC_LIME, smilOpacity(elapsedMs, accentBeginMs[`${col},${row}`] ?? 0, pulseDurMs))
}

/** 2 design rows → 1 terminal row via ▀/▄/█ so pixels stay square. */
function buildLines(elapsedMs: number, animate: boolean): Glyph[][] {
  const rows = logoGrid.length
  const cols = logoGrid[0]?.length ?? 0
  const lines: Glyph[][] = []
  for (let y = 0; y < rows; y += 2) {
    const line: Glyph[] = []
    for (let x = 0; x < cols; x++) {
      const top = logoGrid[y]?.[x] ?? " "
      const bot = logoGrid[y + 1]?.[x] ?? " "
      const topC = cellColor(top, x, y, elapsedMs, animate)
      const botC = cellColor(bot, x, y + 1, elapsedMs, animate)
      if (!topC && !botC) {
        line.push({ ch: " ", fg: SOFT_WHITE, key: `${y}:${x}` })
        continue
      }
      if (topC && botC) {
        line.push({ ch: "▀", fg: topC, bg: botC, key: `${y}:${x}:${elapsedMs}` })
        continue
      }
      if (topC) line.push({ ch: "▀", fg: topC, key: `${y}:${x}:${elapsedMs}` })
      else line.push({ ch: "▄", fg: botC!, key: `${y}:${x}:${elapsedMs}` })
    }
    lines.push(line)
  }
  return lines
}

/** TUI wordmark. `animate` plays manthan-loader-wordmark-sequence-fast.svg SMIL. */
export function Logo(props: { animate?: boolean }) {
  const [elapsed, setElapsed] = createSignal(0)

  createEffect(() => {
    if (!props.animate) {
      setElapsed(0)
      return
    }
    const start = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - start), TICK_MS)
    onCleanup(() => clearInterval(id))
  })

  const lines = createMemo(() => buildLines(elapsed(), Boolean(props.animate)))

  return (
    <box>
      <For each={lines()}>
        {(line) => (
          <box flexDirection="row">
            <For each={line}>
              {(g) => (
                <text fg={g.fg} bg={g.bg} selectable={false}>
                  {g.ch}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
