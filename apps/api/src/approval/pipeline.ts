import { JobStatus } from "@aegis/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { transitionJobStatus } from "../stateMachine";
import { evaluateKyvernoPolicy } from "./kyverno";
import { executeAction, ExecutorAction } from "../executor";

export interface ApprovalPipelineResult {
  success: boolean;
  status: JobStatus;
  error?: string;
}

/**
 * Sequential execution pipeline: APPROVED -> APPLYING -> {EXECUTED | POLICY_VIOLATED | FAILED}
 *
 * Sequence:
 * 1. Confirms the job is in APPROVED state.
 * 2. Transitions APPROVED -> APPLYING (writes audit log).
 * 3. Runs the Kyverno policy check against the stored proposal.
 *    - If policy fails: transitions APPLYING -> POLICY_VIOLATED. Stops immediately. Executor is NEVER called.
 *    - If policy passes: proceeds to step 4.
 * 4. Calls the Executor with the exact (actionType, params) pair from the stored proposal.
 *    - If Executor succeeds: transitions APPLYING -> EXECUTED.
 *    - If Executor throws/fails: transitions APPLYING -> FAILED with error captured in audit log.
 */
export async function executeApprovalPipeline(
  jobId: string,
  approver?: string
): Promise<ApprovalPipelineResult> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  if (job.status !== JobStatus.APPROVED) {
    throw new Error(
      `Invalid state for approval pipeline: job ${jobId} is in '${job.status}', expected '${JobStatus.APPROVED}'`
    );
  }

  const proposal = job.proposal as unknown as {
    actionType: ExecutorAction["actionType"];
    target: string;
    params: Record<string, unknown>;
    reasoning?: string;
  } | null;

  if (!proposal || !proposal.actionType || !proposal.target || !proposal.params) {
    // Transition to FAILED if proposal data is missing or corrupted
    await transitionJobStatus(
      prisma,
      jobId,
      JobStatus.FAILED,
      {
        step: "approval_pipeline_error",
        error: "Missing or malformed proposal data on approved job",
      } as unknown as Prisma.InputJsonValue
    );
    return {
      success: false,
      status: JobStatus.FAILED,
      error: "Missing or malformed proposal data on approved job",
    };
  }

  // 1. Transition: APPROVED -> APPLYING
  console.log(
    `[ApprovalPipeline] Transitioning job ${jobId} -> APPLYING (action: ${proposal.actionType}, target: ${proposal.target})`
  );
  await transitionJobStatus(
    prisma,
    jobId,
    JobStatus.APPLYING,
    {
      step: "approval_pipeline_started",
      approver: approver || "operator",
      actionType: proposal.actionType,
      target: proposal.target,
      params: proposal.params,
    } as unknown as Prisma.InputJsonValue
  );

  // 2. Run independent Kyverno policy check
  console.log(
    `[ApprovalPipeline] Evaluating Kyverno policy for job ${jobId} (${proposal.actionType})...`
  );
  const policyResult = await evaluateKyvernoPolicy(
    proposal.actionType,
    proposal.target,
    proposal.params
  );

  if (!policyResult.allowed) {
    console.warn(
      `[ApprovalPipeline] Policy violation for job ${jobId}: ${policyResult.reason}`
    );

    // Transition: APPLYING -> POLICY_VIOLATED (terminal)
    // CRITICAL: The Executor is NEVER called on this path
    await transitionJobStatus(
      prisma,
      jobId,
      JobStatus.POLICY_VIOLATED,
      {
        step: "kyverno_policy_violation",
        actionType: proposal.actionType,
        target: proposal.target,
        params: proposal.params,
        reason: policyResult.reason,
        details: policyResult.details,
      } as unknown as Prisma.InputJsonValue
    );

    return {
      success: false,
      status: JobStatus.POLICY_VIOLATED,
      error: policyResult.reason,
    };
  }

  console.log(
    `[ApprovalPipeline] Kyverno policy check passed for job ${jobId}. Invoking Executor...`
  );

  // 3. Kyverno passed -> Call the Executor with the exact stored proposal
  try {
    const execResult = await executeAction(
      {
        actionType: proposal.actionType,
        params: proposal.params,
      },
      proposal.target
    );

    if (execResult.success) {
      console.log(
        `[ApprovalPipeline] Executor succeeded for job ${jobId}. Transitioning -> EXECUTED`
      );

      // Transition: APPLYING -> EXECUTED (terminal)
      await transitionJobStatus(
        prisma,
        jobId,
        JobStatus.EXECUTED,
        {
          step: "executor_completed",
          actionType: proposal.actionType,
          target: proposal.target,
          result: execResult.details,
          message: execResult.message,
        } as unknown as Prisma.InputJsonValue
      );

      return {
        success: true,
        status: JobStatus.EXECUTED,
      };
    } else {
      console.error(
        `[ApprovalPipeline] Executor returned failure for job ${jobId}: ${execResult.message}`
      );

      // Transition: APPLYING -> FAILED (terminal)
      await transitionJobStatus(
        prisma,
        jobId,
        JobStatus.FAILED,
        {
          step: "executor_failed",
          actionType: proposal.actionType,
          target: proposal.target,
          error: execResult.message,
          details: execResult.details,
        } as unknown as Prisma.InputJsonValue
      );

      return {
        success: false,
        status: JobStatus.FAILED,
        error: execResult.message,
      };
    }
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[ApprovalPipeline] Executor threw unhandled exception for job ${jobId}:`,
      errorMsg
    );

    // Transition: APPLYING -> FAILED (terminal)
    await transitionJobStatus(
      prisma,
      jobId,
      JobStatus.FAILED,
      {
        step: "executor_exception",
        actionType: proposal.actionType,
        target: proposal.target,
        error: errorMsg,
      } as unknown as Prisma.InputJsonValue
    );

    return {
      success: false,
      status: JobStatus.FAILED,
      error: errorMsg,
    };
  }
}
