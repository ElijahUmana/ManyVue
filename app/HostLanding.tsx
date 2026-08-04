import Image from "next/image";
import Link from "next/link";

export default function HostLanding() {
  return (
    <main className="host-landing">
      <div className="host-landing-backdrop" aria-hidden="true" />
      <Image
        className="host-landing-art"
        src="/og.png"
        alt="CrowdCut Live: The crowd is the camera"
        fill
        priority
        sizes="100vw"
      />
      <div className="host-landing-shade" aria-hidden="true" />

      <div className="host-landing-entry">
        <p className="eyebrow">HOST EXPERIENCE</p>
        <Link href="/?view=program" className="host-enter">
          <span>ENTER</span>
          <i aria-hidden="true">→</i>
        </Link>
        <small>Open the live production room</small>
      </div>
    </main>
  );
}
