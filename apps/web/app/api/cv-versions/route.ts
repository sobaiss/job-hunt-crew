import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { cvFileKey, s3, S3_BUCKET } from "@/lib/s3";

const CONTENT_TYPE_TO_FILE_TYPE: Record<string, "PDF" | "DOCX"> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
};

const UPLOAD_URL_EXPIRY_SECONDS = 300;
// PRD Section 13 default: CV max size 10MB.
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cvVersions = await prisma.cVVersion.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ cvVersions });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const fileName = typeof body?.fileName === "string" ? body.fileName.trim() : "";
  const contentType = typeof body?.contentType === "string" ? body.contentType : "";
  const fileSizeBytes = Number(body?.fileSizeBytes);

  if (!label) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }
  if (!fileName) {
    return NextResponse.json({ error: "fileName is required" }, { status: 400 });
  }
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
    return NextResponse.json({ error: "fileSizeBytes must be a positive number" }, { status: 400 });
  }

  const fileType = CONTENT_TYPE_TO_FILE_TYPE[contentType];
  if (!fileType) {
    return NextResponse.json(
      { error: "Unsupported file type; only PDF and DOCX are supported" },
      { status: 400 },
    );
  }
  if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      { error: `File too large; max size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB` },
      { status: 400 },
    );
  }

  const userId = session.user.id;
  const cvVersionId = crypto.randomUUID();
  const fileKey = cvFileKey(userId, cvVersionId, fileName);

  const cvVersion = await prisma.cVVersion.create({
    data: {
      id: cvVersionId,
      userId,
      label,
      fileKey,
      fileName,
      fileType,
      fileSizeBytes,
    },
  });

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: fileKey,
      ContentType: contentType,
    }),
    { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
  );

  return NextResponse.json(
    {
      cvVersionId: cvVersion.id,
      fileKey,
      uploadUrl,
    },
    { status: 201 },
  );
}
