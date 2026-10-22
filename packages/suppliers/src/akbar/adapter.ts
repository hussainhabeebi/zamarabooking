import type { NormalizedFare, SearchParams, SupplierAdapter } from '../base.js';
import { AkbarClient, AkbarError, record, text } from './client.js';

const cabins = { ECONOMY: 'E', PREMIUM_ECONOMY: 'PE', BUSINESS: 'B', FIRST: 'F' } as const;
const cabinNames: Record<string, string> = { E: 'ECONOMY', PE: 'PREMIUM_ECONOMY', B: 'BUSINESS', F: 'FIRST' };
const number = (v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new AkbarError('INVALID_RESPONSE'); return v; };
const array = (v: unknown): any[] => { if (!Array.isArray(v) || v.length > 500) throw new AkbarError('INVALID_RESPONSE'); return v; };
function minutes(v: unknown): number {
  const match = /^(\d{1,3})h\s*(\d{1,2})m\s*$/.exec(text(v));
  if (!match || Number(match[2]) > 59) throw new AkbarError('INVALID_RESPONSE');
  return Number(match[1]) * 60 + Number(match[2]);
}
function airport(v: unknown) { const s = text(v); if (!/^[A-Z]{3}$/.test(s)) throw new AkbarError('INVALID_RESPONSE'); return s; }
function dateTime(v: unknown) { const s = text(v); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)?$/.test(s) || !Number.isFinite(Date.parse(s))) throw new AkbarError('INVALID_RESPONSE'); return s; }
export function akbarSearchBody(p: SearchParams, multiCityFareType?: 'IM' | 'DM') {
  if (!['ONEWAY', 'ROUNDTRIP', 'MULTICITY'].includes(p.tripType) || !cabins[p.cabinClass] || p.currency !== 'INR' || (p.fareType && p.fareType !== 'REGULAR')) throw new AkbarError('UNSUPPORTED');
  if (![p.adults, p.children, p.infants].every(Number.isInteger) || p.adults < 1 || p.children < 0 || p.infants < 0 || p.infants > p.adults || p.adults + p.children > 9) throw new AkbarError('INVALID_REQUEST');
  const trip = (from: string, to: string, date: string) => {
    if (!Number.isFinite(Date.parse(date)) || !/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to || !/^\d{4}-\d\d-\d\d$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) throw new AkbarError('INVALID_REQUEST');
    return { From: from, To: to, OnwardDate: date, TUI: '' };
  };
  let Trips: Array<Record<string, unknown>>;
  if (p.tripType === 'MULTICITY') {
    if (!multiCityFareType || !p.legs || p.legs.length < 2 || p.legs.length > 6) throw new AkbarError('UNSUPPORTED');
    Trips = p.legs.map(l => trip(l.origin, l.destination, l.date));
  } else {
    const t: Record<string, unknown> = trip(p.origin, p.destination, p.departureDate);
    if (p.tripType === 'ROUNDTRIP') {
      if (!p.returnDate || p.returnDate < p.departureDate) throw new AkbarError('INVALID_REQUEST');
      trip(p.destination, p.origin, p.returnDate); t.ReturnDate = p.returnDate;
    }
    Trips = [t];
  }
  return { ADT: p.adults, CHD: p.children, INF: p.infants, Cabin: cabins[p.cabinClass], Source: 'CF', Mode: 'AS', TUI: '', FareType: p.tripType === 'ONEWAY' ? 'ON' : p.tripType === 'ROUNDTRIP' ? 'RT' : multiCityFareType, Trips,
    Parameters: { Airlines: '', GroupType: '', Refundable: '', IsDirect: false, IsStudentFare: false, IsNearbyAirport: false } };
}

