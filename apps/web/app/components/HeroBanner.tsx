export default function HeroBanner({ banners: _banners }: { banners: unknown[] }) {
  return (
    <section className="zamra-hero" aria-labelledby="home-heading">
      <div className="zamra-hero-copy">
        <p className="section-kicker">ZAMRA TRAVELS · KERALA & THE GULF</p>
        <h1 id="home-heading">Your next journey.<br /><span>Made simple.</span></h1>
        <p>Flying home or heading somewhere new?<br className="hero-mobile-break" /> Find and compare flights with Zamra.</p>
      </div>
      <div className="zamra-aircraft-frame">
        <img src="/hero/zamra-aircraft.webp" alt="Passenger aircraft above the clouds" width="1600" height="533" fetchPriority="high" />
      </div>
    </section>
  );
}
