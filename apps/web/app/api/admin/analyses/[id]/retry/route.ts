import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Triggers "Relancer l'analyse" for a target candidate's Analysis from the
// Admin analyses table (issue #161). Ownership never moves to the admin
// caller; services/api derives it from the target Analysis itself
// (docs/adr/0020).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  return proxyToApi(`/v1/admin/analyses/${id}/retry`, {
    method: "POST",
    headers,
  });
}
