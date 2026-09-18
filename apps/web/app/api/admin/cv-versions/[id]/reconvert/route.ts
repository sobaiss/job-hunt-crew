import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Triggers reconversion of a target candidate's CVVersion from the Admin CV
// versions table (issue #163) — the only write action that table offers.
// Ownership never moves to the admin caller; services/api derives it from
// the target CVVersion itself (docs/adr/0020).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  return proxyToApi(`/v1/admin/cv-versions/${id}/reconvert`, {
    method: "POST",
    headers,
  });
}
