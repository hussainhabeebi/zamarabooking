"use client";
// Airline logo on flight results, from the pics.avs.io airline-logo images (loaded by the visitor's
// browser). If an image can't be loaded, the airline code is shown instead, as before.
import { useEffect, useRef, useState } from "react";

export default function AirlineLogo({ code, name, className }: { code: string; name?: string; className?: string }) {
  const iata = String(code ?? "").trim().toUpperCase();
  const [failed, setFailed] = useState(!/^[A-Z0-9]{2}$/.test(iata));
  const img = useRef<HTMLImageElement>(null);
  // An image that already failed before the page became interactive never fires onError: check it.
  useEffect(() => { const el = img.current; if (el && el.complete && el.naturalWidth === 0) setFailed(true); }, []);
  if (failed) return <div className={className}>{iata}</div>;
  return (
    <div className={`${className ?? ""} airline-logo-img`}>
      <img
        ref={img}
        src={`https://pics.avs.io/120/120/${iata}.png`}
        srcSet={`https://pics.avs.io/120/120/${iata}.png 1x, https://pics.avs.io/240/240/${iata}.png 2x`}
        alt={name ? `${name} logo` : `${iata} logo`}
        width={40} height={40} loading="lazy" decoding="async" referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
