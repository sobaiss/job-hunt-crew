import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Backs the bare Admin area landing page (issue #138) — forwards the
// Session's isAdmin flag (issue #144, docs/adr/0015) alongside userId so
// services/api's `require_admin` can reject a non-Administrator caller the
// same way it trusts X-User-Id today.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return proxyToApi("/v1/admin/me", {
    headers: {
      "X-User-Id": session.user.id,
      "X-User-Is-Admin": session.user.isAdmin ? "true" : "false",
    },
  });
}
