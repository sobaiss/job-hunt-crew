import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Backs the bare Admin area landing page (issue #138) — forwards the
// Session's Role (issue #156, docs/adr/0017) alongside userId so
// services/api's `require_admin` can reject a non-Administrator caller the
// same way it trusts X-User-Id today.
export async function GET() {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return proxyToApi("/v1/admin/me", { headers });
}
