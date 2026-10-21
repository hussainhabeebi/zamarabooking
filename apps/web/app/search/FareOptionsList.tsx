"use client";

// Same flight, several fares (Basic / Value / Ultimate…): the cheapest is shown
// selected, the rest behind "+N more fares". One Book button for the chosen fare.
import { useState } from "react";
import FareRulesButton from "./FareRulesButton";

export interface FareOptionRow {
  id: string;
  supplier?: string;
  label: string;
  price: string;
  diff?: string;
  perks: string;
  bookUrl: string;
}

export default function FareOptionsList({ options, seatsLeft }: { options: FareOptionRow[]; seatsLeft?: number }) {
  const [selected, setSelected] = useState(options[0]?.id);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? options : options.filter((o, i) => i === 0 || o.id === selected);

  const hidden = options.length - visible.length;

  return (
    <div className="fare-variants">
      <div className="fare-variants-box">
        {visible.map((o) => {
          const isSel = o.id === selected;
          return (
            <label key={o.id} className={`fare-variant${isSel ? " selected" : ""}`}>
              <input type="radio" name={`fv-${options[0].id}`} checked={isSel} onChange={() => setSelected(o.id)} />
              <div className="fare-variant-body">
                <div className="fare-variant-top">
                  <b className="fare-variant-price">{o.price}</b>
                  <span className="fare-variant-label">{o.label}</span>
                  {o.diff && <span className="fare-variant-diff">+{o.diff}</span>}
                </div>
                {o.perks && <div className="fare-variant-perks">{o.perks}</div>}
                {/* Fare rules come from TripJack; Poomas / manual fares have none online. */}
                {isSel && o.supplier === "TRIPJACK" && <FareRulesButton fareId={o.id} />}
              </div>
              {isSel && <a className="fare-variant-book" href={o.bookUrl} onClick={(e) => e.stopPropagation()}>Book</a>}
            </label>
          );
        })}
        {(expanded || hidden > 0) && (
          <button type="button" className="fare-variants-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {expanded ? "Show less ⌃" : `+${hidden} more fare${hidden > 1 ? "s" : ""} ⌄`}
          </button>
        )}
      </div>
      {seatsLeft != null && seatsLeft > 0 && seatsLeft <= 9 && <div className="fare-variants-seats">Seats left: {seatsLeft}</div>}
    </div>
  );
}
