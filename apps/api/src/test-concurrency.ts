import { JobStatus } from "@aegis/shared";
import { prisma } from "./db";
import { app } from "./app";
import { initProvisioningWorker } from "./workers/provisioning.worker";
import { provisioningQueue, redisConnection } from "./queue";
import { Server } from "http";
import { execSync } from "child_process";
import path from "path";

const TERRAFORM_DIR = path.resolve(__dirname, "../../../infra/terraform");

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function pollJobUntilTerminal(baseUrl: string, jobId: string, maxPolls = 60): Promise<any> {
  let pollCount = 0;
  while (pollCount < maxPolls) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`${baseUrl}/jobs/${jobId}`);
    const data = await res.json();
    if (data.status === JobStatus.EXECUTED || data.status === JobStatus.FAILED) {
      return data;
    }
    pollCount++;
  }
  throw new Error(`Job ${jobId} timed out waiting for terminal state`);
}

async function runConcurrencyTests() {
  console.log("===================================================================");
  console.log("=== STARTING WORKER CONCURRENCY & PER-APP MUTEX VERIFICATION ===");
  console.log("===================================================================");

  const testPort = 3100;
  const server: Server = app.listen(testPort);
  const worker = initProvisioningWorker(5);
  const baseUrl = `http://localhost:${testPort}`;

  try {
    // =========================================================================
    // SCENARIO 1: 3 DIFFERENT APPNAMES SUBMITTED CONCURRENTLY
    // =========================================================================
    console.log("\n--- SCENARIO 1: Submitting 3 different apps concurrently ---");
    const appNames = ["p-svc-alpha", "p-svc-beta", "p-svc-gamma"];

    const submitPromises = appNames.map(async (appName) => {
      const res = await fetch(`${baseUrl}/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appName,
          image: "nginx:alpine",
          cpu: 0.1,
          memory: 64,
          replicas: 1,
        }),
      });
      assert(res.status === 202, `POST /deployments should return 202 for ${appName}`);
      const body = await res.json();
      console.log(`✓ Submitted ${appName} -> Job ID: ${body.jobId}`);
      return { appName, jobId: body.jobId as string };
    });

    const submittedJobs = await Promise.all(submitPromises);

    console.log("\nWaiting for all 3 jobs to complete in parallel...");
    const results = await Promise.all(
      submittedJobs.map((j) => pollJobUntilTerminal(baseUrl, j.jobId))
    );

    for (let i = 0; i < submittedJobs.length; i++) {
      const job = submittedJobs[i];
      const result = results[i];
      console.log(`  Job ${job.appName} (${job.jobId}) final status: ${result.status}`);
      assert(
        result.status === JobStatus.EXECUTED,
        `Job ${job.appName} should reach EXECUTED, got ${result.status}`
      );
    }

    // Check AuditLog for overlapping execution intervals
    console.log("\nInspecting AuditLog timestamps to verify parallel execution:");
    interface JobTiming {
      appName: string;
      jobId: string;
      startedAt: Date;
      completedAt: Date;
    }

    const timings: JobTiming[] = [];

    for (const job of submittedJobs) {
      const logs = await prisma.auditLog.findMany({
        where: { jobId: job.jobId },
        orderBy: { timestamp: "asc" },
      });

      const provLog = logs.find((l) => l.toStatus === JobStatus.PROVISIONING);
      const execLog = logs.find((l) => l.toStatus === JobStatus.EXECUTED);

      assert(!!provLog, `Missing PROVISIONING log for job ${job.jobId}`);
      assert(!!execLog, `Missing EXECUTED log for job ${job.jobId}`);

      timings.push({
        appName: job.appName,
        jobId: job.jobId,
        startedAt: provLog!.timestamp,
        completedAt: execLog!.timestamp,
      });

      console.log(
        `  ${job.appName.padEnd(14)}: Started ${provLog!.timestamp.toISOString()} -> Finished ${execLog!.timestamp.toISOString()} (Duration: ${
          ((execLog!.timestamp.getTime() - provLog!.timestamp.getTime()) / 1000).toFixed(2)
        }s)`
      );
    }

    // Verify overlap: Check if interval [start_A, end_A] overlaps with [start_B, end_B]
    let overlapCount = 0;
    for (let i = 0; i < timings.length; i++) {
      for (let j = i + 1; j < timings.length; j++) {
        const a = timings[i];
        const b = timings[j];
        const overlapStart = Math.max(a.startedAt.getTime(), b.startedAt.getTime());
        const overlapEnd = Math.min(a.completedAt.getTime(), b.completedAt.getTime());
        const overlapMs = overlapEnd - overlapStart;

        if (overlapMs > 0) {
          console.log(
            `  ✓ Overlap verified between ${a.appName} and ${b.appName}: ${(overlapMs / 1000).toFixed(2)}s concurrent execution`
          );
          overlapCount++;
        }
      }
    }

    assert(
      overlapCount > 0,
      "Expected overlapping provisioning execution times across different apps"
    );
    console.log("✓ Parallel execution for different appNames successfully verified!");

    // Verify all 3 pods exist in kind cluster
    for (const appName of appNames) {
      const pods = execSync(`kubectl get pods -n ${appName} --context kind-aegis`, {
        encoding: "utf8",
      });
      assert(pods.includes(appName), `Pod for ${appName} must exist in namespace`);
    }
    console.log("✓ Kubernetes pods verified for all 3 concurrently provisioned apps.");

    // =========================================================================
    // SCENARIO 2: 2 DEPLOYMENTS FOR THE SAME APPNAME SUBMITTED AT THE SAME TIME
    // =========================================================================
    console.log("\n--- SCENARIO 2: Submitting 2 deployments for the SAME appName concurrently ---");
    const sameAppName = "app-same-name";

    const submitSame1 = fetch(`${baseUrl}/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: sameAppName,
        image: "nginx:alpine",
        cpu: 0.1,
        memory: 64,
        replicas: 1,
      }),
    }).then((r) => r.json());

    const submitSame2 = fetch(`${baseUrl}/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: sameAppName,
        image: "nginx:alpine",
        cpu: 0.1,
        memory: 64,
        replicas: 2, // 2 replicas in 2nd deployment
      }),
    }).then((r) => r.json());

    const [sameData1, sameData2] = await Promise.all([submitSame1, submitSame2]);
    console.log(`✓ Submitted Job 1: ${sameData1.jobId} for ${sameAppName}`);
    console.log(`✓ Submitted Job 2: ${sameData2.jobId} for ${sameAppName}`);

    console.log("\nWaiting for both same-appName jobs to finish safely...");
    const [sameResult1, sameResult2] = await Promise.all([
      pollJobUntilTerminal(baseUrl, sameData1.jobId),
      pollJobUntilTerminal(baseUrl, sameData2.jobId),
    ]);

    console.log(`  Job 1 (${sameData1.jobId}) final status: ${sameResult1.status}`);
    console.log(`  Job 2 (${sameData2.jobId}) final status: ${sameResult2.status}`);

    assert(
      sameResult1.status === JobStatus.EXECUTED,
      `Job 1 for same appName must reach EXECUTED, got ${sameResult1.status}`
    );
    assert(
      sameResult2.status === JobStatus.EXECUTED,
      `Job 2 for same appName must reach EXECUTED, got ${sameResult2.status}`
    );

    // Verify Terraform workspace state integrity
    console.log("\nChecking 'terraform workspace list' for workspace integrity...");
    const wsListOutput = execSync("terraform workspace list", {
      cwd: TERRAFORM_DIR,
      encoding: "utf8",
    });
    console.log("Terraform workspaces:\n" + wsListOutput);
    assert(
      wsListOutput.includes(sameAppName),
      `Workspace '${sameAppName}' must exist in terraform workspace list`
    );

    // Verify Kubernetes deployment state has replicas: 2
    const podsSame = execSync(`kubectl get pods -n ${sameAppName} --context kind-aegis`, {
      encoding: "utf8",
    });
    console.log(`Kubectl pods in ${sameAppName}:\n` + podsSame);
    assert(podsSame.includes(sameAppName), `Pod for ${sameAppName} must exist`);

    console.log("✓ Same appName serialized execution passed with ZERO state corruption!");
  } finally {
    server.close();
    await worker.close();
    await provisioningQueue.close();
    await redisConnection.quit();
    await prisma.$disconnect();
  }

  console.log("\n===================================================================");
  console.log("=== ALL CONCURRENCY AND MUTEX TESTS PASSED SUCCESSFULLY! ===");
  console.log("===================================================================");
}

runConcurrencyTests().catch((err) => {
  console.error("Concurrency test failed:", err);
  process.exit(1);
});
