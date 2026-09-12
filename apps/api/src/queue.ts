import { Queue } from "bullmq";
import Redis from "ioredis";
import dotenv from "dotenv";
import path from "path";
import { CreateDeploymentRequest } from "./schemas";

// Ensure environment variables are loaded
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/**
 * Shared Redis connection options for BullMQ.
 * Note: BullMQ requires `maxRetriesPerRequest: null`.
 */
export const redisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const PROVISIONING_QUEUE_NAME = "provisioning-queue";

export interface ProvisioningJobData {
  jobId: string;
  payload: CreateDeploymentRequest;
}

export const provisioningQueue = new Queue<ProvisioningJobData>(
  PROVISIONING_QUEUE_NAME,
  {
    connection: redisConnection,
  }
);

/**
 * Enqueues a deployment job for background Terraform provisioning.
 */
export async function enqueueProvisioningJob(
  jobId: string,
  payload: CreateDeploymentRequest
): Promise<void> {
  await provisioningQueue.add(
    "provision-deployment",
    { jobId, payload },
    {
      jobId, // Use the database job UUID as the BullMQ job ID
      removeOnComplete: 100,
      removeOnFail: 100,
    }
  );
}

export const DIAGNOSTIC_QUEUE_NAME = "diagnostic-queue";

export interface DiagnosticJobData {
  jobId: string;
  appName: string;
  namespace: string;
  failureDetails?: string;
}

export const diagnosticQueue = new Queue<DiagnosticJobData>(
  DIAGNOSTIC_QUEUE_NAME,
  {
    connection: redisConnection,
  }
);

/**
 * Enqueues a failed deployment job for AI diagnosis by kagent.
 */
export async function enqueueDiagnosticJob(
  jobId: string,
  appName: string,
  namespace: string,
  failureDetails?: string
): Promise<void> {
  await diagnosticQueue.add(
    "diagnose-failure",
    { jobId, appName, namespace, failureDetails },
    {
      jobId: `diag-${jobId}`,
      removeOnComplete: 100,
      removeOnFail: 100,
    }
  );
}
