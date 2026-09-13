import { Worker, Job as BullJob } from "bullmq";
import { execFile, exec } from "child_process";
import path from "path";
import fs from "fs";
import { promisify } from "util";
import { JobStatus } from "@aegis/shared";
import { prisma } from "../db";
import { transitionJobStatus } from "../stateMachine";
import {
  PROVISIONING_QUEUE_NAME,
  ProvisioningJobData,
  redisConnection,
  enqueueDiagnosticJob,
} from "../queue";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// Resolve path to infra/terraform from apps/api/src/workers
const TERRAFORM_DIR = path.resolve(__dirname, "../../../../infra/terraform");

/**
 * In-memory FIFO mutex keyed by appName to serialize Terraform workspace
 * operations for the same application while allowing different applications
 * to run fully in parallel.
 */
export class KeyedMutex {
  private chains = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    const currentLock = this.chains.get(key) || Promise.resolve();
    this.chains.set(key, nextLock);

    await currentLock;

    return () => {
      if (this.chains.get(key) === nextLock) {
        this.chains.delete(key);
      }
      release();
    };
  }

  isLocked(key: string): boolean {
    return this.chains.has(key);
  }
}

/**
 * Shared per-appName mutex instance.
 */
export const appMutex = new KeyedMutex();

// Internal mutex to serialize workspace select/new operations (typically <100ms)
// preventing race conditions on the single .terraform/environment pointer file
let workspaceSelectChain: Promise<void> = Promise.resolve();

/**
 * Executes a terraform CLI command with args in TERRAFORM_DIR.
 */
async function runTerraform(
  args: string[],
  extraEnv?: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  if (!fs.existsSync(TERRAFORM_DIR)) {
    throw new Error(`Terraform directory not found at: ${TERRAFORM_DIR}`);
  }

  // On Windows, terraform is typically terraform.exe in PATH
  return await execFileAsync("terraform", args, {
    cwd: TERRAFORM_DIR,
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  });
}

/**
 * Ensures a dedicated Terraform workspace exists and is selected for the given appName.
 * This guarantees state isolation so subsequent jobs do not overwrite or destroy previous apps.
 */
async function ensureTerraformWorkspace(workspaceName: string): Promise<void> {
  let releaseSetup!: () => void;
  const nextSetup = new Promise<void>((resolve) => {
    releaseSetup = resolve;
  });
  const currentSetup = workspaceSelectChain;
  workspaceSelectChain = nextSetup;

  await currentSetup;
  try {
    try {
      // Attempt to select the existing workspace
      await runTerraform(["workspace", "select", workspaceName]);
    } catch {
      // If selecting fails, create the workspace
      await runTerraform(["workspace", "new", workspaceName]);
    }
  } finally {
    releaseSetup();
  }
}

/**
 * Resolves worker concurrency from environment variable WORKER_CONCURRENCY,
 * defaulting to 5 if unset or invalid.
 */
