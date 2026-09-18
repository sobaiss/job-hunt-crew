import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Blocks/unblocks a target User from the Admin users table row action and
// the User panel (issue #148) — forwards the caller's own admin flag so
// `require_admin` can reject a non-Administrator caller.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.text();

  return proxyToApi(`/v1/admin/users/${id}/blocked`, {
    method: "PUT",
    headers,
    body,
  });
}
