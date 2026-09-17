import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Reassigns a target User's Plan from the admin per-user detail screen
// (issue #139) — forwards the caller's own Plan so `require_admin` can
// reject a non-Administrator caller.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.text();

  return proxyToApi(`/v1/admin/users/${id}/plan`, {
    method: "PUT",
    headers: {
      "X-User-Id": session.user.id,
      "X-User-Plan": session.user.plan ?? "",
    },
    body,
  });
}
