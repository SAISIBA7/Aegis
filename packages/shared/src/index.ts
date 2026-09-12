export enum JobStatus {
  INITIATED = "INITIATED",
  PROVISIONING = "PROVISIONING",
  DIAGNOSING = "DIAGNOSING",
  PROPOSAL_GENERATED = "PROPOSAL_GENERATED",
  PENDING_APPROVAL = "PENDING_APPROVAL",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  POLICY_VIOLATED = "POLICY_VIOLATED",
  APPLYING = "APPLYING",
  EXECUTED = "EXECUTED",
  FAILED = "FAILED",
}

export type JobStatusType = `${JobStatus}`;

export const JOB_STATUS_LIST: JobStatus[] = [
  JobStatus.INITIATED,
  JobStatus.PROVISIONING,
  JobStatus.DIAGNOSING,
  JobStatus.PROPOSAL_GENERATED,
  JobStatus.PENDING_APPROVAL,
  JobStatus.APPROVED,
  JobStatus.REJECTED,
  JobStatus.POLICY_VIOLATED,
  JobStatus.APPLYING,
  JobStatus.EXECUTED,
  JobStatus.FAILED,
];

export const TERMINAL_STATES: ReadonlySet<JobStatus> = new Set([
  JobStatus.EXECUTED,
  JobStatus.FAILED,
  JobStatus.REJECTED,
  JobStatus.POLICY_VIOLATED,
]);

export function isTerminalState(status: JobStatus): boolean {
  return TERMINAL_STATES.has(status);
}
