import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Makes one LLM provider the Active LLM provider (issue #176). Forwards the
// Session's Role so `require_admin` can reject a non-Administrator caller,
// same as the other admin routes.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ providerKey: string }> },
) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { providerKey } = await params;

  return proxyToApi(
    `/v1/admin/llm-provider-settings/${encodeURIComponent(providerKey)}/activate`,
    { method: "POST", headers },
  );
}
