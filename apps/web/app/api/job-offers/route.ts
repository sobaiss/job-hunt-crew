import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Thin proxy for the "Analyse one offer" known-offer shortcut (#29): the screen
// looks the pasted URL up (`?url=`) before deciding between the direct
// POST /api/analyses path and opening an IngestionJob.
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const search = new URL(request.url).search;

  return proxyToApi(`/v1/job-offers${search}`, {
    headers: { "X-User-Id": session.user.id },
  });
}
