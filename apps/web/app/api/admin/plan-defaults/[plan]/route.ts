import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Bulk-edits every QuotaKind default ceiling for one Plan together (issue
// #146, replacing the old per-kind route) — forwards the caller's own admin
// flag so `require_admin` can reject a non-Administrator caller, same as the
// per-user quota-override route (#139).
export async function PUT(request: Request, { params }: { params: Promise<{ plan: string }> }) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { plan } = await params;
  const body = await request.text();

  return proxyToApi(`/v1/admin/plan-defaults/${plan}`, {
    method: "PUT",
    headers,
    body,
  });
}
