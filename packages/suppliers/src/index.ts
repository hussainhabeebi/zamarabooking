export * from "./base.js";
export * from "./router.js";
export { RiyaAdapter }          from "./riya/adapter.js";
export { TripjackAdapter }      from "./tripjack/adapter.js";
export { TripjackClient }       from "./tripjack/client.js";
export { TripjackHotelAdapter } from "./tripjack/hotel-adapter.js";
export {
  TripjackHotelV3Client, validHotelId, TripjackHotelError, isHotelError, normalizeOption, normalizeContent,
  parseHotelBookingDetails, HOTEL_TERMINAL_STATUSES,
  type HotelV3Room, type HotelV3Option, type HotelV3Pricing, type HotelV3Content, type HotelV3ListingHotel,
} from "./tripjack/hotel-v3.js";
export type {
  HotelSearchParams, NormalizedHotel, HotelPreBookResult,
  HotelBookParams, HotelBookResult, HotelCancelResult,
  RoomInfo, GuestInfo,
} from "./tripjack/hotel-types.js";
// Duffel and SERP adapters kept for future re-enablement
export { SerpAdapter }   from "./serp/adapter.js";
export { DuffelAdapter } from "./duffel/adapter.js";
export type { SupplierExchange, ExchangeRecorder } from "./tripjack/client.js";
export {
  parseTripjackReview, reviewTotalFare, ssrTotal,
  type ReviewSummary, type ReviewSegment, type ReviewConditions, type SsrOption,
} from "./tripjack/review.js";
export { searchLegs } from "./tripjack/client.js";
export { parseTripjackFareRules } from "./tripjack/adapter.js";
export {
  TripjackInsuranceClient, TripsafeError, tripsafeProblems, tripsafeSearchBody, normalizeTripsafeProduct,
  parseTripsafeBooking, ageOn, addDays, daysBetween,
  TRIPSAFE_STUDENT_DURATIONS, TRIPSAFE_AMT_DURATIONS, TRIPSAFE_REGIONS, TRIPSAFE_BLOCKED_COUNTRIES,
  TRIPSAFE_MAX_TRAVELLERS, TRIPSAFE_MAX_AGE, TRIPSAFE_NOMINEE_RELATIONSHIPS, TRIPSAFE_TERMINAL_STATUSES,
  type TripsafeJourney, type TripsafeDestination, type TripsafeSearchRequest, type TripsafeProduct,
  type TripsafeTraveller, type TripsafeBookRequest, type TripsafeBookResult, type TripsafeAmendmentRequest,
  type TripsafeConfirmRequest, type TripsafeAmendmentResult, type TripsafeBookingDetails, type TripsafeTripInput,
} from "./tripjack/insurance.js";
export { parseTripjackSeatMap, seatTotal, type SeatOption, type SegmentSeatMap } from "./tripjack/seat-map.js";
