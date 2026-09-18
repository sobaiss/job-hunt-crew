import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Backs the Audit history tab in the User panel (issue #150) — same
// X-User-Id/X-User-Is-Admin forwarding pattern as the other admin routes.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  return proxyToApi(`/v1/admin/users/${id}/audit-events`, {
    headers: {
      "X-User-Id": session.user.id,
      "X-User-Is-Admin": session.user.isAdmin ? "true" : "false",
    },
  });
}
