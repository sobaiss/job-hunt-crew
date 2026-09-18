import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Backs the admin reporting screen's user list (issue #140) — forwards the
// atOrOverLimit filter straight through, and the Session's Plan so
// `require_admin` can reject a non-Administrator caller.
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const atOrOverLimit = new URL(request.url).searchParams.get("atOrOverLimit");

  return proxyToApi(
    `/v1/admin/users${atOrOverLimit ? `?atOrOverLimit=${encodeURIComponent(atOrOverLimit)}` : ""}`,
    {
      headers: {
        "X-User-Id": session.user.id,
        "X-User-Is-Admin": session.user.isAdmin ? "true" : "false",
      },
    },
  );
}
