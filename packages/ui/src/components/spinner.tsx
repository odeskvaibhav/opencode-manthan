import { type ComponentProps } from "solid-js"
import { ManthanSvg } from "./manthan-svg"
import { loaderWordmarkSequenceFast } from "./manthan-brand-assets"

/** Manthan wordmark sequence loader (SVG, animated). */
export function Spinner(props: {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
}) {
  return (
    <ManthanSvg
      data-component="spinner"
      class={props.class}
      classList={props.classList}
      style={props.style}
      raw={loaderWordmarkSequenceFast}
      stripBackground
    />
  )
}
