import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Backs the Admin analyses table (issue #161) — forwards every
// candidate/date-range filter plus pagination query param straight through
// unmodified (services/api owns their validation), plus the Session's Role
// so `require_admin` can reject a non-Administrator caller.
export async function GET(request: Request) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const qs = new URL(request.url).search;

  return proxyToApi(`/v1/admin/analyses${qs}`, { headers });
}
