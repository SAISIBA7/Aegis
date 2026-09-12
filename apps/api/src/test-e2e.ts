import { JobStatus } from "@aegis/shared";
import { prisma } from "./db";
import {
  createJob,
  transitionJobStatus,
  IllegalStateTransitionError,
  isValidTransition,
} from "./stateMachine";
import { CreateDeploymentRequestSchema } from "./schemas";
import { app } from "./app";
import { initProvisioningWorker } from "./workers/provisioning.worker";
import { provisioningQueue, redisConnection } from "./queue";
import { Server } from "http";
import { execSync } from "child_process";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTests() {
  console.log("=== STARTING AEGIS PHASE 2 VERIFICATION ===");

  // 1. STATE MACHINE UNIT VERIFICATION
  console.log("\n[Test 1] State Machine Transition Rules...");
  assert(isValidTransition(JobStatus.INITIATED, JobStatus.PROVISIONING), "INITIATED -> PROVISIONING should be legal");
  assert(!isValidTransition(JobStatus.INITIATED, JobStatus.EXECUTED), "INITIATED -> EXECUTED should be illegal");
  assert(isValidTransition(JobStatus.PENDING_APPROVAL, JobStatus.APPROVED), "PENDING_APPROVAL -> APPROVED should be legal");
  assert(isValidTransition(JobStatus.PENDING_APPROVAL, JobStatus.REJECTED), "PENDING_APPROVAL -> REJECTED should be legal");
  assert(!isValidTransition(JobStatus.PENDING_APPROVAL, JobStatus.POLICY_VIOLATED), "PENDING_APPROVAL -> POLICY_VIOLATED must be illegal");
  assert(isValidTransition(JobStatus.APPROVED, JobStatus.POLICY_VIOLATED), "APPROVED -> POLICY_VIOLATED must be legal");
  assert(isValidTransition(JobStatus.APPROVED, JobStatus.APPLYING), "APPROVED -> APPLYING must be legal");
  assert(!isValidTransition(JobStatus.EXECUTED, JobStatus.PROVISIONING), "EXECUTED -> PROVISIONING must be illegal (terminal)");
  console.log("✓ State machine transition graph rules verified.");

  // 2. RFC 1123 ZOD SCHEMA VALIDATION
  console.log("\n[Test 2] RFC 1123 Kubernetes Naming Validation in Zod...");
  const validPayload = {
    appName: "order-service",
    image: "nginx:alpine",
    cpu: 0.5,
    memory: 256,
    replicas: 1,
  };
  assert(CreateDeploymentRequestSchema.safeParse(validPayload).success, "order-service should pass RFC 1123");

  const badLeadingDash = { ...validPayload, appName: "-order-service" };
  assert(!CreateDeploymentRequestSchema.safeParse(badLeadingDash).success, "-order-service must fail (leading hyphen)");

  const badTrailingDash = { ...validPayload, appName: "order-service-" };
  assert(!CreateDeploymentRequestSchema.safeParse(badTrailingDash).success, "order-service- must fail (trailing hyphen)");

  const badUppercase = { ...validPayload, appName: "OrderService" };
  assert(!CreateDeploymentRequestSchema.safeParse(badUppercase).success, "OrderService must fail (uppercase)");

  const badSpecialChars = { ...validPayload, appName: "order_service" };
  assert(!CreateDeploymentRequestSchema.safeParse(badSpecialChars).success, "order_service must fail (underscore)");

  const tooLong = { ...validPayload, appName: "a".repeat(64) };
  assert(!CreateDeploymentRequestSchema.safeParse(tooLong).success, "64-char appName must fail (>63 chars)");

  console.log("✓ RFC 1123 Zod schema accurately enforces Kubernetes DNS label standards.");

  // 3. START HTTP SERVER & BULLMQ WORKER FOR LIVE E2E TEST
  console.log("\n[Test 3] Starting HTTP Server & BullMQ Worker for E2E Provisioning...");
  const testPort = 3099;
  const server: Server = app.listen(testPort);
  const worker = initProvisioningWorker();
  const baseUrl = `http://localhost:${testPort}`;

  try {
    // 4. DEPLOYMENT 1: "order-service"
    console.log("\n[Test 4] Provisioning deployment 1: 'order-service'...");
    const postRes1 = await fetch(`${baseUrl}/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: "order-service",
        image: "nginx:alpine",
        cpu: 0.2,
        memory: 128,
        replicas: 1,
      }),
    });
    assert(postRes1.status === 202, `POST should return 202, got ${postRes1.status}`);
    const data1 = await postRes1.json();
    const jobId1 = data1.jobId;
    console.log(`✓ Deployment 1 accepted with jobId: ${jobId1}`);

    // Poll until terminal state
    console.log("Polling job status during real Terraform apply...");
    let job1FinalStatus = "";
    let pollCount = 0;
    const startTime1 = Date.now();
    while (pollCount < 30) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(`${baseUrl}/jobs/${jobId1}`);
      const jobData = await res.json();
      console.log(`  [Poll ${pollCount + 1}] Status: ${jobData.status}`);
      if (jobData.status === JobStatus.EXECUTED || jobData.status === JobStatus.FAILED) {
        job1FinalStatus = jobData.status;
        break;
      }
      pollCount++;
    }
    const duration1Sec = ((Date.now() - startTime1) / 1000).toFixed(1);
    console.log(`✓ Job 1 reached ${job1FinalStatus} in ${duration1Sec}s (real Terraform apply duration).`);
    assert(job1FinalStatus === JobStatus.EXECUTED, `Expected EXECUTED, got ${job1FinalStatus}`);

    // Verify Kubernetes resources for order-service
    const pods1 = execSync("kubectl get pods -n order-service --context kind-aegis", { encoding: "utf8" });
    console.log("Kubectl pods in order-service namespace:\n" + pods1);
    assert(pods1.includes("order-service"), "order-service pod must exist in kind cluster");

    // 5. DEPLOYMENT 2: "payment-service" (REGRESSION TEST FOR TERRAFORM WORKSPACE ISOLATION)
    console.log("\n[Test 5] Provisioning deployment 2: 'payment-service' (Workspace isolation regression test)...");
    const postRes2 = await fetch(`${baseUrl}/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: "payment-service",
        image: "redis:alpine",
        cpu: 0.2,
        memory: 128,
        replicas: 1,
      }),
    });
    assert(postRes2.status === 202, `POST should return 202, got ${postRes2.status}`);
    const data2 = await postRes2.json();
    const jobId2 = data2.jobId;
    console.log(`✓ Deployment 2 accepted with jobId: ${jobId2}`);

    let job2FinalStatus = "";
    pollCount = 0;
    while (pollCount < 30) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(`${baseUrl}/jobs/${jobId2}`);
      const jobData = await res.json();
      console.log(`  [Poll ${pollCount + 1}] Status: ${jobData.status}`);
      if (jobData.status === JobStatus.EXECUTED || jobData.status === JobStatus.FAILED) {
        job2FinalStatus = jobData.status;
        break;
      }
      pollCount++;
    }
    assert(job2FinalStatus === JobStatus.EXECUTED, `Expected EXECUTED for payment-service, got ${job2FinalStatus}`);

    // 6. CONFIRM BOTH NAMESPACES AND PODS EXIST SIMULTANEOUSLY
    console.log("\n[Test 6] Verifying BOTH namespaces co-exist (Terraform state isolation verified)...");
    const namespacesOutput = execSync("kubectl get namespaces --context kind-aegis", { encoding: "utf8" });
    console.log(namespacesOutput);
    assert(namespacesOutput.includes("order-service"), "order-service namespace must still exist!");
    assert(namespacesOutput.includes("payment-service"), "payment-service namespace must exist!");

    const pods2 = execSync("kubectl get pods -n payment-service --context kind-aegis", { encoding: "utf8" });
    console.log("Kubectl pods in payment-service namespace:\n" + pods2);
    assert(pods2.includes("payment-service"), "payment-service pod must exist in kind cluster");

    // Re-verify order-service pod is still running
    const pods1Check = execSync("kubectl get pods -n order-service --context kind-aegis", { encoding: "utf8" });
    assert(pods1Check.includes("order-service"), "order-service pod must NOT have been destroyed by payment-service deployment!");
    console.log("✓ Regression test passed: Both order-service and payment-service co-exist independently!");

  } finally {
    server.close();
    await worker.close();
    await provisioningQueue.close();
    await redisConnection.quit();
    await prisma.$disconnect();
  }

  console.log("\n=== ALL AEGIS PHASE 2 TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
