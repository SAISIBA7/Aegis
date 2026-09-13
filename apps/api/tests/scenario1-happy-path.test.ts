/**
 * Phase 7 — Scenario 1: HAPPY PATH
 *
 * A deployment fails, diagnosis runs, a valid proposal is generated, a human
 * approves it, the real Kyverno policy engine passes it, the real Executor
 * runs, and the job reaches EXECUTED.
 *
 * Everything in this test is REAL: Terraform provisioning of a broken app on
 * the live kind cluster, AgentGateway's read-only cluster inspection, the
 * BullMQ queues/workers, the Kyverno dry-run admission check, and the
 * Executor's kubectl scale. The ONLY stubbed boundary is the NVIDIA NIM HTTP
 * call inside kagent — the diagnosis worker still runs its full validation
 * + state-machine path, but the model response is replaced with a fixed,
 * schema-valid proposal so the test is fast, free, and repeatable.
 */

import { JobStatus } from "@aegis/shared";
import {
  startTestSystem,
  stopTestSystem,
  submitFailingDeployment,
  waitForJobStatus,
  getJobWithLogs,
  assertTransitionSequence,
  cleanupJob,
  execKubectl,
  uniqueSuffix,
  KUBE_CONTEXT,
} from "./helpers";
import type { RunningSystem } from "./helpers";

jest.mock("../src/kagent", () => {
  return {
    KAgent: class MockKAgent {
      public async diagnoseFailure(_gateway: unknown, appName: string, namespace: string) {
        const proposal = {
          actionType: "scale_replicas",
          target: appName,
          params: { namespace, replicas: 2 },
          reasoning:
            "Pod stayed unhealthy after a failed rollout; scaling the deployment to 2 replicas restores a healthy serving capacity.",
        };
        return { proposal, rawResponse: JSON.stringify(proposal) };
      }
    },
  };
});

describe("Phase 7 — Scenario 1: Happy path reaches EXECUTED", () => {
  const appName = `p7happy${uniqueSuffix()}`;
  let system: RunningSystem | null = null;
  let jobId = "";
  let skipped = false;

  beforeAll(async () => {
    try {
      system = await startTestSystem({
        provisioning: true,
        diagnostic: true,
        approval: true,
      });
    } catch (err) {
      console.error("[S1] System startup failed:", err);
      skipped = true;
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (jobId) await cleanupJob(jobId);
    } finally {
      await stopTestSystem(system);
      system = null;
    }
  }, 120_000);

  test("broken deployment passes every gate and reaches EXECUTED", async () => {
    if (skipped || !system) throw new Error("Skipped: test system failed to start");

    console.log(`[S1] Submitting failing deployment for app '${appName}'...`);
    const submitted = await submitFailingDeployment(system.baseUrl, appName);
    jobId = submitted.jobId;

    // Stage 1: real terraform apply -> pod ImagePullBackOff -> DIAGNOSING -> proposal -> PENDING_APPROVAL
    console.log(`[S1] Waiting for job ${jobId} to reach PENDING_APPROVAL (real terraform apply runs)...`);
    await waitForJobStatus(jobId, JobStatus.PENDING_APPROVAL, {
      timeoutMs: 300_000,
      intervalMs: 2000,
    });

    const pendingJob = await getJobWithLogs(jobId);
    expect(pendingJob).not.toBeNull();
    expect((pendingJob!.proposal as any)?.actionType).toBe("scale_replicas");
    expect((pendingJob!.proposal as any)?.target).toBe(appName);
    expect((pendingJob!.proposal as any)?.params?.replicas).toBe(2);

    // Stage 2: human approval -> APPROVED (enqueues the real remediation job)
    console.log(`[S1] Approving job ${jobId}...`);
    const approveRes = await fetch(`${system.baseUrl}/jobs/${jobId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approver: "phase7-ci" }),
    });
    expect(approveRes.status).toBe(200);
    const approveBody = await approveRes.json();
    expect(approveBody.status).toBe(JobStatus.APPROVED);

    // Stage 3: the real approval worker runs Kyverno (dry-run passes) + the real Executor.
    console.log(`[S1] Waiting for job ${jobId} to reach EXECUTED (Kyverno + Executor run)...`);
    const finalJob = await waitForJobStatus(jobId, JobStatus.EXECUTED, {
      timeoutMs: 180_000,
      intervalMs: 1500,
    });

    // Assert every state transition happened, in order — not just the final state.
    assertTransitionSequence(finalJob, [
      JobStatus.INITIATED,
      JobStatus.PROVISIONING,
      JobStatus.DIAGNOSING,
      JobStatus.PROPOSAL_GENERATED,
      JobStatus.PENDING_APPROVAL,
      JobStatus.APPROVED,
      JobStatus.APPLYING,
      JobStatus.EXECUTED,
    ]);

    // The proposal must still be attached to the job.
    expect((finalJob.proposal as any)?.actionType).toBe("scale_replicas");
    expect((finalJob.proposal as any)?.params?.replicas).toBe(2);

    // Prove the Executor really ran: the real deployment was scaled to 2 replicas.
    const scaled = await execKubectl([
      "get",
      "deployment",
      appName,
      "-n",
      appName,
      "--context",
      KUBE_CONTEXT,
      "-o",
      "jsonpath={.spec.replicas}",
    ]);
    expect(scaled.stdout).toBe("2");

    console.log(`[S1] Job ${jobId} reached EXECUTED with the full transition sequence verified.`);
  }, 480_000);
});