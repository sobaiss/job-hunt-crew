import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { adminSessionHeaders, proxyToApi } from "@/lib/internal-api";

// Resumes a target candidate's paused Scout from the Admin scouts table
// (issue #162). Rejected (409) for an ARCHIVED Scout by services/api — there
// is no admin-facing unarchive/resume-from-archived. Ownership never moves
// to the admin caller; services/api derives it from the target Scout itself
// (docs/adr/0020).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = adminSessionHeaders(await auth());
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  return proxyToApi(`/v1/admin/scouts/${id}/resume`, {
    method: "POST",
    headers,
  });
}
