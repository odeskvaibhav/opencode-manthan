import { Link, Meta } from "@solidjs/meta"

export const Favicon = () => {
  return (
    <>
      <Link rel="icon" type="image/png" href="/favicon-base-256px.png" sizes="256x256" />
      <Link rel="shortcut icon" href="/favicon-base-256px.png" />
      <Link rel="apple-touch-icon" sizes="256x256" href="/favicon-base-256px.png" />
      <Link rel="manifest" href="/site.webmanifest" />
      <Meta name="apple-mobile-web-app-title" content="Manthan" />
    </>
  )
}
