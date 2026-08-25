import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const ingestionJob = await prisma.ingestionJob.findUnique({
    where: { id },
    include: {
      jobOffers: {
        include: { jobOffer: true },
      },
    },
  });
  if (!ingestionJob || ingestionJob.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ingestionJob });
}
