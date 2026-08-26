import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const search = new URL(request.url).search;

  return proxyToApi(`/v1/analyses${search}`, {
    headers: { "X-User-Id": session.user.id },
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.text();

  return proxyToApi("/v1/analyses", {
    method: "POST",
    headers: { "X-User-Id": session.user.id },
    body,
  });
}
