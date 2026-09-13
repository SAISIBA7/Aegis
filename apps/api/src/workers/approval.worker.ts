import { Worker, Job as BullJob } from "bullmq";
import {
  REMEDIATION_QUEUE_NAME,
  RemediationJobData,
  redisConnection,
} from "../queue";
import { executeApprovalPipeline } from "../approval/pipeline";

/**
 * Worker processing approved jobs through the Kyverno policy gate and Executor.
 */
export async function processRemediationJob(
  bullJob: BullJob<RemediationJobData>
): Promise<void> {
  const { jobId, approver } = bullJob.data;
  console.log(
    `[ApprovalWorker] Starting approval pipeline for job ${jobId} (approver: '${approver || "operator"}')...`
  );

  await executeApprovalPipeline(jobId, approver);
}

/**
 * Initializes and returns the BullMQ Worker for the remediation queue.
 */
export function initApprovalWorker(): Worker<RemediationJobData> {
  console.log(
    `[ApprovalWorker] Initializing worker on queue '${REMEDIATION_QUEUE_NAME}'...`
  );

  const worker = new Worker<RemediationJobData>(
    REMEDIATION_QUEUE_NAME,
    processRemediationJob,
    {
      connection: redisConnection,
      concurrency: 3,
    }
  );

  worker.on("completed", (job) => {
    console.log(
      `[ApprovalWorker] Remediation pipeline job ${job.id} (DB Job: ${job.data.jobId}) completed.`
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[ApprovalWorker] Remediation pipeline job ${job?.id} (DB Job: ${job?.data.jobId}) failed:`,
      err.message
    );
  });

  return worker;
}
