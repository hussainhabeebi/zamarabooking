import Link from "next/link";
import styles from "./results.module.css";

type SearchParams = {
  city?: string; cityName?: string;
  checkIn?: string; checkOut?: string;
  rooms?: string; adults?: string;
  currency?: string; nationality?: string;
};

type NormalizedHotel = {
  id: string; hotelCode: string; name: string; starRating: number;
  address: string; cityCode: string; checkIn: string; checkOut: string; countryCode?: string;
  nights: number; rooms: number; roomType: string; mealPlan: string;
  isRefundable: boolean; baseFare: number; taxes: number; totalFare: number;
  currency: string; images: string[]; amenities: string[];
  hid?: string; correlationId?: string; strikethrough?: number;
};

type HotelSearchResult = {
  hotels: NormalizedHotel[];
  searchId?: string;
  expiresAt?: string;
  errorCode?: string;
  supplier?: string;
  fromCache?: boolean;
  error?: string;
};

interface PageProps { searchParams: Promise<SearchParams>; }

async function searchHotels(params: SearchParams): Promise<HotelSearchResult> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
  const rooms  = parseInt(params.rooms ?? "1");
  const adults = parseInt(params.adults ?? "1");
  try {
    const res = await fetch(`${apiUrl}/api/hotels/search`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
      body: JSON.stringify({
        cityCode:    params.city ?? "",
        ...(params.cityName ? { cityName: params.cityName } : {}),
        checkIn:     params.checkIn ?? "",
        checkOut:    params.checkOut ?? "",
        rooms:       Array.from({ length: rooms }, () => ({ adults, children: 0 })),
        nationality: /^[A-Z]{2}$/.test(params.nationality ?? "") ? params.nationality : "IN",
        currency:    params.currency ?? "INR",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    const data = await res.json().catch(() => ({})) as HotelSearchResult;
    if (!res.ok) return { hotels: [], error: typeof (data as any).error === "string" ? (data as any).error : `Hotel search failed (${res.status})`, errorCode: (data as any).errorCode };
    return data;
  } catch (err) {
    return { hotels: [], error: err instanceof Error ? err.message : "Search unavailable" };
  }
}

function formatMoney(amount: number, currency: string): string {
  const code = (currency || "INR").toUpperCase();
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: code, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString()}`;
  }
}

function buildBookUrl(hotel: NormalizedHotel, rooms: number, adults: number, expiresAt?: string, nationality = "IN"): string {
  const p = new URLSearchParams({
    hid:       hotel.hid ?? hotel.hotelCode,
    sid:       hotel.correlationId ?? "",
    adults:    String(adults),
    nat:       nationality,
    exp:       expiresAt ?? "",
    optionId:  hotel.id,
    name:      hotel.name,
    stars:     String(hotel.starRating),
    price:     String(hotel.totalFare),
    currency:  hotel.currency,
    checkIn:   hotel.checkIn,
    checkOut:  hotel.checkOut,
    nights:    String(hotel.nights),
    rooms:     String(rooms),
    roomType:  hotel.roomType,
    mealPlan:  hotel.mealPlan,
    ref:       hotel.isRefundable ? "1" : "0",
    city:      hotel.cityCode,
    address:   hotel.address,
    cc:        hotel.countryCode ?? "",
  });
  return `/hotels/book?${p}`;
}

function Stars({ n }: { n: number }) {
  const full = Math.round(n);
  return (
    <span style={{ color: "#f59e0b", fontSize: 13, letterSpacing: 1 }}>
      {"★".repeat(Math.max(0, Math.min(5, full)))}
      {"☆".repeat(Math.max(0, 5 - Math.min(5, full)))}
    </span>
  );
}

export default async function HotelSearchPage({ searchParams }: PageProps) {
  const params  = await searchParams;
  const result  = await searchHotels(params);
  const hotels  = result.hotels ?? [];
  const rooms   = parseInt(params.rooms ?? "1");
  const adults  = parseInt(params.adults ?? "1");
  const nationality = /^[A-Z]{2}$/.test(params.nationality ?? "") ? params.nationality! : "IN";
  const nights  = hotels[0]?.nights ?? (
    params.checkIn && params.checkOut
      ? Math.max(1, Math.round((new Date(params.checkOut).getTime() - new Date(params.checkIn).getTime()) / 86400000))
      : 1
  );

  return (
    <main className={styles.page}>
      <header className={styles.summary}>
        <div>
          <p className={styles.eyebrow}>YOUR HOTEL SEARCH</p>
          <h1>Hotels in {params.cityName ?? params.city}</h1>
          <p className={styles.context}>
            <span>{params.checkIn} → {params.checkOut}</span>
            <span>{nights} night{nights !== 1 ? "s" : ""}</span>
            <span>{rooms} room{rooms !== 1 ? "s" : ""}</span>
            <span>{adults * rooms} adult{adults * rooms !== 1 ? "s" : ""} · {adults}/room</span>
          </p>
        </div>
        <a href="/hotels" className={styles.newSearch}>‹ New search</a>
      </header>

      {hotels.length === 0 ? (
        <div className={styles.empty}>
          <div style={{ fontSize: 44, marginBottom: 14 }}>🏨</div>
          <p style={{ fontSize: 20, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>
            {result.error ? "Hotel search unavailable" : "No hotels found"}
          </p>
          <p style={{ margin: "0 0 20px" }}>
            {result.error ?? "Try different dates or destination."}
          </p>
          {result.error && (
            <p style={{ fontSize: 12, color: "#991b1b", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px", maxWidth: 600, margin: "0 auto 20px", wordBreak: "break-word" }}>
              {result.error}
            </p>
          )}
          <a href="/hotels" className="fare-card-book-btn" style={{ maxWidth: 200, margin: "0 auto" }}>
            Search again
          </a>
        </div>
      ) : (
        <div className={styles.results}>
          <p style={{ margin: 0, fontSize: 13, color: "#475569", fontWeight: 700 }}>
            {hotels.length} hotel{hotels.length !== 1 ? "s" : ""} found
          </p>
          {hotels.map((hotel, i) => (
            <HotelCard key={`${hotel.id}-${i}`} hotel={hotel} rooms={rooms} adults={adults} expiresAt={result.expiresAt} nationality={nationality} />
          ))}
        </div>
      )}
    </main>
  );
}

function HotelCard({ hotel, rooms, adults, expiresAt, nationality = "IN" }: { hotel: NormalizedHotel; rooms: number; adults: number; expiresAt?: string; nationality?: string }) {
  const price = hotel.totalFare;
  const bookable = Boolean(hotel.id);

  return (
    <article className={styles.card}>
      <div className={styles.imageArea}>
        {hotel.images?.[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={hotel.images[0]} alt={hotel.name} loading="lazy" className={styles.image} />
        ) : <div className={styles.noImage}><span aria-hidden="true">▥</span>Hotel image unavailable</div>}
      </div>
      <div className={styles.info}>
        <h2>{hotel.name || "—"}</h2>
        {hotel.starRating > 0 && <span aria-label={`${hotel.starRating} star rating`}><Stars n={hotel.starRating} /></span>}
        {hotel.address && <p className={styles.address}>{hotel.address}</p>}
        <div className={styles.rate}>
          {hotel.roomType && <p className={styles.room}>{hotel.roomType}</p>}
          {hotel.mealPlan && hotel.mealPlan !== "EP" && hotel.mealPlan !== "Room Only" && (
            <p className={styles.meal}>{hotel.mealPlan === "CP" ? "Breakfast included" : hotel.mealPlan === "MAP" ? "Half board" : hotel.mealPlan === "AP" ? "Full board" : hotel.mealPlan}</p>
          )}
          <span className={`${styles.badge} ${hotel.isRefundable ? styles.refundable : styles.nonRefundable}`}>{hotel.isRefundable ? "Refundable" : "Non-refundable"}</span>
        </div>
        {hotel.amenities.length > 0 && <p className={styles.amenities}>{hotel.amenities.slice(0, 5).join(" · ")}</p>}
      </div>
      <div className={styles.priceArea}>
        <div>
          <p className={styles.totalLabel}>Total stay</p>
          {hotel.strikethrough && hotel.strikethrough > price && <div className={styles.previousPrice}>{formatMoney(hotel.strikethrough, hotel.currency)}</div>}
          <p className={styles.price}>{formatMoney(price, hotel.currency)}</p>
          <p className={styles.stay}>{hotel.nights} night{hotel.nights !== 1 ? "s" : ""} · {rooms} room{rooms !== 1 ? "s" : ""}</p>
        </div>
        {bookable ? (
          <Link href={buildBookUrl(hotel, rooms, adults, expiresAt, nationality)} className={styles.book}>Book Now <span aria-hidden="true">→</span></Link>
        ) : <p className={styles.unavailable}>Indicative price · Not directly bookable</p>}
      </div>
    </article>
  );
}
