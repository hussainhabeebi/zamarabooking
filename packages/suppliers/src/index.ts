export * from "./base.js";
export * from "./router.js";
export {
  akbarBaggage, splitAkbarBaggage, normalizeAllowance, baggageView, allowanceLabel, BAGGAGE_UNKNOWN_TEXT, NO_CHECKED_BAG_TEXT, NO_CABIN_BAG_TEXT,
  type BaggageStatus, type BaggageAllowance, type BaggageView, type StructuredBaggage,
} from "./baggage.js";
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
export { PoomasAdapter, PoomasError, normalizePoomasOffer } from "./poomas/adapter.js";
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
export {
  AkbarClient, AkbarError, AKBAR_TOKEN_TTL_SECONDS, signatureBody, expressSearchBody, smartPricerBody, fareRuleBody, flightInfoBody, ssrBody, seatLayoutBody, startPayBody, retrieveBookingBody, itineraryFinalStatus, createItineraryBody, akbarCode, akbarOk, akbarMessages, akbarNetAmount, akbarTransactionId, akbarBookingRefs, akbarTravelRequirements, isSearchComplete, searchTui, hasJourneys, mergeAkbarBatches,
  type AkbarCredentials, type AkbarToken, type AkbarExchange, type AkbarSearchOptions, type AkbarSearchTiming, type AkbarPricerTrip, type AkbarStartPay, type AkbarCreateItinerary, type AkbarContactInfo, type AkbarTraveller, type AkbarTravelRequirements,
} from "./akbar/client.js";
export {
  AKBAR_CANCEL_TYPE, AKBAR_IS_FULL_REFUND, AKBAR_CANCEL_CONFIRMED_CODE, AKBAR_CANCEL_PATHS, AKBAR_CANCEL_PATH_DEFAULT, AKBAR_GET_REFUND_PATH,
  akbarCancelPlan, akbarCancelBody, akbarCancelResult, akbarCallNotSent, akbarGetRefundBody, akbarRefundDetails,
  type AkbarCancelPath, type AkbarCancelPax, type AkbarCancelSegment, type AkbarCancelPlan, type AkbarCancelRequest, type AkbarCancelResult,
  type AkbarRefundLine, type AkbarRefundDetails,
} from "./akbar/cancellation.js";
export { akbarSsrBaggage, type SsrBaggageResult, type SsrSegmentBaggage } from "./akbar/ssr-baggage.js";
export { akbarWebSettings, akbarFeaturesFor, akbarSector, type AkbarFeatures, type WebSettingsMap, type FareScope } from "./akbar/websettings.js";
export { akbarRoundTripSearchBody, akbarRoundTripJourneys, akbarSpecialFarePairs, akbarSpecialFareCombinations, akbarSpecialFarePricerBody, akbarRoundTripPricerBody, type AkbarRoundTripFareType, type AkbarRoundTripPricerLeg } from "./akbar/roundtrip.js";
export { AkbarAdapter, AKBAR_SEARCH_POLLING, normalizeAkbarRoundTrip, akbarJourneyLegs, normalizeAkbarSearch, normalizeAkbarJourney, akbarJourneys, akbarDurationMinutes } from "./akbar/adapter.js";
