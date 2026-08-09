import type { ComponentProps } from "solid-js"
import { ManthanSvg } from "../../components/manthan-svg"
import { wordmarkInverse } from "../../components/manthan-brand-assets"

export function WordmarkV2(props: Pick<ComponentProps<"div">, "class">) {
  return <ManthanSvg data-component="wordmark-v2" class={props.class} raw={wordmarkInverse} stripBackground />
}
