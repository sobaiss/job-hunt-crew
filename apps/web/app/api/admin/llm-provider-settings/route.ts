import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Backs the Admin "LLM providers" screen (issue #174) — forwards the Session's
// Role so services/api's `require_admin` can reject a non-Administrator
// caller, same as the other admin routes.
export async function GET() {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return proxyToApi("/v1/admin/llm-provider-settings", { headers });
}
