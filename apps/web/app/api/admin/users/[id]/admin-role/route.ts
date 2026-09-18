import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Grants/revokes a target User's admin role from the User panel (issue
// #149) — forwards the caller's own admin flag so `require_admin` can
// reject a non-Administrator caller.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.text();

  return proxyToApi(`/v1/admin/users/${id}/admin-role`, {
    method: "PUT",
    headers,
    body,
  });
}
