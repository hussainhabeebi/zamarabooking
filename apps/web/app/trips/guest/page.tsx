"use client";
import TripDetail from "../TripDetail";

// Guest view: authorised by the trip token saved by /trips/find.
export default function GuestTripPage() {
  return <TripDetail mode="guest" />;
}
