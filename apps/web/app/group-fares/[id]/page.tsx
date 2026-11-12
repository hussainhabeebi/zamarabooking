import type { Metadata } from "next";
import GroupFareDetail from "./GroupFareDetail";

export const metadata: Metadata = {
  title: "Group fare | ZamraBooking",
  description: "Group fare details, price and seats left. Book online with ZamraBooking.",
};

export default async function GroupFarePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GroupFareDetail id={id} />;
}
