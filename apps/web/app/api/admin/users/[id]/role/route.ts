import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Sets a target User's Role (issue #156, replacing the isAdmin grant/revoke
// from #149 per docs/adr/0017) — forwards the caller's own Role so
// `require_admin` can reject a non-Administrator caller.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.text();

  return proxyToApi(`/v1/admin/users/${id}/role`, {
    method: "PUT",
    headers,
    body,
  });
}
