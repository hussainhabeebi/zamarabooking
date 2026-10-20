"use client";
import { useParams } from "next/navigation";
import TripDetail from "../TripDetail";

export default function TripPage() {
  const { id } = useParams<{ id: string }>();
  return <TripDetail mode="customer" id={id} />;
}
