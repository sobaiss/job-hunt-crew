import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const siteConfigs = await prisma.siteConfig.findMany({
    where: { enabled: true },
    orderBy: { displayName: "asc" },
  });

  return NextResponse.json({ siteConfigs });
}
