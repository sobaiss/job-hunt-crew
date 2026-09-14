import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const format = new URL(request.url).searchParams.get("format");

  return proxyToApi(
    `/v1/generated-documents/${id}/download${format ? `?format=${encodeURIComponent(format)}` : ""}`,
    { headers: { "X-User-Id": session.user.id } },
  );
}
