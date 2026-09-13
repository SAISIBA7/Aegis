import { Worker, Job as BullJob } from "bullmq";
import { JobStatus } from "@aegis/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { transitionJobStatus } from "../stateMachine";
import {
  DIAGNOSTIC_QUEUE_NAME,
  DiagnosticJobData,
  redisConnection,
} from "../queue";
import { AgentGateway } from "../agentgateway";
import { KAgent } from "../kagent";
import { DiagnosticProposalSchema } from "../schemas";

/**
 * Main handler for diagnostic jobs enqueued when a deployment fails.
 * Gathers read-only cluster data via AgentGateway, queries kagent (Nemotron 3.5),
 * validates the structured proposal schema, and updates Job status.
 */
export async function processDiagnosticJob(
  bullJob: BullJob<DiagnosticJobData>
): Promise<void> {
  const { jobId, appName, namespace, failureDetails } = bullJob.data;
  console.log(
    `[DiagnosticWorker] Starting failure diagnosis for job ${jobId} (app: '${appName}', ns: '${namespace}')...`
  );

  const gateway = new AgentGateway("kind-aegis");
  const kagent = new KAgent();

  try {
    // 1. Run diagnosis through kagent using read-only tools on AgentGateway
    const { proposal, rawResponse } = await kagent.diagnoseFailure(
      gateway,
      appName,
      namespace,
      failureDetails
    );

    console.log(
      `[DiagnosticWorker] Received proposal from kagent for app '${appName}':`,
      JSON.stringify(proposal)
    );

    // 2. Validate proposal shape against Zod schema
    const validationResult = DiagnosticProposalSchema.safeParse(proposal);

    if (validationResult.success) {
      const validProposal = validationResult.data;
      console.log(
        `[DiagnosticWorker] Proposal successfully validated. Transitioning job ${jobId} -> PROPOSAL_GENERATED`
      );

      // 3. Transition: DIAGNOSING -> PROPOSAL_GENERATED (persisting proposal and gateway trace)
      await transitionJobStatus(
        prisma,
        jobId,
        JobStatus.PROPOSAL_GENERATED,
        {
          step: "diagnosis_completed",
          appName,
          remediationAction: validProposal.actionType,
          target: validProposal.target,
          reasoning: validProposal.reasoning,
          proposal: validProposal,
          agentGatewayTraces: gateway.getTraces(),
        } as unknown as Prisma.InputJsonValue,
        validProposal as unknown as Prisma.InputJsonValue
      );

      // 4. Transition: PROPOSAL_GENERATED -> PENDING_APPROVAL
      console.log(
        `[DiagnosticWorker] Advancing job ${jobId} -> PENDING_APPROVAL for human review`
      );
      await transitionJobStatus(
        prisma,
        jobId,
        JobStatus.PENDING_APPROVAL,
        {
          step: "awaiting_human_approval",
          appName,
          remediationAction: validProposal.actionType,
          target: validProposal.target,
        } as unknown as Prisma.InputJsonValue
      );
    } else {
      const validationErrors = validationResult.error.flatten();
      console.error(
        `[DiagnosticWorker] Proposal failed schema validation for job ${jobId}:`,
        validationErrors
      );

      // 4. Transition: DIAGNOSING -> FAILED on malformed proposal
      await transitionJobStatus(prisma, jobId, JobStatus.FAILED, {
        step: "proposal_validation_failed",
        appName,
        error: "AI diagnostic proposal failed schema validation",
        validationDetails: validationErrors,
        rawResponse,
        agentGatewayTraces: gateway.getTraces(),
      } as unknown as Prisma.InputJsonValue);
    }
  } catch (error: any) {
    console.error(
      `[DiagnosticWorker] Diagnosis failed for job ${jobId}:`,
      error.message
    );

    // 5. Transition: DIAGNOSING -> FAILED on circuit breaker / API / cluster failure
    await transitionJobStatus(prisma, jobId, JobStatus.FAILED, {
      step: "diagnosis_execution_failed",
      appName,
      error: error.message,
      agentGatewayTraces: gateway.getTraces(),
    } as unknown as Prisma.InputJsonValue);
  }
}

/**
 * Initializes and returns the BullMQ Worker for the diagnostic queue.
 */
export function initDiagnosticWorker(): Worker<DiagnosticJobData> {
  console.log(`[DiagnosticWorker] Initializing worker on queue '${DIAGNOSTIC_QUEUE_NAME}'...`);

  const worker = new Worker<DiagnosticJobData>(
    DIAGNOSTIC_QUEUE_NAME,
    processDiagnosticJob,
    {
      connection: redisConnection,
      concurrency: 3,
    }
  );

  worker.on("completed", (job) => {
    console.log(
      `[DiagnosticWorker] Diagnostic job ${job.id} (DB Job: ${job.data.jobId}) completed.`
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[DiagnosticWorker] Diagnostic job ${job?.id} (DB Job: ${job?.data.jobId}) failed:`,
      err.message
    );
  });

  return worker;
}
