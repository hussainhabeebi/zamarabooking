"use client";
import { useParams } from "next/navigation";
import Receipt from "../../Receipt";

export default function TripReceiptPage() {
  const { id } = useParams<{ id: string }>();
  return <Receipt mode="customer" id={id} />;
}
