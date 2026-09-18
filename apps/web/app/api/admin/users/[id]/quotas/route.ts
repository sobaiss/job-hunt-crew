import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Backs the admin per-user detail screen (issue #139) — forwards the
// Session's Plan alongside userId so services/api's `require_admin` can
// reject a non-Administrator caller, same as GET /api/admin/me (#138).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  return proxyToApi(`/v1/admin/users/${id}/quotas`, { headers });
}
