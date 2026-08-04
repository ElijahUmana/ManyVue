export default function HostLanding() {
  return (
    <main className="host-landing">
      <section className="manyvue-hero" aria-label="ManyVue Live: every phone becomes an angle">
        <div className="manyvue-hero-photo" aria-hidden="true" />
        <div className="manyvue-hero-copy">
          <p>MANYVUE LIVE</p>
          <h1>
            MANY VIEWS.<br />
            ONE LIVE<br />
            <em>FILM.</em>
          </h1>
          <span>Every phone becomes an angle. The crowd becomes the camera crew.</span>
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
