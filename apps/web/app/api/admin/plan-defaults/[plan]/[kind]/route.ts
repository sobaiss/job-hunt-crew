import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Edits one Plan's default ceiling for one QuotaKind (issue #140) — forwards
// the caller's own Plan so `require_admin` can reject a non-Administrator
// caller, same as the per-user quota-override route (#139).
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ plan: string; kind: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { plan, kind } = await params;
  const body = await request.text();

  return proxyToApi(`/v1/admin/plan-defaults/${plan}/${kind}`, {
    method: "PUT",
    headers: {
      "X-User-Id": session.user.id,
      "X-User-Is-Admin": session.user.isAdmin ? "true" : "false",
    },
    body,
  });
}
