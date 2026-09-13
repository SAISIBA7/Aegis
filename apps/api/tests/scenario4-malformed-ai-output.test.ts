/**
 * Phase 7 — Scenario 4: MALFORMED AI OUTPUT
 *
 * The AI produces output that is GENUINELY schema-invalid — wrong types for
 * fields and a required field missing entirely — NOT just markdown-wrapped
 * valid JSON (kagent's parser strips markdown fences, so that simpler case
 * would correctly succeed). The real diagnostic worker must reject the
 * proposal with Zod and fail the job at the DIAGNOSING stage, BEFORE it ever
 * reaches PENDING_APPROVAL.
 *
 * The kagent class itself is stubbed (the NIM HTTP call is skipped); what it
 * returns is a malformed object of exactly the kind the validation boundary
 * exists to catch. The worker, its Zod validation, and every state machine
 * transition are real.
 */

import { JobStatus } from "@aegis/shared";
import {
  DiagnosticProposalSchema,
} from "../src/schemas";
import {
  startTestSystem,
  stopTestSystem,
  createJobAtDiagnosing,
  waitForTerminalStatus,
  getJobWithLogs,
  assertNoTransition,
  cleanupJob,
  uniqueSuffix,
  enqueueDiagnosticJob,
} from "./helpers";
import type { RunningSystem } from "./helpers";

/**
 * Genuinely schema-invalid: actionType and reasoning have the wrong types,
 * and params (a required field) is missing entirely.
 */
const MALFORMED_PROPOSAL = {
  actionType: 42,
  target: "order-service",
  reasoning: 12345,
};

jest.mock("../src/kagent", () => {
  return {
    KAgent: class MockKAgent {
      public async diagnoseFailure() {
        const malformed = { actionType: 42, target: "order-service", reasoning: 12345 };
        return { proposal: malformed, rawResponse: JSON.stringify(malformed) };
      }
    },
  };
});

describe("Phase 7 — Scenario 4: Schema-invalid AI output fails before approval", () => {
  let system: RunningSystem | null = null;
  let jobId = "";

  beforeAll(async () => {
    system = await startTestSystem({ diagnostic: true });
  }, 60_000);

  afterAll(async () => {
    try {
      if (jobId) await cleanupJob(jobId);
    } finally {
      await stopTestSystem(system);
      system = null;
    }
  }, 60_000);

  test("DIAGNOSING -> FAILED on genuinely malformed output, never PENDING_APPROVAL", async () => {
    if (!system) throw new Error("Skipped: test system failed to start");

    // Prove the fixture is genuinely schema-invalid (not just markdown-wrapped
    // valid JSON that kagent's fence-stripper would have parsed fine).
    const parse = DiagnosticProposalSchema.safeParse(MALFORMED_PROPOSAL);
    expect(parse.success).toBe(false);
    const flattened = parse.success ? null : parse.error.flatten().fieldErrors;
    expect(flattened!.actionType).toBeDefined(); // "Expected string, received number"
    expect(flattened!.params).toBeDefined();     // required field missing entirely

    const job = await createJobAtDiagnosing({ appName: "order-service" });
    jobId = job.id;

    // Drive the JOB through the REAL diagnostic worker by enqueuing on the REAL queue.
    console.log(`[S4] Enqueuing diagnostic job for ${job.id} with a malformed kagent output...`);
    await enqueueDiagnosticJob(job.id, "order-service", "default", "simulated failure");

    const finalJob = await waitForTerminalStatus(job.id, {
      timeoutMs: 120_000,
      intervalMs: 1000,
    });

    // Must fail exactly where the phase prompt requires: at the DIAGNOSING stage.
    expect(finalJob.status).toBe(JobStatus.FAILED);
    expect(finalJob.auditLogs.some((l) => l.toStatus === JobStatus.DIAGNOSING)).toBe(true);

    // It must never have progressed toward human approval.
    assertNoTransition(finalJob, JobStatus.PROPOSAL_GENERATED);
    assertNoTransition(finalJob, JobStatus.PENDING_APPROVAL);
    assertNoTransition(finalJob, JobStatus.APPROVED);
    assertNoTransition(finalJob, JobStatus.EXECUTED);

    // No proposal may have been persisted.
    expect(finalJob.proposal).toBeNull();

    // The failure audit entry must record that validation itself failed.
    const failLog = finalJob.auditLogs.find((l) => l.toStatus === JobStatus.FAILED);
    expect(failLog).toBeDefined();
    const meta = failLog!.metadata as any;
    expect(meta?.step).toBe("proposal_validation_failed");
    expect(meta?.validationDetails?.fieldErrors?.actionType).toBeDefined();
    expect(meta?.validationDetails?.fieldErrors?.params).toBeDefined();
  }, 180_000);
});