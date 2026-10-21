export default function HeroBanner({ banners: _banners }: { banners: unknown[] }) {
  return <section className="hero hero-photo">
    <img src="/hero/airplane-wing-clouds.webp" alt="" className="hero-photo-img" fetchPriority="high" />
    <div className="hero-shade" />
    <div className="hero-inner hero-copy">
      <div className="hero-badge">ZAMRA TRAVELS · INDIA & THE GULF</div>
      <h1 className="hero-title">A little closer.<br />To your next journey.</h1>
      <p className="hero-subtitle">From homecomings to new horizons. Find your flight, compare your options and travel with confidence.</p>
      <a className="hero-cta" href="#flight-search">Find your flight <span aria-hidden="true">↗</span></a>
    </div>
    <div className="hero-caption">YOUR WORLD, WITHIN REACH <span>India · Gulf · Beyond</span></div>
  </section>;
}
