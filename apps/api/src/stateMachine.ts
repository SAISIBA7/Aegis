import { PrismaClient, Prisma, Job } from "@prisma/client";
import { JobStatus } from "@aegis/shared";

export class IllegalStateTransitionError extends Error {
  readonly jobId: string;
  readonly fromStatus: JobStatus;
  readonly toStatus: JobStatus;

  constructor(jobId: string, fromStatus: JobStatus, toStatus: JobStatus) {
    super(
      `Illegal state transition for job ${jobId}: cannot transition from '${fromStatus}' to '${toStatus}'`
    );
    this.name = "IllegalStateTransitionError";
    this.jobId = jobId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
    Object.setPrototypeOf(this, IllegalStateTransitionError.prototype);
  }
}

export class JobNotFoundError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = "JobNotFoundError";
    this.jobId = jobId;
    Object.setPrototypeOf(this, JobNotFoundError.prototype);
  }
}

/**
 * Valid state transitions table.
 * Note: PENDING_APPROVAL -> [APPROVED, REJECTED, FAILED]
 *       APPROVED -> [APPLYING, POLICY_VIOLATED, FAILED]
 * Policy check is sequential after human approval.
 */
export const LEGAL_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  [JobStatus.INITIATED]: [JobStatus.PROVISIONING, JobStatus.FAILED],
  [JobStatus.PROVISIONING]: [
    JobStatus.EXECUTED,
    JobStatus.DIAGNOSING,
    JobStatus.FAILED,
  ],
  [JobStatus.DIAGNOSING]: [JobStatus.PROPOSAL_GENERATED, JobStatus.FAILED],
  [JobStatus.PROPOSAL_GENERATED]: [JobStatus.PENDING_APPROVAL, JobStatus.FAILED],
  [JobStatus.PENDING_APPROVAL]: [
    JobStatus.APPROVED,
    JobStatus.REJECTED,
    JobStatus.FAILED,
  ],
  [JobStatus.APPROVED]: [
    JobStatus.APPLYING,
    JobStatus.POLICY_VIOLATED,
    JobStatus.FAILED,
  ],
  [JobStatus.APPLYING]: [JobStatus.EXECUTED, JobStatus.FAILED],
  // Terminal states (no further transitions allowed)
  [JobStatus.EXECUTED]: [],
  [JobStatus.FAILED]: [],
  [JobStatus.REJECTED]: [],
  [JobStatus.POLICY_VIOLATED]: [],
};

/**
 * Checks whether transitioning from `fromStatus` to `toStatus` is permitted.
 */
export function isValidTransition(
  fromStatus: JobStatus,
  toStatus: JobStatus
): boolean {
  const allowed = LEGAL_TRANSITIONS[fromStatus];
  return allowed ? allowed.includes(toStatus) : false;
}

/**
 * Owns all status changes for Jobs in the system.
 * Throws IllegalStateTransitionError if the requested transition is illegal.
 * Atomically updates Job.status and records an AuditLog entry.
 */
export async function transitionJobStatus(
  prismaClient: PrismaClient,
  jobId: string,
  toStatus: JobStatus,
  metadata?: Prisma.InputJsonValue,
  proposal?: Prisma.InputJsonValue
): Promise<Job> {
  return await prismaClient.$transaction(async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const currentStatus = job.status as JobStatus;

    if (!isValidTransition(currentStatus, toStatus)) {
      throw new IllegalStateTransitionError(jobId, currentStatus, toStatus);
    }

    const updatedJob = await tx.job.update({
      where: { id: jobId },
      data: {
        status: toStatus,
        ...(proposal !== undefined ? { proposal: proposal ?? Prisma.DbNull } : {}),
      },
    });

    await tx.auditLog.create({
      data: {
        jobId,
        fromStatus: currentStatus,
        toStatus,
        metadata: metadata ?? undefined,
      },
    });

    return updatedJob;
  });
}

/**
 * Creates a new Job with an initial status (default: INITIATED) and writes
 * the initial AuditLog entry in a single atomic transaction.
 */
export async function createJob(
  prismaClient: PrismaClient,
  params: {
    type: string;
    payload: Prisma.InputJsonValue;
    status?: JobStatus;
    metadata?: Prisma.InputJsonValue;
  }
): Promise<Job> {
  const initialStatus = params.status ?? JobStatus.INITIATED;

  return await prismaClient.$transaction(async (tx) => {
    const job = await tx.job.create({
      data: {
        type: params.type,
        status: initialStatus,
        payload: params.payload,
      },
    });

    await tx.auditLog.create({
      data: {
        jobId: job.id,
        fromStatus: null,
        toStatus: initialStatus,
        metadata: params.metadata ?? undefined,
      },
    });

    return job;
  });
}
