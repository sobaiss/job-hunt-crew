import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { proxyToApi } from "@/lib/internal-api";

// The CV filter's options on the Analyses table — the CVVersion labels the
// candidate's analyses actually use, which the client used to read off the
// full list it no longer holds.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return proxyToApi("/v1/analyses/cv-labels", {
    headers: { "X-User-Id": session.user.id },
  });
}
