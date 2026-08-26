import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.text();

  return proxyToApi("/v1/ingestion-jobs", {
    method: "POST",
    headers: { "X-User-Id": session.user.id },
    body,
  });
}
