import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Backs the Audit history tab in the User panel (issue #150) — same
// X-User-Id/X-User-Is-Admin forwarding pattern as the other admin routes.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  return proxyToApi(`/v1/admin/users/${id}/audit-events`, { headers });
}
