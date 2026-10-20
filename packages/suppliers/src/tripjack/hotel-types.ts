// TripJack Hotels API — shared types for client, adapter and route

export interface HotelSearchParams {
  cityCode:     string;   // TripJack city code e.g. "DEL"
  checkIn:      string;   // YYYY-MM-DD
  checkOut:     string;   // YYYY-MM-DD
  rooms:        RoomInfo[];
  nationality:  string;   // 2-char ISO e.g. "IN"
  currency:     "INR" | "AED" | "USD";
  ratings?:     number[]; // [3, 4, 5]
  freeBreakfast?: boolean;
  freeCancel?:  boolean;
}

export interface RoomInfo {
  adults:   number;
  children: number;
  childAges?: number[];
}

export interface NormalizedHotel {
  id:             string;   // TripJack optionId
  hotelCode:      string;
  name:           string;
  starRating:     number;
  address:        string;
  cityCode:       string;
  checkIn:        string;
  checkOut:       string;
  nights:         number;
  rooms:          number;
  roomType:       string;
  mealPlan:       string;   // "EP" | "CP" | "MAP" | "AP"
  isRefundable:   boolean;
  baseFare:       number;
  taxes:          number;
  totalFare:      number;
  currency:       string;
  images:         string[];
  amenities:      string[];
  raw:            unknown;
}

export interface HotelPreBookResult {
  optionId:     string;
  isAvailable:  boolean;
  totalFare:    number;
  currency:     string;
  raw:          unknown;
}

export interface HotelBookParams {
  optionId:     string;
  contactName:  string;
  contactEmail: string;
  contactPhone: string;
  guests:       GuestInfo[];
}

export interface GuestInfo {
  roomIndex: number;
  title:     string;
  firstName: string;
  lastName:  string;
  type:      "ADULT" | "CHILD";
  age?:      number;
}

export interface HotelBookResult {
  success:    boolean;
  bookingRef: string;
  status:     string;
  raw:        unknown;
}

export interface HotelCancelResult {
  success:      boolean;
  refundAmount: number;
  penalty:      number;
  status:       string;
}
