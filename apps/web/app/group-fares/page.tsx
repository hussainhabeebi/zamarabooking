import type { Metadata } from "next";
import GroupFaresList from "./GroupFaresList";

export const metadata: Metadata = {
  title: "Group fares | ZamraBooking",
  description: "Special group fares on selected flights from ZamraBooking. See the price and seats left, then book online.",
};

export default function GroupFaresPage() {
  return <GroupFaresList />;
}
