import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Backs the Admin dashboard's global stats (issue #140, extended with a
// `period` param by #145) — forwards the query string through unmodified
// (services/api owns `period`'s validation) and the Session's isAdmin so
// `require_admin` can reject a non-Administrator caller, same as GET
// /api/admin/me (#138).
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const qs = new URL(request.url).search;

  return proxyToApi(`/v1/admin/stats${qs}`, {
    headers: {
      "X-User-Id": session.user.id,
      "X-User-Is-Admin": session.user.isAdmin ? "true" : "false",
    },
  });
}
