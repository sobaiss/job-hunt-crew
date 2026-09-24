import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// The Dashboard's tiles and Match-score trend over *all* of the candidate's
// analyses. It used to derive them in the browser from the full `/api/analyses`
// list; once that list became paginated, the Dashboard was the one caller left
// that would still have pulled every row.
//
// A static segment, so it never reaches `[id]/route.ts` — Next.js matches
// static before dynamic.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return proxyToApi("/v1/analyses/stats", {
    headers: { "X-User-Id": session.user.id },
  });
}
