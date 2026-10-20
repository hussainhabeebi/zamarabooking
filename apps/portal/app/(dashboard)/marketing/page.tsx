"use client";

// Marketing kit: square offer images ("Kochi → Dubai from ₹X") with the
// agency's logo, colour and phone, priced from recent fares (price calendar)
// plus the agency's selling markup. Drawn in the browser; download or share.

import { useEffect, useRef, useState } from "react";
import { api, money } from "../../../lib/api";
import { useMe } from "../Shell";

const ROUTES = [["COK", "DXB", "Kochi", "Dubai"], ["CCJ", "DXB", "Kozhikode", "Dubai"], ["TRV", "DXB", "Thiruvananthapuram", "Dubai"], ["COK", "DOH", "Kochi", "Doha"], ["CCJ", "RUH", "Kozhikode", "Riyadh"], ["COK", "MCT", "Kochi", "Muscat"], ["BOM", "DXB", "Mumbai", "Dubai"], ["COK", "SIN", "Kochi", "Singapore"], ["DXB", "COK", "Dubai", "Kochi"], ["COK", "BLR", "Kochi", "Bengaluru"]];
type Day = { date: string; price: number };

export default function MarketingPage() {
  const { me } = useMe();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [route, setRoute] = useState(0);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [low, setLow] = useState<Day | null>(null);
  const [price, setPrice] = useState("");
  const [headline, setHeadline] = useState("Fly for less!");
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);
  const [status, setStatus] = useState("");
  const [o, d, oCity, dCity] = ROUTES[route];
  const cur = me?.agent.currency ?? "INR";
  const color = me?.settings.brandColor || "#E31E24";
  const name = me?.settings.displayName || me?.agent.businessName || "";
  const phone = me?.settings.contactPhone || me?.agent.whatsapp || me?.agent.phone || "";

  useEffect(() => {
    setLow(null); setStatus("Finding the lowest recent fare…");
    api<{ days: Day[] }>(`/api/fares/calendar?origin=${o}&destination=${d}&month=${month}&currency=${cur}`, { auth: false })
      .then((r) => {
        const best = r.days.reduce<Day | null>((m, x) => (!m || x.price < m.price ? x : m), null);
        setLow(best);
        if (best) {
          const own = me?.settings.ownMarkup;
          const sell = own ? (own.type === "FLAT" ? best.price + own.value : best.price * (1 + own.value / 100)) : best.price;
          setPrice(String(Math.ceil(sell / 10) * 10));
          setStatus("");
        } else setStatus("No recent prices for this month — type your price.");
      })
      .catch(() => setStatus("Type your price."));
  }, [o, d, month, cur, me]);

  useEffect(() => {
    if (!me?.settings.logoUrl) return;
    const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => setLogo(img); img.src = me.settings.logoUrl;
  }, [me?.settings.logoUrl]);

  useEffect(() => {
    const c = canvas.current; if (!c) return;
    const x = c.getContext("2d"); if (!x) return;
    const W = 1080;
    const g = x.createLinearGradient(0, 0, W, W); g.addColorStop(0, color); g.addColorStop(1, "#111827");
    x.fillStyle = g; x.fillRect(0, 0, W, W);
    x.globalAlpha = .12; x.fillStyle = "#fff"; x.font = "bold 520px Inter, Arial"; x.fillText("✈", 520, 640); x.globalAlpha = 1;
    x.fillStyle = "#fff"; x.textAlign = "left";
    x.font = "800 64px Inter, Arial"; x.fillText(headline.slice(0, 28), 80, 180);
    x.font = "700 92px Inter, Arial"; x.fillText(oCity, 80, 360);
    x.font = "600 60px Inter, Arial"; x.fillText("→ " + dCity, 80, 450);
    x.font = "500 40px Inter, Arial"; x.fillText(`${o} – ${d} · ${new Date(`${month}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}`, 80, 520);
    x.fillStyle = "#fff"; x.beginPath(); x.roundRect(80, 590, 620, 170, 28); x.fill();
    x.fillStyle = color; x.font = "600 40px Inter, Arial"; x.fillText("Fares from", 120, 650);
    x.font = "800 84px Inter, Arial"; x.fillText(price ? money(Number(price), cur) : "—", 120, 735);
    x.fillStyle = "rgba(255,255,255,.95)"; x.font = "700 46px Inter, Arial"; x.fillText(name.slice(0, 32), 80, 900);
    x.font = "500 40px Inter, Arial"; x.fillText(`📞 ${phone}`, 80, 960);
    x.font = "400 26px Inter, Arial"; x.fillStyle = "rgba(255,255,255,.7)"; x.fillText("Per person, one way, subject to availability.", 80, 1020);
    if (logo) { const h = 120, w = Math.min(320, (logo.width / logo.height) * h); x.fillStyle = "#fff"; x.beginPath(); x.roundRect(W - w - 100, 60, w + 40, h + 40, 20); x.fill(); x.drawImage(logo, W - w - 80, 80, w, h); }
  }, [color, headline, oCity, dCity, o, d, month, price, name, phone, logo, cur]);

  async function share() {
    const c = canvas.current; if (!c) return;
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!blob) return;
    const file = new File([blob], `offer-${o}-${d}.png`, { type: "image/png" });
    const text = `${headline} ${oCity} → ${dCity} from ${money(Number(price), cur)}. Call/WhatsApp ${name} ${phone}`;
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], text }).catch(() => {}); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  }

  return (
    <div>
      <div className="page-head"><div><h1>Marketing kit</h1><p>Ready-to-post offer images with your logo, colour and phone. Prices come from recent searches plus your markup.</p></div></div>
      <div className="grid g2">
        <div className="card stack">
          <label className="f">Route<select value={route} onChange={(e) => setRoute(Number(e.target.value))}>{ROUTES.map((r, i) => <option key={i} value={i}>{r[2]} → {r[3]}</option>)}</select></label>
          <label className="f">Month<input type="month" value={month} min={new Date().toISOString().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} /></label>
          <label className="f">Headline<input maxLength={28} value={headline} onChange={(e) => setHeadline(e.target.value)} /></label>
          <label className="f">Price shown ({cur})<input type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          {low && <p className="small muted" style={{ margin: 0 }}>Lowest recent net fare: {money(low.price, cur)} on {low.date}. Prices change — check before you confirm a booking.</p>}
          {status && <p className="small muted" style={{ margin: 0 }}>{status}</p>}
          {!me?.settings.logoUrl && <p className="small">Tip: <a href="/settings">add your logo</a> to brand the image.</p>}
          <div className="row"><button className="btn primary" onClick={share}>Download / share</button></div>
        </div>
        <div className="card"><canvas ref={canvas} width={1080} height={1080} style={{ width: "100%", height: "auto", borderRadius: 12 }} aria-label="Offer image preview" /></div>
      </div>
    </div>
  );
}
