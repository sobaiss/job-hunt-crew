import { S3Client } from "@aws-sdk/client-s3";

const globalForS3 = globalThis as unknown as {
  s3: S3Client | undefined;
};

const endpoint = process.env.S3_ENDPOINT || undefined;

export const s3 =
  globalForS3.s3 ??
  new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint,
    // Path-style addressing is required for MinIO/local S3-compatible
    // endpoints; real AWS S3 ignores this when unset.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

if (process.env.NODE_ENV !== "production") {
  globalForS3.s3 = s3;
}

export const S3_BUCKET = process.env.S3_BUCKET || "job-hunt-crew";

export function cvFileKey(userId: string, cvVersionId: string, fileName: string) {
  return `cvs/${userId}/${cvVersionId}/${fileName}`;
}
