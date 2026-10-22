export default function HeroBanner({ banners: _banners }: { banners: unknown[] }) {
  return (
    <section className="zamra-sunset-hero" aria-labelledby="home-heading">
      <picture className="sunset-hero-image">
        <source media="(max-width: 767px)" srcSet="/hero/airplane-wing-clouds-mobile.webp" />
        <img src="/hero/airplane-wing-clouds.webp" alt="Airplane wing above sunset clouds" width="1920" height="768" fetchPriority="high" />
      </picture>
      <div className="sunset-hero-shade" aria-hidden="true" />
      <div className="sunset-hero-copy">
        <p className="sunset-hero-eyebrow">ZAMRA TRAVELS · KERALA & THE GULF</p>
        <h1 id="home-heading">Your Next Journey<br />Starts Here</h1>
        <p>Flying home or heading somewhere new?<br className="sunset-desktop-break" /> Find your flight between India, the Gulf and beyond.</p>
        <a className="sunset-hero-cta" href="#flight-search">Find your flight <span aria-hidden="true">↗</span></a>
      </div>
    </section>
  );
}
