import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const existing = await prisma.cVVersion.findUnique({ where: { id } });
  if (!existing || existing.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : undefined;
  const isDefault = typeof body?.isDefault === "boolean" ? body.isDefault : undefined;

  if (label === undefined && isDefault === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  if (label !== undefined && !label) {
    return NextResponse.json({ error: "label must not be empty" }, { status: 400 });
  }

  const cvVersion = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.cVVersion.updateMany({
        where: { userId, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      });
    }
    return tx.cVVersion.update({
      where: { id },
      data: {
        ...(label !== undefined ? { label } : {}),
        ...(isDefault !== undefined ? { isDefault } : {}),
      },
    });
  });

  return NextResponse.json({ cvVersion });
}
