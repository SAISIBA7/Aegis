import dotenv from "dotenv";
import path from "path";

// Ensure environment variables are loaded
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { JobStatus } from "@aegis/shared";
import { prisma } from "./db";
import { app } from "./app";
import {
  AgentGateway,
  AgentGatewaySecurityError,
} from "./agentgateway";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
} from "./circuitBreaker";
import { KAgent } from "./kagent";
import {
  DiagnosticProposalSchema,
  CreateDeploymentRequestSchema,
} from "./schemas";
import { initProvisioningWorker } from "./workers/provisioning.worker";
import { initDiagnosticWorker } from "./workers/diagnostic.worker";
import {
  provisioningQueue,
  diagnosticQueue,
  redisConnection,
} from "./queue";
import { createJob, transitionJobStatus } from "./stateMachine";
import { Server } from "http";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log("==========================================================");
  console.log("       AEGIS PHASE 4: AI DIAGNOSIS VERIFICATION SUITE      ");
  console.log("==========================================================\n");

  // ----------------------------------------------------------------------
  // TEST 1: AGENTGATEWAY READ-ONLY SECURITY & AUDIT LOGGING
  // ----------------------------------------------------------------------
  console.log("[Test 1] AgentGateway Read-Only Tool Enforcement & Audit Tracing...");
  const gateway = new AgentGateway("kind-aegis");

  // 1a. Test reading pod status
  const pods = await gateway.getPodStatus("default", "test-app");
  assert(Array.isArray(pods), "getPodStatus should return an array of pod info");

  // 1b. Test forbidden tool invocation
  let securityErrorCaught = false;
  try {
    await gateway.invokeTool("deletePod", { namespace: "default", name: "pod-1" });
  } catch (err) {
    if (err instanceof AgentGatewaySecurityError) {
      securityErrorCaught = true;
    }
  }
  assert(securityErrorCaught, "AgentGateway MUST throw AgentGatewaySecurityError on mutating tool 'deletePod'");

  // 1c. Verify all calls were traced in gateway
  const traces = gateway.getTraces();
  assert(traces.length >= 2, "AgentGateway must record traces for every tool invoked");
  const forbiddenTrace = traces.find((t) => t.tool === "deletePod");
  assert(
    forbiddenTrace !== undefined && !forbiddenTrace.success,
    "Forbidden tool call must be recorded in trace with success=false"
  );
  console.log("✓ AgentGateway strictly enforces read-only boundary and records audit traces.\n");

  // ----------------------------------------------------------------------
  // TEST 2: CIRCUIT BREAKER FAIL-FAST RESILIENCE
  // ----------------------------------------------------------------------
  console.log("[Test 2] Circuit Breaker Fail-Fast & State Transitions...");
  const cb = new CircuitBreaker({
    failureThreshold: 2,
    timeoutMs: 500,
    resetTimeoutMs: 1000,
    maxRetries: 1,
  });

  assert(cb.getState() === CircuitState.CLOSED, "Initial state should be CLOSED");

  // Cause failures to trip the breaker
  for (let i = 0; i < 2; i++) {
    try {
      await cb.execute(async () => {
        throw new Error("Simulated network timeout/disconnect");
      });
    } catch {
      // expected
    }
  }

  assert(cb.getState() === CircuitState.OPEN, "Breaker must trip to OPEN after failureThreshold consecutive errors");

  // Verify fast fail without executing the function
  let fastFailed = false;
  let executedAction = false;
  try {
    await cb.execute(async () => {
      executedAction = true;
      return "ok";
    });
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      fastFailed = true;
    }
  }
  assert(fastFailed, "Circuit breaker in OPEN state must fail fast with CircuitBreakerOpenError");
  assert(!executedAction, "Action must not be executed when circuit is OPEN");
  console.log("✓ Circuit breaker trips to OPEN and fails fast without hanging.\n");

  // ----------------------------------------------------------------------
  // TEST 3: PROPOSAL SCHEMA VALIDATION (ZOD)
  // ----------------------------------------------------------------------
  console.log("[Test 3] Zod Schema Validation for Diagnostic Proposals...");
  const validProposal = {
    actionType: "update_image",
    target: "deployment/order-service",
    params: { image: "nginx:alpine" },
    reasoning: "Container failed with ImagePullBackOff because tag was invalid. Updating to nginx:alpine resolves the pull error.",
  };

  const validParse = DiagnosticProposalSchema.safeParse(validProposal);
  assert(validParse.success, "Valid proposal must pass Zod schema validation");

  const malformedProposal = {
    actionType: "", // empty
    target: "deployment/order-service",
    // missing params and reasoning
  };
  const invalidParse = DiagnosticProposalSchema.safeParse(malformedProposal);
  assert(!invalidParse.success, "Malformed proposal must fail Zod schema validation");
  console.log("✓ Zod schema accurately distinguishes valid vs malformed diagnostic proposals.\n");

  // ----------------------------------------------------------------------
  // TEST 4: CIRCUIT BREAKER ON INVALID API KEY (FAIL-FAST TO FAILED)
  // ----------------------------------------------------------------------
  console.log("[Test 4] Circuit Breaker Handling of Invalid API Key...");
  const brokenKAgent = new KAgent({
    apiKey: "nvapi-invalid-bad-key-for-test",
    circuitBreaker: new CircuitBreaker({
      failureThreshold: 2,
      timeoutMs: 3000,
      maxRetries: 0,
    }),
  });

  const failJob = await createJob(prisma, {
    type: "deployment",
    payload: { appName: "test-auth-fail" },
    status: JobStatus.DIAGNOSING,
    metadata: { test: "circuit_breaker_test" },
  });

  let authErrorCaught = false;
  try {
    const brokenGateway = new AgentGateway("kind-aegis");
    await brokenKAgent.diagnoseFailure(
      brokenGateway,
      "test-auth-fail",
      "default",
      "Simulated failure"
    );
  } catch (err: any) {
    authErrorCaught = true;
    await transitionJobStatus(prisma, failJob.id, JobStatus.FAILED, {
      step: "circuit_breaker_test_failed",
      error: err.message,
    });
  }

  assert(authErrorCaught, "Calling with invalid API key must fail fast and throw");
  const failedJobRecord = await prisma.job.findUnique({
    where: { id: failJob.id },
  });
  assert(
    failedJobRecord?.status === JobStatus.FAILED,
    "Job must transition DIAGNOSING -> FAILED on API authentication/circuit failure"
  );
  console.log("✓ Invalid API key fails fast and transitions job to FAILED cleanly.\n");

  // ----------------------------------------------------------------------
  // TEST 5: FULL LIVE E2E FAILURE DIAGNOSIS (NVIDIA NEMOTRON 3.5 LIGHTNING)
  // ----------------------------------------------------------------------
  console.log("[Test 5] Live E2E Failure Injection & Nemotron 3.5 Diagnosis...");
  const testPort = 3098;
  const server: Server = app.listen(testPort);
  const provisioningWorker = initProvisioningWorker();
  const diagnosticWorker = initDiagnosticWorker();
  const baseUrl = `http://localhost:${testPort}`;

  const targetApp = "diag-fail-app";

  try {
    // 5a. Submit deployment with an invalid image to trigger failure injection
    console.log(`Submitting broken deployment for app '${targetApp}' with bad image tag...`);
    const postRes = await fetch(`${baseUrl}/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: targetApp,
        image: "nginx:invalid-tag-phase4-breakme-404",
        cpu: 0.2,
        memory: 128,
        replicas: 1,
      }),
    });

    assert(postRes.status === 202, `POST /deployments should return 202, got ${postRes.status}`);
    const postData = await postRes.json();
    const jobId = postData.jobId;
    console.log(`✓ Broken deployment accepted with jobId: ${jobId}`);

    // 5b. Poll job through state progression
    console.log("Polling job status: expecting INITIATED -> PROVISIONING -> DIAGNOSING -> PROPOSAL_GENERATED...");
    const observedStates = new Set<string>();
    let finalJob: any = null;
    const maxPollAttempts = 60;
    const startTime = Date.now();

    for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(`${baseUrl}/jobs/${jobId}`);
      assert(res.status === 200, `GET /jobs/${jobId} should return 200`);
      const job = await res.json();

      observedStates.add(job.status);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  [Poll ${attempt} | ${elapsed}s] Status: ${job.status}`);

      if (
        job.status === JobStatus.PROPOSAL_GENERATED ||
        job.status === JobStatus.FAILED ||
        job.status === JobStatus.EXECUTED
      ) {
        finalJob = job;
        break;
      }
    }

    assert(finalJob !== null, "Job failed to reach a terminal or proposal state within timeout");
    console.log(`\nFinal Job Status: ${finalJob.status}`);

    // Assert transitions occurred through DIAGNOSING.
    // NOTE: We verify via the AuditLog rather than the 2s polling snapshot,
    // because PROVISIONING -> DIAGNOSING can complete in under 2s (terraform
    // apply with wait_for_rollout=false returns immediately on bad images),
    // so the poller may never observe the intermediate PROVISIONING state.
    const auditLogs = finalJob.auditLogs || [];
    const transitionedThroughProvisioning = auditLogs.some(
      (l: any) => l.toStatus === JobStatus.PROVISIONING
    );
    const transitionedThroughDiagnosing = auditLogs.some(
      (l: any) => l.toStatus === JobStatus.DIAGNOSING
    );
    assert(
      transitionedThroughProvisioning,
      "Job must have transitioned through PROVISIONING (per AuditLog)"
    );
    assert(
      transitionedThroughDiagnosing,
      "Job must have transitioned through DIAGNOSING (per AuditLog)"
    );
    assert(
      finalJob.status === JobStatus.PROPOSAL_GENERATED,
      `Expected status PROPOSAL_GENERATED, but got ${finalJob.status}`
    );
    // 5c. Assert the structured proposal was saved on the job
    console.log("\nInspecting Generated Proposal on Job:");
    console.log(JSON.stringify(finalJob.proposal, null, 2));

    assert(finalJob.proposal !== null && finalJob.proposal !== undefined, "Job must have a proposal attached");
    assert(typeof finalJob.proposal.actionType === "string", "Proposal must include actionType");
    assert(typeof finalJob.proposal.target === "string", "Proposal must include target");
    assert(typeof finalJob.proposal.params === "object", "Proposal must include params object");
    assert(typeof finalJob.proposal.reasoning === "string", "Proposal must include reasoning");

    // 5d. Inspect Audit Logs for complete gateway trace
    console.log(`\nAudit Logs Recorded: ${auditLogs.length} entries:`);
    for (const log of auditLogs) {
      console.log(`  - ${log.fromStatus || "START"} -> ${log.toStatus} (${log.timestamp})`);
    }

    const proposalLog = auditLogs.find((l: any) => l.toStatus === JobStatus.PROPOSAL_GENERATED);
    assert(proposalLog !== undefined, "AuditLog must have an entry for PROPOSAL_GENERATED");
    assert(
      proposalLog.metadata?.agentGatewayTraces !== undefined,
      "PROPOSAL_GENERATED AuditLog entry MUST contain agentGatewayTraces"
    );

    const tracesInLog = proposalLog.metadata.agentGatewayTraces;
    console.log(`\nAgentGateway Tool Calls Recorded in AuditLog: ${tracesInLog.length}`);
    for (const t of tracesInLog) {
      console.log(`  - Tool: ${t.tool} (${t.durationMs}ms) [Success: ${t.success}]`);
    }
    assert(tracesInLog.length > 0, "AgentGateway tool trace in AuditLog cannot be empty");

    console.log("\n✓ Real NVIDIA Nemotron 3.5 Lightning diagnostic proposal generated and verified!");
  } finally {
    server.close();
    await provisioningWorker.close();
    await diagnosticWorker.close();
    await provisioningQueue.close();
    await diagnosticQueue.close();
    await redisConnection.quit();
    await prisma.$disconnect();
  }

  console.log("\n==========================================================");
  console.log("       ALL PHASE 4 DIAGNOSIS TESTS PASSED SUCCESSFULLY!    ");
  console.log("==========================================================");
}

runTests().catch((err) => {
  console.error("\n❌ PHASE 4 VERIFICATION FAILED:", err);
  process.exit(1);
});
