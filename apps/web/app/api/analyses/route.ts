import { NextResponse } from "next/server";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sqs, ANALYSIS_INTAKE_QUEUE_URL } from "@/lib/sqs";

// PRD Section 9 (POST /api/analyses) / Section 10 steps 1-2: create the
// Analysis row and enqueue immediately, returning 202 without waiting on the
// crew run. The SQS-triggered Step Functions workflow that consumes this
// message (M5-T2+) doesn't exist yet — this task only covers the intake side.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = await request.json().catch(() => null);
  const jobOfferId = typeof body?.jobOfferId === "string" ? body.jobOfferId : undefined;
  const cvVersionId = typeof body?.cvVersionId === "string" ? body.cvVersionId : undefined;

  if (!jobOfferId || !cvVersionId) {
    return NextResponse.json({ error: "jobOfferId and cvVersionId are required" }, { status: 400 });
  }

  // JobOffer is globally deduplicated (not user-owned, PRD Section 6), so only
  // existence is checked; CVVersion is user-scoped and must belong to the caller.
  const [jobOffer, cvVersion] = await Promise.all([
    prisma.jobOffer.findUnique({ where: { id: jobOfferId } }),
    prisma.cVVersion.findUnique({ where: { id: cvVersionId } }),
  ]);
  if (!jobOffer) {
    return NextResponse.json({ error: "Unknown jobOfferId" }, { status: 400 });
  }
  if (!cvVersion || cvVersion.userId !== userId) {
    return NextResponse.json({ error: "Unknown cvVersionId" }, { status: 400 });
  }

  const analysis = await prisma.analysis.create({
    data: {
      userId,
      jobOfferId,
      cvVersionId,
      status: "PENDING",
    },
  });

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: ANALYSIS_INTAKE_QUEUE_URL,
      MessageBody: JSON.stringify({ analysisId: analysis.id }),
    }),
  );

  return NextResponse.json({ analysisId: analysis.id }, { status: 202 });
}
