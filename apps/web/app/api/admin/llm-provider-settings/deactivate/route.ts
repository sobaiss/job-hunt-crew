import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Returns control of the LLM provider to the environment (issue #176).
// Forwards the Session's Role so `require_admin` can reject a non-Administrator
// caller, same as the other admin routes.
export async function POST() {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return proxyToApi("/v1/admin/llm-provider-settings/deactivate", { method: "POST", headers });
}
