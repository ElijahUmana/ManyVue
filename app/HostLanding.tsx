export default function HostLanding() {
  return (
    <main className="host-landing">
      <div className="host-landing-backdrop" aria-hidden="true" />
      <img
        className="host-landing-art"
        src="/og.png"
        alt="CrowdCut Live: The crowd is the camera"
        fetchPriority="high"
      />
      <section className="host-landing-mobile" aria-label="CrowdCut Live: The crowd is the camera">
        <div className="host-landing-mobile-photo" aria-hidden="true" />
        <div className="host-landing-mobile-copy">
          <p>CROWDCUT LIVE</p>
          <h1>
            THE CROWD<br />
            IS THE<br />
            <em>CAMERA.</em>
          </h1>
          <span>Every phone becomes an angle. Every angle becomes the film.</span>
        </div>
      </section>
      <div className="host-landing-shade" aria-hidden="true" />

      <div className="host-landing-entry">
        <p className="eyebrow">HOST EXPERIENCE</p>
        <a href="/program" className="host-enter">
          <span>START FILM</span>
          <i aria-hidden="true">→</i>
        </a>
        <small>Open the room and start the live production</small>
      </div>
    </main>
  );
}
