"use client";
export type BaggageOption = { code: string; amount: number; desc: string };
export function availableBaggage(options: BaggageOption[]): BaggageOption[] {
  return options.filter(o => !!o.code && typeof o.amount === "number" && Number.isFinite(o.amount) && o.amount >= 0);
}
export default function BaggageSelection({ options, value, onChange, format, label }: {
  options: BaggageOption[]; value: string; onChange: (code:string)=>void; format:(amount:number)=>string; label:string;
}) {
  const valid = availableBaggage(options);
  const selected = valid.find(o=>o.code===value);
  return <label>Add Baggage
    {valid.length ? <>
      <select aria-label={label} value={selected?.code ?? ""} onChange={e=>onChange(e.target.value)}>
        <option value="">No additional baggage</option>
        {valid.map(o=><option key={o.code} value={o.code}>{o.desc} · {format(o.amount)}</option>)}
      </select>
      <small className="ssrPick">{selected ? `${selected.desc} · + ${format(selected.amount)}` : "No extra baggage charge"}</small>
    </> : <small>Additional baggage not available.</small>}
  </label>;
}
