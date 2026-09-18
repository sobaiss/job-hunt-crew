import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Sets/clears a target User's QuotaOverride for one QuotaKind from the admin
// per-user detail screen (issue #139) — forwards the caller's own Plan so
// `require_admin` can reject a non-Administrator caller.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, kind } = await params;
  const body = await request.text();

  return proxyToApi(`/v1/admin/users/${id}/quota-overrides/${kind}`, {
    method: "PUT",
    headers,
    body,
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, kind } = await params;

  return proxyToApi(`/v1/admin/users/${id}/quota-overrides/${kind}`, {
    method: "DELETE",
    headers,
  });
}