export function getWorkerConcurrency(): number {
  const envVal = process.env.WORKER_CONCURRENCY;
  if (!envVal) return 5;
  const parsed = parseInt(envVal, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
}

/**
 * Verifies that the deployed application pods become Ready on the Kubernetes cluster.
 * If pods fail (e.g. ImagePullBackOff, ErrImagePull, CrashLoopBackOff) or timeout,
 * returns { healthy: false, reason }.
 */
async function verifyPodHealth(
  appName: string,
  namespace: string,
  desiredReplicas: number,
  timeoutMs: number = 12000
): Promise<{ healthy: boolean; reason?: string }> {
  const startTime = Date.now();
  console.log(
    `[ProvisioningWorker] Verifying pod readiness for app '${appName}' (waiting up to ${timeoutMs / 1000}s)...`
  );

  while (Date.now() - startTime < timeoutMs) {
    try {
      const cmd = `kubectl get pods -n ${namespace} -l app=${appName} -o json --context kind-aegis`;
      const { stdout } = await execAsync(cmd);
      const parsed = JSON.parse(stdout || "{}");
      const items = Array.isArray(parsed.items) ? parsed.items : [];

      if (items.length > 0) {
        for (const pod of items) {
          const containerStatuses = pod.status?.containerStatuses || [];
          for (const cs of containerStatuses) {
            const waitingReason = cs.state?.waiting?.reason;
            const waitingMsg = cs.state?.waiting?.message;
            if (
              waitingReason === "ImagePullBackOff" ||
              waitingReason === "ErrImagePull" ||
              waitingReason === "CrashLoopBackOff"
            ) {
              return {
                healthy: false,
                reason: `Container '${cs.name}' entered failure state '${waitingReason}'${
                  waitingMsg ? `: ${waitingMsg}` : ""
                }`,
              };
            }
          }
        }

        const readyPods = items.filter((pod: any) => {
          const conditions = pod.status?.conditions || [];
          const readyCond = conditions.find((c: any) => c.type === "Ready");
          return readyCond && readyCond.status === "True";
        });

        if (readyPods.length >= desiredReplicas) {
          console.log(
            `[ProvisioningWorker] All ${readyPods.length}/${desiredReplicas} pods ready for app '${appName}'.`
          );
          return { healthy: true };
        }
      }
    } catch {
      // transient cluster check error
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  return {
    healthy: false,
    reason: `Pods for app '${appName}' did not become ready within ${timeoutMs / 1000}s timeout.`,
  };
}

/**
 * Main provisioning handler for each BullMQ deployment job.
 */
export async function processProvisioningJob(
  bullJob: BullJob<ProvisioningJobData>
): Promise<void> {
  const { jobId, payload } = bullJob.data;
  let { appName, image, cpu, memory, replicas, simulateFailure } = payload;
  const sanitizedAppName = appName.trim().toLowerCase();
  const workspaceName = sanitizedAppName;

  // Failure injection support for testing Phase 4
  if (simulateFailure === "bad_image" && !image.includes("bad") && !image.includes("invalid")) {
    image = "nginx:invalid-tag-phase4-failure";
  } else if (simulateFailure === "resource_quota") {
    cpu = 999;
  }

  console.log(
    `[ProvisioningWorker] Processing deployment job ${jobId} for app '${sanitizedAppName}'...`
  );

  // 1. Transition state: INITIATED -> PROVISIONING
  await transitionJobStatus(prisma, jobId, JobStatus.PROVISIONING, {
    step: "terraform_apply_started",
    appName: sanitizedAppName,
    workspace: workspaceName,
  });

  // 2. Acquire per-appName lock to serialize jobs targeting the same workspace
  console.log(
    `[ProvisioningWorker] Job ${jobId} acquiring lock for app '${sanitizedAppName}'...`
  );
  const releaseLock = await appMutex.acquire(sanitizedAppName);
  console.log(
    `[ProvisioningWorker] Job ${jobId} acquired lock for app '${sanitizedAppName}'.`
  );

  try {
    // 3. Select or create Terraform workspace for state isolation
    console.log(
      `[ProvisioningWorker] Selecting/creating Terraform workspace '${workspaceName}'...`
    );
    await ensureTerraformWorkspace(workspaceName);

    // 4. Run terraform apply with job payload variables, explicitly binding TF_WORKSPACE
    console.log(
      `[ProvisioningWorker] Running 'terraform apply' for app '${sanitizedAppName}'...`
    );
    const applyArgs = [
      "apply",
      "-auto-approve",
      "-input=false",
      "-var",
      "kube_context=kind-aegis",
      "-var",
      `app_name=${sanitizedAppName}`,
      "-var",
      `image=${image}`,
      "-var",
      `cpu=${cpu}`,
      "-var",
      `memory=${memory}`,
      "-var",
      `replicas=${replicas ?? 1}`,
    ];

    const { stdout } = await runTerraform(applyArgs, {
      TF_WORKSPACE: workspaceName,
    });
    console.log(
      `[ProvisioningWorker] 'terraform apply' succeeded for app '${sanitizedAppName}'.`
    );

    // 5. Verify pod readiness on the cluster
    const health = await verifyPodHealth(
      sanitizedAppName,
      sanitizedAppName,
      replicas ?? 1,
      12000
    );

    if (health.healthy) {
      // Transition state: PROVISIONING -> EXECUTED on success
      await transitionJobStatus(prisma, jobId, JobStatus.EXECUTED, {
        step: "terraform_apply_and_rollout_succeeded",
        appName: sanitizedAppName,
        workspace: workspaceName,
        message: `Successfully provisioned ${sanitizedAppName} to kind-aegis cluster`,
        summary:
          stdout
            .split("\n")
            .filter((l) => l.includes("Apply complete!"))
            .join(" ") || "Apply complete!",
      });
    } else {
      console.warn(
        `[ProvisioningWorker] Deployment unhealthy for app '${sanitizedAppName}': ${health.reason}`
      );

      // Transition state: PROVISIONING -> DIAGNOSING
      await transitionJobStatus(prisma, jobId, JobStatus.DIAGNOSING, {
        step: "deployment_unhealthy_initiating_diagnosis",
        appName: sanitizedAppName,
        workspace: workspaceName,
        reason: health.reason,
      });

      // Enqueue to diagnostic-queue for AI diagnosis
      await enqueueDiagnosticJob(
        jobId,
        sanitizedAppName,
        sanitizedAppName,
        health.reason
      );
    }
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : String(error);
    console.error(
      `[ProvisioningWorker] Provisioning failed for app '${sanitizedAppName}':`,
      errorMsg
    );

    // Transition state: PROVISIONING -> DIAGNOSING
    await transitionJobStatus(prisma, jobId, JobStatus.DIAGNOSING, {
      step: "terraform_apply_failed_initiating_diagnosis",
      appName: sanitizedAppName,
      workspace: workspaceName,
      error: errorMsg,
    });

    // Enqueue to diagnostic-queue for AI diagnosis
    await enqueueDiagnosticJob(
      jobId,
      sanitizedAppName,
      sanitizedAppName,
      `Terraform apply error: ${errorMsg}`
    );
  } finally {
    releaseLock();
    console.log(
      `[ProvisioningWorker] Job ${jobId} released lock for app '${sanitizedAppName}'.`
    );
  }
}

/**
 * Initializes and exports the BullMQ Worker with configurable concurrency.
 */
export function initProvisioningWorker(
  concurrencyOverride?: number
): Worker<ProvisioningJobData> {
  const concurrency = concurrencyOverride ?? getWorkerConcurrency();

  console.log(
    `[ProvisioningWorker] Starting worker with concurrency = ${concurrency}`
  );

  const worker = new Worker<ProvisioningJobData>(
    PROVISIONING_QUEUE_NAME,
    processProvisioningJob,
    {
      connection: redisConnection,
      concurrency,
    }
  );

  worker.on("completed", (job) => {
    console.log(
      `[ProvisioningWorker] Job ${job.id} (DB ID: ${job.data.jobId}) completed successfully.`
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[ProvisioningWorker] Job ${job?.id} (DB ID: ${job?.data.jobId}) failed:`,
      err.message
    );
  });

  return worker;
}
