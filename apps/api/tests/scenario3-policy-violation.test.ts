/**
 * Phase 7 — Scenario 3: POLICY VIOLATION
 *
 * A proposal is approved by a human but DENIED by the policy engine before
 * the Executor can run. Two real denial paths are covered:
 *
 *   A) The real Kyverno webhook denies a `scale_replicas` request that tries
 *      to scale a real deployment to 11 replicas (aegis-scale-replicas-bounds).
 *   B) The application-layer protected-namespace gate denies any action
 *      targeting `kube-system` (documented compensation for Kyverno's webhook
 *      skipping that namespace).
 *
 * In BOTH paths the job must reach POLICY_VIOLATED and the Executor must
 * NEVER have been invoked — asserted explicitly via a spy.
 */

import { JobStatus } from "@aegis/shared";
import {
  startTestSystem,
  stopTestSystem,
  createJobAtPendingApproval,
  buildValidProposal,
  waitForTerminalStatus,
  assertTransitionSequence,
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
    executeAction: jest.fn((...args: unknown[]) => {
      mockExecutorCalls.push(args);
      // If this ever runs, the policy gate is broken — make it loud.
      throw new Error("Executor must NEVER be invoked after a Kyverno denial");
    }),
  };
});

describe("Phase 7 — Scenario 3: Approved proposal blocked by the policy engine", () => {
  const suffix = uniqueSuffix();
  const fixtureNamespace = `p7policy${suffix}`;
  let system: RunningSystem | null = null;
  const jobIds: string[] = [];

  beforeAll(async () => {
    await createDeploymentFixture("p7-policy-target", fixtureNamespace);
    system = await startTestSystem({ approval: true });
  }, 120_000);

  afterAll(async () => {
    try {
      for (const id of jobIds) await cleanupJob(id);
    } finally {
      try {
        await deleteDeploymentFixture("p7-policy-target", fixtureNamespace);
        await deleteNamespace(fixtureNamespace);
      } finally {
        await stopTestSystem(system);
        system = null;
      }
    }
  }, 120_000);

  test("real Kyverno denies scaling beyond the replica bound -> POLICY_VIOLATED, Executor never invoked", async () => {
    if (!system) throw new Error("Skipped: test system failed to start");

    // 11 replicas violates aegis-scale-replicas-bounds (max 10).
    const proposal = buildValidProposal(
      "scale_replicas",
      "p7-policy-target",
      { namespace: fixtureNamespace, replicas: 11 }
    );
    const job = await createJobAtPendingApproval(proposal);
    jobIds.push(job.id);

    mockExecutorCalls.length = 0;

    // A human approves — the proposal must be caught by Kyverno AFTER approval.
    const approveRes = await fetch(`${system.baseUrl}/jobs/${job.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approver: "phase7-ci" }),
    });
    expect(approveRes.status).toBe(200);

    const finalJob = await waitForTerminalStatus(job.id, {
      timeoutMs: 120_000,
      intervalMs: 1000,
    });

    expect(finalJob.status).toBe(JobStatus.POLICY_VIOLATED);
    assertTransitionSequence(finalJob, [
      JobStatus.PENDING_APPROVAL,
      JobStatus.APPROVED,
      JobStatus.APPLYING,
      JobStatus.POLICY_VIOLATED,
    ]);

    // The denial reason must come from the REAL Kyverno webhook response.
    const violationLog = finalJob.auditLogs.find(
      (l) => l.toStatus === JobStatus.POLICY_VIOLATED
    );
    expect(violationLog).toBeDefined();
    const meta = violationLog!.metadata as any;
    expect(meta?.step).toBe("kyverno_policy_violation");
    expect(String(meta?.reason)).toContain("Replica count cannot exceed 10");

    // The Executor must not have been invoked.
    expect(mockExecutorCalls).toHaveLength(0);
  }, 180_000);

  test("protected-namespace gate denies kube-system targets -> POLICY_VIOLATED, Executor never invoked", async () => {
    if (!system) throw new Error("Skipped: test system failed to start");

    const proposal = buildValidProposal(
      "scale_replicas",
      "kube-system-nope",
      { namespace: "kube-system", replicas: 2 }
    );
    const job = await createJobAtPendingApproval(proposal);
    jobIds.push(job.id);

    mockExecutorCalls.length = 0;

    const approveRes = await fetch(`${system.baseUrl}/jobs/${job.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approver: "phase7-ci" }),
    });
    expect(approveRes.status).toBe(200);

    const finalJob = await waitForTerminalStatus(job.id, {
      timeoutMs: 120_000,
      intervalMs: 1000,
    });

    expect(finalJob.status).toBe(JobStatus.POLICY_VIOLATED);
    assertTransitionSequence(finalJob, [
      JobStatus.PENDING_APPROVAL,
      JobStatus.APPROVED,
      JobStatus.APPLYING,
      JobStatus.POLICY_VIOLATED,
    ]);

    const violationLog = finalJob.auditLogs.find(
      (l) => l.toStatus === JobStatus.POLICY_VIOLATED
    );
    const meta = violationLog!.metadata as any;
    expect(meta?.step).toBe("kyverno_policy_violation");
    expect(String(meta?.reason)).toContain("protected system namespace");

    expect(mockExecutorCalls).toHaveLength(0);
  }, 180_000);
});