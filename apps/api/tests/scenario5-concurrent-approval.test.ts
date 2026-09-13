/**
 * Phase 7 — Scenario 5: CONCURRENT APPROVAL
 *
 * Two near-simultaneous approve requests hit the SAME job. The Executor must
 * run EXACTLY ONCE — not zero times, not twice — and the job must settle in
 * EXECUTED. Exactly-once execution is the safety contract here; the second
 * request may be answered 409 (its transition raced after the first and the
 * state machine rejected it) or 200 (it won the read race and the BullMQ job
 * idempotency + pipeline state guard absorbed it) — either way the Executor
 * runs once.
 *
 * This test runs the full concurrent scenario 3 times in a row because race
 * conditions can pass by luck once and fail on a rerun.
 */

import { JobStatus } from "@aegis/shared";
import {
  startTestSystem,
  stopTestSystem,
  createJobAtPendingApproval,
  buildValidProposal,
  waitForTerminalStatus,
  assertNoTransition,
  createDeploymentFixture,
  deleteDeploymentFixture,
  deleteNamespace,
  cleanupJob,
  uniqueSuffix,
} from "./helpers";
import type { RunningSystem } from "./helpers";

const mockExecutorCalls: unknown[][] = [];

jest.mock("../src/executor", () => {
  const actual = jest.requireActual("../src/executor");
  return {
    ...actual,
    executeAction: jest.fn((...args: any[]) => {
      mockExecutorCalls.push(args);
      return actual.executeAction(...args);
    }),
  };
});

describe("Phase 7 — Scenario 5: Concurrent approval yields exactly-once execution", () => {
  const suffix = uniqueSuffix();
  const fixtureNamespace = `p7conc${suffix}`;
  const target = "p7-conc-target";
  let system: RunningSystem | null = null;
  const jobIds: string[] = [];

  beforeAll(async () => {
    await createDeploymentFixture(target, fixtureNamespace);
    system = await startTestSystem({ approval: true });
  }, 120_000);

  afterAll(async () => {
    try {
      for (const id of jobIds) await cleanupJob(id);
    } finally {
      try {
        await deleteDeploymentFixture(target, fixtureNamespace);
        await deleteNamespace(fixtureNamespace);
      } finally {
        await stopTestSystem(system);
        system = null;
      }
    }
  }, 120_000);

  test.each([1, 2, 3] as const)("concurrent approve round %i runs the Executor exactly once", async (round) => {
    if (!system) throw new Error("Skipped: test system failed to start");

    const proposal = buildValidProposal(
      "scale_replicas",
      target,
      { namespace: fixtureNamespace, replicas: 2 }
    );
    const job = await createJobAtPendingApproval(proposal);
    jobIds.push(job.id);

    mockExecutorCalls.length = 0;

    console.log(`[S5] Round ${round}: firing two simultaneous approve requests for job ${job.id}...`);
    const [r1, r2] = await Promise.all([
      fetch(`${system.baseUrl}/jobs/${job.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approver: "phase7-concurrent" }),
      }),
      fetch(`${system.baseUrl}/jobs/${job.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approver: "phase7-concurrent" }),
      }),
    ]);

    // At least one approval must have succeeded — the job cannot end unexecuted.
    const statusCodes = [r1.status, r2.status].sort();
    console.log(`[S5] Round ${round}: approve responses = ${statusCodes.join(",")}`);
    expect(statusCodes).toContain(200);
    // No response may be a 5xx — that would be an infrastructure failure, not a race outcome.
    for (const code of statusCodes) {
      expect(code).toBeLessThan(500);
    }

    const finalJob = await waitForTerminalStatus(job.id, {
      timeoutMs: 120_000,
      intervalMs: 1000,
    });
    expect(finalJob.status).toBe(JobStatus.EXECUTED);

    // The pipeline ran exactly once: one APPLYING and one EXECUTED transition.
    const applying = finalJob.auditLogs.filter((l) => l.toStatus === JobStatus.APPLYING);
    const executed = finalJob.auditLogs.filter((l) => l.toStatus === JobStatus.EXECUTED);
    expect(applying).toHaveLength(1);
    expect(executed).toHaveLength(1);
    assertNoTransition(finalJob, JobStatus.FAILED);

    // THE central assertion: exactly-once Executor invocation, no more.
    expect(mockExecutorCalls).toHaveLength(1);
  }, 180_000);
});