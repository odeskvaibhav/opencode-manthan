import { type ComponentProps, createMemo, splitProps } from "solid-js"

type Props = {
  raw: string
  /** Drop the solid #0B0B0C / full-bleed background rect so it sits on the page bg. */
  stripBackground?: boolean
  class?: string
  "data-component"?: string
} & Omit<ComponentProps<"div">, "innerHTML" | "children">

function prepare(raw: string, stripBackground: boolean | undefined): { html: string; aspect?: string } {
  let svg = raw.trim()
  const viewBox = svg.match(/viewBox="([^"]+)"/i)?.[1]
  let aspect: string | undefined
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number)
    const w = parts[2]
    const h = parts[3]
    if (w && h) aspect = `${w} / ${h}`
  }
  if (stripBackground) {
    svg = svg
      .replace(/<rect[^>]*width="100%"[^>]*\/?>/gi, "")
      .replace(/<rect[^>]*width="192"[^>]*height="192"[^>]*\/?>/gi, "")
      .replace(/<rect[^>]*fill="#0B0B0C"[^>]*\/?>/gi, "")
  }
  // Let CSS control size; keep aspect via wrapper.
  svg = svg.replace(/\s(width|height)="[^"]*"/gi, "")
  svg = svg.replace(/<svg\b/, '<svg width="100%" height="100%" preserveAspectRatio="xMidYMid meet"')
  return { html: svg, aspect }
}

/** Renders a brand SVG string (keeps SMIL <animate> for loaders). */
export function ManthanSvg(props: Props) {
  const [local, rest] = splitProps(props, ["raw", "stripBackground", "class", "data-component", "style"])
  const prepared = createMemo(() => prepare(local.raw, local.stripBackground))
  const style = createMemo(() => {
    const base =
      typeof local.style === "string"
        ? local.style
        : local.style && typeof local.style === "object"
          ? Object.entries(local.style as Record<string, string>)
              .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`)
              .join(";")
          : ""
    const aspect = prepared().aspect
    const aspectRule = aspect ? `aspect-ratio:${aspect};` : ""
    return `${aspectRule}${base}`
  })

  return (
    <div
      {...rest}
      data-component={local["data-component"]}
      class={local.class}
      style={style()}
      // Brand assets are trusted local files from the Manthan pack.
      innerHTML={prepared().html}
    />
  )
}
