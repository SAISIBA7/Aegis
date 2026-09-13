/**
 * Phase 7 — Scenario 2: HUMAN REJECTION
 *
 * A valid proposal reaches PENDING_APPROVAL, a human REJECTS it, and the job
 * terminates as REJECTED. The Executor must NEVER be invoked on this path —
 * we assert that explicitly with a spy, not just by checking the end state.
 */

import { JobStatus } from "@aegis/shared";
import {
  startTestSystem,
  stopTestSystem,
  createJobAtPendingApproval,
  buildValidProposal,
  getJobWithLogs,
  assertTransitionSequence,
  assertNoTransition,
  cleanupJob,
  uniqueSuffix,
} from "./helpers";
import type { RunningSystem } from "./helpers";

const mockExecutorCalls: unknown[][] = [];

jest.mock("../src/executor", () => {
  const actual = jest.requireActual("../src/executor");
  return {
    ...actual,
    executeAction: jest.fn((...args: unknown[]) => {
      mockExecutorCalls.push(args);
      // If this ever runs, the rejection path is broken — make it loud.
      throw new Error("Executor must NEVER be invoked on the rejection path");
    }),
  };
});

describe("Phase 7 — Scenario 2: Human rejection never touches the Executor", () => {
  let system: RunningSystem | null = null;
  let jobId = "";

  beforeAll(async () => {
    system = await startTestSystem({});
  }, 60_000);

  afterAll(async () => {
    try {
      if (jobId) await cleanupJob(jobId);
    } finally {
      await stopTestSystem(system);
      system = null;
    }
  }, 60_000);

  test("REJECTED job terminates with zero Executor invocations", async () => {
    if (!system) throw new Error("Skipped: test system failed to start");

    const proposal = buildValidProposal(
      "scale_replicas",
      "svc-reject",
      { namespace: "default", replicas: 3 }
    );
    const job = await createJobAtPendingApproval(proposal);
    jobId = job.id;

    // A human rejects the proposal.
    const rejectRes = await fetch(`${system.baseUrl}/jobs/${job.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rejecter: "phase7-ci",
        reason: "Wrong change for this incident",
      }),
    });
    expect(rejectRes.status).toBe(200);

    const rejectBody = await rejectRes.json();
    expect(rejectBody.id).toBe(job.id);
    expect(rejectBody.status).toBe(JobStatus.REJECTED);

    // Final state + full transition history.
    const finalJob = await getJobWithLogs(job.id);
    expect(finalJob).not.toBeNull();
    expect(finalJob!.status).toBe(JobStatus.REJECTED);
    assertTransitionSequence(finalJob!, [JobStatus.PENDING_APPROVAL, JobStatus.REJECTED]);

    // The pipeline (and therefore the Executor) must never have started.
    assertNoTransition(finalJob!, JobStatus.APPLYING);
    assertNoTransition(finalJob!, JobStatus.EXECUTED);

    // The audit entry records the human rejection with a proposal snapshot.
    const rejectLog = finalJob!.auditLogs.find((l) => l.toStatus === JobStatus.REJECTED);
    expect(rejectLog).toBeDefined();
    expect((rejectLog!.metadata as any)?.step).toBe("human_rejection");
    expect((rejectLog!.metadata as any)?.rejectedProposalSnapshot?.actionType).toBe(
      "scale_replicas"
    );

    // The public API view agrees.
    const getRes = await fetch(`${system.baseUrl}/jobs/${job.id}`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.status).toBe(JobStatus.REJECTED);

    // THE central assertion: the Executor was never invoked.
    expect(mockExecutorCalls).toHaveLength(0);
  }, 60_000);
});