import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Edits a target User's name from the User panel (issue #149) — forwards
// the caller's own admin flag so `require_admin` can reject a non-Administrator
// caller. Email is never sent here; the underlying endpoint never accepts it.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.text();

  return proxyToApi(`/v1/admin/users/${id}/info`, {
    method: "PUT",
    headers: {
      "X-User-Id": session.user.id,
      "X-User-Is-Admin": session.user.isAdmin ? "true" : "false",
    },
    body,
  });
}