/** Normalize an explicitly priced itinerary, never guess base/tax from NetFare. */
export function normalizeAkbarItinerary(input: unknown, id: string, baggage: string, legIndex: number): NormalizedFare {
  const d = record(input);
  if (String(d.Code) !== '200' || d.CurrencyCode !== 'INR') throw new AkbarError('INVALID_RESPONSE');
  const journeys = array(d.Trips).flatMap(t => array(record(t).Journey));
  const segments = journeys.flatMap(j => array(record(j).Segments)).map(record);
  if (!segments.length) throw new AkbarError('INVALID_RESPONSE');
  const flights = segments.map(s => record(s.Flight));
  const first = flights[0];
  const outwardLast = record(array(record(journeys[0]).Segments).at(-1)).Flight;
  const base = segments.reduce((n, s) => n + number(record(s.Fares).TotalBaseFare), 0);
  const taxes = segments.reduce((n, s) => n + number(record(s.Fares).TotalTax), 0);
  const total = number(d.GrossAmount);
  if (base + taxes > total + .01) throw new AkbarError('INVALID_RESPONSE');
  const mapped = flights.map(f => ({ airline: text(f.MAC), airlineName: text(f.Airline).split('|')[0], flightNumber: `${text(f.MAC)}${text(f.FlightNo).trim()}`, origin: airport(f.DepartureCode), destination: airport(f.ArrivalCode), departureTime: dateTime(f.DepartureTime), arrivalTime: dateTime(f.ArrivalTime), duration: minutes(f.Duration), isReturn: flights.indexOf(f) >= array(record(journeys[0]).Segments).length }));
  const cabin = cabinNames[text(first.Cabin)]; if (!cabin) throw new AkbarError('INVALID_RESPONSE');
  return { id, supplier: 'AKBAR', isBookable: false, airline: mapped[0].airline, airlineName: mapped[0].airlineName, flightNumber: mapped.map(s => s.flightNumber).join('/'), origin: mapped[0].origin, destination: airport(record(outwardLast).ArrivalCode),
    departureTime: mapped[0].departureTime, arrivalTime: dateTime(record(outwardLast).ArrivalTime),
    duration: journeys.reduce((n, j) => n + minutes(record(j).Duration), 0), stops: journeys.reduce((n, j) => n + number(Number(record(j).Stops)), 0), stopDetails: [], cabinClass: cabin, baseFare: base, taxes, totalFare: total, currency: 'INR', isRefundable: flights.every(f => f.Refundable === 'Y'), baggage: { checked: baggage || 'Not provided', cabin: 'Not provided' }, fareClass: text(first.FareClass), segments: mapped,
    tripKey: journeys.length > 1 ? 'COMBO' : legIndex === 0 ? 'ONWARD' : 'RETURN', legIndex,
    // Intentionally store no raw provider payload, auth metadata or opaque TUI.
    raw: { mock: true, chargesAndMarkup: Math.round((total - base - taxes) * 100) / 100 } };
}

/** Not registered with production search. Explicit fixture transport is mandatory. */
export class AkbarAdapter implements SupplierAdapter {
  readonly name = 'AKBAR' as const;
  constructor(private readonly client: AkbarClient, private readonly options: { mode: 'mock'; multiCityFareType?: 'IM' | 'DM'; budgetMs?: number; pollMs?: number } = { mode: 'mock' }) {
    if (options.mode !== 'mock') throw new AkbarError('DISABLED');
  }
  async search(p: SearchParams): Promise<NormalizedFare[]> {
    // IM/DM search is documented, but SmartPricer only documents ON/RT.
    if (p.tripType === "MULTICITY") throw new AkbarError("UNSUPPORTED");
    const deadline = Date.now() + Math.min(45000, Math.max(10, this.options.budgetMs ?? 20000));
    const started = await this.client.call('ExpressSearch', akbarSearchBody(p, this.options.multiCityFareType), deadline);
    const tui = text(started.TUI);
    let result: Record<string, any> | undefined;
    for (let poll = 0; poll < 50; poll++) {
      const d = await this.client.call('GetExpSearch', { TUI: tui }, deadline);
      if (d.TUI !== tui || ![true, false, 'True', 'False', 'true', 'false'].includes(d.Completed)) throw new AkbarError('INVALID_RESPONSE');
      result = d;
      if (d.Completed === true || String(d.Completed).toLowerCase() === 'true') break;
      if (poll === 49 || Date.now() >= deadline) throw new AkbarError('TIMEOUT');
      await new Promise(r => setTimeout(r, Math.min(this.options.pollMs ?? 250, Math.max(0, deadline - Date.now()))));
    }
    const fares: NormalizedFare[] = [];
    const groups = array(result!.Trips).map(t => array(record(t).Journey).map(record));
    const expectedLegs = p.tripType === 'ONEWAY' ? 1 : p.tripType === 'ROUNDTRIP' ? 2 : p.legs!.length;
    if (!groups.length || groups.every(g => !g.length)) return [];
    if (groups.length !== expectedLegs) throw new AkbarError('INVALID_RESPONSE');
    // Normal RT only. RS carrier/ReturnIdentifier pairing is intentionally unsupported.
    let combinations: Array<Array<Record<string, any>>> = [[]];
    for (const group of groups) {
      if (!group.length) return [];
      if (combinations.length * group.length > 20) throw new AkbarError('INVALID_RESPONSE');
      combinations = combinations.flatMap(c => group.map(j => [...c, j]));
    }
    for (const combination of combinations) {
      const selected = combination.map((j, leg) => ({
        Amount: number(j.NetFare), Index: text(j.Index),
        // Official collection uses OrderID=0; table sample uses 1 without a definition.
        // Mock convention only: must be confirmed before a network transport is added.
        OrderID: leg, TUI: tui,
      }));
      const pricing = await this.client.call('SmartPricer', { Trips: selected, Mode: 'AS', Options: 'A', Source: 'SF', TripType: p.tripType === 'ROUNDTRIP' ? 'RT' : 'ON' }, deadline);
      const details = await this.client.call('GetSPricer', { TUI: text(pricing.TUI) }, deadline);
      const baggage = combination.map(j => typeof j.Inclusions?.Baggage === 'string' ? j.Inclusions.Baggage : 'Not provided');
      fares.push(normalizeAkbarItinerary(details, `akbar:mock:${selected.map(j => j.Index).join(':')}`, [...new Set(baggage)].join(' / '), 0));
    }
    return fares;
  }
}
