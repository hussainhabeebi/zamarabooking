export default function HeroBanner({ banners: _banners }: { banners: unknown[] }) {
  return (
    <section className="zamra-hero client-sunset-hero" aria-labelledby="home-heading">
      <img className="client-hero-photo" src="/hero/airplane-wing-clouds.webp" alt="Airplane wing above sunset clouds" width="1920" height="768" fetchPriority="high" />
      <div className="zamra-hero-copy">
        <p className="section-kicker">ZAMRA TRAVELS · KERALA &amp; THE GULF</p>
        <h1 id="home-heading">Your Next Journey<br />Starts Here</h1>
        <p>Flying home or discovering somewhere new?<br />Find and compare flights with Zamra.</p>
        <a className="client-hero-link" href="#flight-search">Find your flight <span aria-hidden="true">↗</span></a>
      </div>
    </section>
  );
}
