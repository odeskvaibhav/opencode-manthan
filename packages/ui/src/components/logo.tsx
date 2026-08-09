import { type ComponentProps } from "solid-js"
import { ManthanSvg } from "./manthan-svg"
import { loaderWordmarkSequenceFast, monogramBadgeDark, wordmarkInverse } from "./manthan-brand-assets"

/** Compact Manthan M badge (favicon mark). */
export const Mark = (props: { class?: string }) => {
  return <ManthanSvg data-component="logo-mark" class={props.class} raw={monogramBadgeDark} />
}

/** Loading splash — wordmark sequence-fast SVG. */
export const Splash = (props: Pick<ComponentProps<"div">, "ref" | "class">) => {
  return (
    <ManthanSvg
      ref={props.ref as never}
      data-component="logo-splash"
      class={props.class}
      raw={loaderWordmarkSequenceFast}
      stripBackground
    />
  )
}

/** Manthan wordmark (inverse: soft white + lime accents). */
export const Logo = (props: { class?: string }) => {
  return <ManthanSvg data-component="logo-wordmark" class={props.class} raw={wordmarkInverse} stripBackground />
}
