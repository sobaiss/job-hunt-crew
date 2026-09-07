import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { LandingPage } from "@/components/landing-page";

// The public front door. A signed-out Visitor sees the marketing page; a
// signed-in Candidate is sent straight to the signed-in area so they never see
// the marketing page twice. (Slice 05 changes this redirect target from
// `/analyses` to the real Dashboard.)
export default async function LandingRoute() {
  const session = await auth();
  if (session?.user) {
    redirect("/analyses");
  }

  return <LandingPage />;
}
