import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// Re-drives a stuck Analysis in place — the same row back to PENDING, no new
// Analysis and no quota charged (docs/adr/0032). Distinct from the "Relancer
// l'analyse" of a terminal Analysis, which is `POST /api/analyses`
// (docs/adr/0011) and does create a new row.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  return proxyToApi(`/v1/analyses/${id}/requeue`, {
    method: "POST",
    headers: { "X-User-Id": session.user.id },
  });
}
