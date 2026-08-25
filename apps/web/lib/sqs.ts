import { SQSClient } from "@aws-sdk/client-sqs";

const globalForSqs = globalThis as unknown as {
  sqs: SQSClient | undefined;
};

const endpoint = process.env.SQS_ENDPOINT || undefined;

export const sqs =
  globalForSqs.sqs ??
  new SQSClient({
    region: process.env.SQS_REGION || "us-east-1",
    endpoint,
    credentials:
      process.env.SQS_ACCESS_KEY_ID && process.env.SQS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.SQS_ACCESS_KEY_ID,
            secretAccessKey: process.env.SQS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

if (process.env.NODE_ENV !== "production") {
  globalForSqs.sqs = sqs;
}

// Local dev points at the docker-compose ElasticMQ emulator (see
// elasticmq.conf), which pre-declares this queue; real AWS SQS would have
// this created via IaC (out of scope per PRD Section 4/15) and referenced by
// its actual queue URL here instead.
export const ANALYSIS_INTAKE_QUEUE_URL =
  process.env.SQS_ANALYSIS_INTAKE_QUEUE_URL || "http://localhost:9324/000000000000/analysis-intake";
