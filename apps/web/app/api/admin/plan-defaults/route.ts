import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Backs the admin plan-defaults editor (issue #140) — forwards the Session's
// Plan so services/api's `require_admin` can reject a non-Administrator
// caller, same as GET /api/admin/me (#138).
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return proxyToApi("/v1/admin/plan-defaults", {
    headers: {
      "X-User-Id": session.user.id,
      "X-User-Plan": session.user.plan ?? "",
    },
  });
}
