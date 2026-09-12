/**
 * Executor unit/integration tests — increase_resource_limit direction logic.
 *
 * These tests run against the live kind-aegis cluster.
 * Prerequisites:
 *   - kind cluster "aegis" running
 *   - order-service deployment exists in order-service namespace
 *   - current resource limits on order-service are known (test resets them first)
 *
 * Run with: npx tsx src/test-executor.ts
 */

import {
  executeIncreaseResourceLimit,
  executeRestartPod,
  executeScaleReplicas,
  validateActionParams,
  IncreaseResourceLimitParamsSchema,
} from "./executor";
import { execFileSync } from "child_process";

const NAMESPACE = "order-service";
const DEPLOYMENT = "order-service";
const KUBE_CONTEXT = process.env.KUBE_CONTEXT || "kind-aegis";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

/**
 * Sets resource limits on the test deployment to a known baseline.
 */
function setBaseline(cpu: string, memory: string) {
  const patch = JSON.stringify({
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: DEPLOYMENT,
              resources: {
                limits: { cpu, memory },
                requests: { cpu: "0.25", memory: "128Mi" },
              },
            },
          ],
        },
      },
    },
  });
  execFileSync("kubectl", [
    "patch",
    `deployment/${DEPLOYMENT}`,
    "-n",
    NAMESPACE,
    "--context",
    KUBE_CONTEXT,
    "--type",
    "strategic",
    "-p",
    patch,
  ]);
  // Brief pause for the patch to register
}

async function testCase(
  name: string,
  fn: () => Promise<void>,
  expectError: boolean = false,
  expectedErrorSubstring?: string
) {
  try {
    await fn();
    if (expectError) {
      console.log(`  ✗ ${name} — expected an error but none was thrown`);
      failed++;
    } else {
      console.log(`  ✓ ${name}`);
      passed++;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (expectError) {
      if (expectedErrorSubstring && !msg.includes(expectedErrorSubstring)) {
        console.log(`  ✗ ${name} — got error but wrong message: ${msg}`);
        failed++;
      } else {
        console.log(`  ✓ ${name} (correctly rejected: ${msg.slice(0, 100)})`);
        passed++;
      }
    } else {
      console.log(`  ✗ ${name} — unexpected error: ${msg}`);
      failed++;
    }
  }
}

async function runTests() {
  console.log("=== EXECUTOR DIRECTION-LOGIC TESTS ===\n");

  // ── increase_resource_limit direction tests ────────────────────────
  // Baseline: cpu=1, memory=512Mi
  console.log("[Setup] Setting baseline: cpu=1, memory=512Mi");
  setBaseline("1", "512Mi");

  console.log("\n[Test Group 1] increase_resource_limit — direction validation\n");

  // 1. Both up (cpu 1→2, memory 512→1024) → ACCEPTED
  await testCase(
    "both dimensions up → accepted",
    async () => {
      const result = await executeIncreaseResourceLimit(DEPLOYMENT, {
        namespace: NAMESPACE,
        cpu: 2,
        memory: 1024,
      });
      assert(result.success, "expected success");
    },
    false
  );

  // Reset baseline after the accepted increase
  console.log("[Setup] Resetting baseline: cpu=1, memory=512Mi");
  setBaseline("1", "512Mi");

  // 2. CPU up, memory DOWN (cpu 1→2, memory 512→256) → REJECTED (the bug this fixes)
  await testCase(
    "cpu up, memory down → REJECTED (mixed decrease)",
    async () => {
      await executeIncreaseResourceLimit(DEPLOYMENT, {
        namespace: NAMESPACE,
        cpu: 2,
        memory: 256,
      });
    },
    true,
    "cannot decrease any resource dimension"
  );

  // 3. CPU DOWN, memory up (cpu 1→0.5, memory 512→1024) → REJECTED
  await testCase(
    "cpu down, memory up → REJECTED (mixed decrease)",
    async () => {
      await executeIncreaseResourceLimit(DEPLOYMENT, {
        namespace: NAMESPACE,
        cpu: 0.5,
        memory: 1024,
      });
    },
    true,
    "cannot decrease any resource dimension"
  );

  // 4. Both down (cpu 1→0.5, memory 512→256) → REJECTED
  await testCase(
    "both dimensions down → REJECTED",
    async () => {
      await executeIncreaseResourceLimit(DEPLOYMENT, {
        namespace: NAMESPACE,
        cpu: 0.5,
        memory: 256,
      });
    },
    true,
    "cannot decrease any resource dimension"
  );

  // 5. Same values (cpu 1→1, memory 512→512) → REJECTED
  await testCase(
    "same values (no change) → REJECTED",
    async () => {
      await executeIncreaseResourceLimit(DEPLOYMENT, {
        namespace: NAMESPACE,
        cpu: 1,
        memory: 512,
      });
    },
    true,
    "requires at least one dimension to strictly increase"
  );

  // ── Zod schema boundary tests ─────────────────────────────────────
  console.log("\n[Test Group 2] Zod schema boundary checks\n");

  await testCase(
    "cpu exceeds max (5) → schema rejects",
    async () => {
      validateActionParams({
        actionType: "increase_resource_limit",
        params: { namespace: NAMESPACE, cpu: 5, memory: 1024 },
      });
    },
    true,
    "CPU limit cannot exceed 4 cores"
  );

  await testCase(
    "memory exceeds max (9999) → schema rejects",
    async () => {
      validateActionParams({
        actionType: "increase_resource_limit",
        params: { namespace: NAMESPACE, cpu: 1, memory: 9999 },
      });
    },
    true,
    "Memory limit cannot exceed 8192 MiB"
  );

  await testCase(
    "scale_replicas exceeds max (11) → schema rejects",
    async () => {
      validateActionParams({
        actionType: "scale_replicas",
        params: { namespace: NAMESPACE, replicas: 11 },
      });
    },
    true,
    "Replica count cannot exceed 10"
  );

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);

  // Restore baseline for subsequent tests
  console.log("\n[Cleanup] Restoring deployment to cpu=1, memory=512Mi");
  setBaseline("1", "512Mi");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
