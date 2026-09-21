import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Saves one LLM provider's parameters (issue #175). The body is forwarded
// untouched and never logged here — it will carry secrets once they can be
// stored (#179). Forwards the Session's Role so `require_admin` can reject a
// non-Administrator caller, same as the other admin routes.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ providerKey: string }> },
) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { providerKey } = await params;
  const body = await request.text();

  return proxyToApi(`/v1/admin/llm-provider-settings/${encodeURIComponent(providerKey)}`, {
    method: "PUT",
    headers,
    body,
  });
}
