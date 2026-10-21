interface Route {
  origin:      string;
  destination: string;
  label:       string;
  fromPrice?:  number;
  currency?:   string;
}

const DEFAULT_ROUTES: Route[] = [
  { origin: "COK", destination: "DXB", label: "Kochi → Dubai" },
  { origin: "CCJ", destination: "AUH", label: "Kozhikode → Abu Dhabi" },
  { origin: "COK", destination: "DOH", label: "Kochi → Doha" },
  { origin: "DXB", destination: "COK", label: "Dubai → Kochi" },
  { origin: "AUH", destination: "CCJ", label: "Abu Dhabi → Kozhikode" },
  { origin: "DOH", destination: "COK", label: "Doha → Kochi" },
];

const CITY_IMAGES: Record<string, { name: string; src: string }> = {
  COK: { name: "Kochi", src: "/routes/kochi.jpg" },
  DOH: { name: "Doha", src: "/routes/doha.jpg" },
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
            {CITY_IMAGES[r.destination] && <span className="destination-photo"><img src={CITY_IMAGES[r.destination].src} alt="" loading="lazy" decoding="async" /><span className="destination-tag">EXPLORE {CITY_IMAGES[r.destination].name.toUpperCase()}</span></span>}
            <span className="popular-route-title">{r.label}</span>
            <span className="popular-route-details">
              <span className="popular-route-view" aria-hidden="true">View flights →</span>
            </span>
            <span className="popular-route-arrow" aria-hidden="true">→</span>
          </a>
        ))}
      </div>
    </div>
  );
}
