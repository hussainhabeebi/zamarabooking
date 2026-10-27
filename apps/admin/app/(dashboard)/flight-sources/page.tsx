import { redirect } from "next/navigation";

// Flight sources are part of Admin → Suppliers now (Akbar's settings are in Integrations).
export default function FlightSourcesPage() {
  redirect("/suppliers");
}
