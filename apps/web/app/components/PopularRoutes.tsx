interface Route {
  origin:      string;
  destination: string;
  label:       string;
  fromPrice?:  number;
  currency?:   string;
}

const DEFAULT_ROUTES: Route[] = [
  { origin: "COK", destination: "DXB", label: "Kochi → Dubai",      fromPrice: 12500, currency: "INR" },
  { origin: "CCJ", destination: "AUH", label: "Kozhikode → Abu Dhabi", fromPrice: 13200, currency: "INR" },
  { origin: "BOM", destination: "DXB", label: "Mumbai → Dubai",      fromPrice: 10800, currency: "INR" },
  { origin: "MAA", destination: "DXB", label: "Chennai → Dubai",     fromPrice: 11500, currency: "INR" },
  { origin: "DEL", destination: "DXB", label: "Delhi → Dubai",       fromPrice: 9900,  currency: "INR" },
  { origin: "HYD", destination: "DXB", label: "Hyderabad → Dubai",   fromPrice: 10200, currency: "INR" },
];

const CITY_IMAGES: Record<string, { name: string; src: string }> = {
  COK: { name: "Kochi", src: "/routes/kochi.jpg" },
  DXB: { name: "Dubai", src: "/routes/dubai.jpg" },
  CCJ: { name: "Kozhikode", src: "/routes/kozhikode.jpg" },
  AUH: { name: "Abu Dhabi", src: "/routes/abu-dhabi.jpg" },
  BOM: { name: "Mumbai", src: "/routes/mumbai.jpg" },
  MAA: { name: "Chennai", src: "/routes/chennai.jpg" },
  DEL: { name: "Delhi", src: "/routes/delhi.jpg" },
  HYD: { name: "Hyderabad", src: "/routes/hyderabad.jpg" },
};

export default function PopularRoutes({ routes }: { routes: Route[] }) {
  const displayRoutes = routes.length > 0 ? routes : DEFAULT_ROUTES;

  function buildSearchUrl(r: Route) {
    const today = new Date();
    today.setDate(today.getDate() + 14);
    const date = today.toISOString().split("T")[0];
    return `/search?origin=${r.origin}&destination=${r.destination}&departureDate=${date}&adults=1&tripType=ONEWAY&cabinClass=ECONOMY`;
  }

  return (
    <div className="popular-route-list">
      <div className="popular-route-grid">
        {displayRoutes.map((r, i) => (
          <a
            key={i}
            href={buildSearchUrl(r)}
            className="popular-route-card"
          >
            {CITY_IMAGES[r.origin] && CITY_IMAGES[r.destination] && (
              <span className="popular-route-journey" aria-hidden="true">
                {([r.origin, r.destination] as const).map((city) => (
                  <span className="popular-route-city" key={city}>
                    <img src={CITY_IMAGES[city].src} alt="" loading="lazy" decoding="async" />
                    <span className="popular-route-city-name">{CITY_IMAGES[city].name}</span>
                  </span>
                ))}
                <span className="popular-route-plane">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                    <path d="m21 3-8.3 18-2.8-7.9L2 10.3 21 3Zm-8.6 8.6 1.1 3.2 3.2-7-7 3.2 2.7.6Z" />
                  </svg>
                </span>
              </span>
            )}
            <span className="popular-route-title">{r.label}</span>
            <span className="popular-route-details">
              {r.fromPrice && (
                <span className="popular-route-fare">
                  from {r.currency ?? "INR"} {r.fromPrice.toLocaleString()}
                </span>
              )}
              <span className="popular-route-view" aria-hidden="true">View flights →</span>
            </span>
            <span className="popular-route-arrow" aria-hidden="true">→</span>
          </a>
        ))}
      </div>
    </div>
  );
}
