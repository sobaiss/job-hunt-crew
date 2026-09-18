import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Backs the Admin users table (issue #147) — forwards every search/filter/
// sort/pagination query param straight through unmodified (services/api owns
// their validation), plus the Session's isAdmin so `require_admin` can reject
// a non-Administrator caller.
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const qs = new URL(request.url).search;

  return proxyToApi(`/v1/admin/users${qs}`, {
    headers: {
      "X-User-Id": session.user.id,
      "X-User-Is-Admin": session.user.isAdmin ? "true" : "false",
    },
  });
}
