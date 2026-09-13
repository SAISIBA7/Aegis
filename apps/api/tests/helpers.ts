import dotenv from "dotenv";
import path from "path";

// Load env BEFORE importing any application module — db.ts and queue.ts read
// DATABASE_URL / REDIS_URL from process.env at module load time.
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { execFile } from "child_process";
import { promisify } from "util";
import { AddressInfo } from "net";
import { Server } from "http";
import fs from "fs";
import os from "os";
import { Prisma } from "@prisma/client";
import { Job, AuditLog } from "@prisma/client";
import { JobStatus } from "@aegis/shared";

import { prisma } from "../src/db";
import { app } from "../src/app";
import { createJob, transitionJobStatus } from "../src/stateMachine";
import { initProvisioningWorker } from "../src/workers/provisioning.worker";
import { initDiagnosticWorker } from "../src/workers/diagnostic.worker";
import { initApprovalWorker } from "../src/workers/approval.worker";
import {
  provisioningQueue,
  diagnosticQueue,
  remediationQueue,
  redisConnection,
  enqueueDiagnosticJob,
} from "../src/queue";

const execFileAsync = promisify(execFile);

export const KUBE_CONTEXT = process.env.KUBE_CONTEXT || "kind-aegis";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short, RFC1123-safe unique suffix for app/namespace names. */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function execKubectl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("kubectl", args, {
    env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG },
    windowsHide: true,
  });
}

export async function ensureNamespace(namespace: string): Promise<void> {
  try {
    await execKubectl(["create", "namespace", namespace, "--context", KUBE_CONTEXT]);
  } catch (err: any) {
    if (!/already exists/i.test(err?.stderr || err?.message || "")) throw err;
  }
}

export async function deleteNamespace(namespace: string): Promise<void> {
  try {
    await execKubectl([
      "delete",
      "namespace",
      namespace,
      "--context",
      KUBE_CONTEXT,
      "--ignore-not-found=true",
      "--wait=false",
    ]);
  } catch {
    // Nothing to clean up — ignore.
  }
}

/**
 * Creates a small REAL deployment on the cluster for use as a remediation
 * target. The manifest sets explicit resource limits because Kyverno's
 * aegis-resource-limits-bounds policy (correctly) denies deployments without
 * any limits.
 */
export async function createDeploymentFixture(
  name: string,
  namespace: string
): Promise<void> {
  await ensureNamespace(namespace);
  const manifest = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    "  labels:",
    `    app: ${name}`,
    "    managed-by: aegis-phase7-test",
    "spec:",
    "  replicas: 1",
    "  selector:",
    "    matchLabels:",
    `      app: ${name}`,
    "  template:",
    "    metadata:",
    "      labels:",
    `        app: ${name}`,
    "    spec:",
    "      containers:",
    `        - name: ${name}`,
    "          image: nginx:alpine",
    "          resources:",
    "            limits:",
    '              cpu: "0.2"',
    '              memory: "128Mi"',
    "            requests:",
    '              cpu: "0.1"',
    '              memory: "64Mi"',
  ].join("\n");

  const targetPath = path.join(
    process.env.TMPDIR || os.tmpdir(),
    `aegis-fixture-${name}-${Date.now()}.yaml`
  );
  fs.writeFileSync(targetPath, manifest, "utf8");
  try {
    await execFileAsync(
      "kubectl",
      ["apply", "-f", targetPath, "--context", KUBE_CONTEXT],
      { env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG }, windowsHide: true }
    );
  } finally {
    fs.rmSync(targetPath, { force: true });
  }
}

export async function deleteDeploymentFixture(
  name: string,
  namespace: string
): Promise<void> {
  try {
    await execKubectl([
      "delete",
      "deployment",
      name,
      "-n",
      namespace,
      "--context",
      KUBE_CONTEXT,
      "--ignore-not-found=true",
    ]);
  } catch {
    // Nothing to clean up — ignore.
  }
}

export interface DiagnosticProposalFixture {
  actionType: string;
  target: string;
  params: Record<string, unknown>;
  reasoning: string;
}

/** Builds a schema-valid proposal that the real Executor can run against a real deployment. */
export function buildValidProposal(
  actionType: string,
  target: string,
  params: Record<string, unknown>
): DiagnosticProposalFixture {
  return {
    actionType,
    target,
    params,
    reasoning: "Test fixture proposal: validated, approved, and executed through the real pipeline.",
  };
}

function asJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

/**
 * Creates a Job that is already sitting in PENDING_APPROVAL with a stored
 * proposal — i.e. the same end state the diagnostic worker produces.
 */
export async function createJobAtPendingApproval(
  proposal: DiagnosticProposalFixture,
  type = "remediation"
): Promise<Job> {
  const job = await createJob(prisma, {
    type,
    payload: { appName: proposal.target },
    status: JobStatus.PROPOSAL_GENERATED,
    metadata: { step: "test_fixture_start" },
  });
  await transitionJobStatus(
    prisma,
    job.id,
    JobStatus.PENDING_APPROVAL,
    {
      step: "awaiting_human_approval",
      appName: proposal.target,
      remediationAction: proposal.actionType,
      target: proposal.target,
    },
    asJson(proposal)
  );
  return job;
}

/** Creates a Job in DIAGNOSING state (e.g. for malformed-AI-output tests). */
export async function createJobAtDiagnosing(
  payload: Record<string, unknown> = {}
): Promise<Job> {
  return await createJob(prisma, {
    type: "deployment",
    payload: asJson(payload),
    status: JobStatus.DIAGNOSING,
    metadata: { step: "test_fixture_start" },
  });
}

export interface JobWithLogs extends Job {
  auditLogs: AuditLog[];
}

export async function getJobWithLogs(jobId: string): Promise<JobWithLogs | null> {
  return await prisma.job.findUnique({
    where: { id: jobId },
    include: { auditLogs: { orderBy: { timestamp: "asc" } } },
  });
}

export async function cleanupJob(jobId: string): Promise<void> {
  try {
    await prisma.job.delete({ where: { id: jobId } });
  } catch {
    // Already gone — ignore.
  }
}

export async function pollUntil(
  fn: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; description?: string } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for: ${opts.description ?? "condition"}`
      );
    }
    await sleep(intervalMs);
  }
}

export async function waitForJobStatus(
  jobId: string,
  status: JobStatus,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<JobWithLogs> {
  await pollUntil(
    async () => {
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      return job?.status === status;
    },
    { ...opts, description: `job ${jobId} to reach ${status}` }
  );
  const job = await getJobWithLogs(jobId);
  if (!job) throw new Error(`Job ${jobId} disappeared while waiting for ${status}`);
  return job;
}

export async function waitForTerminalStatus(
  jobId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<JobWithLogs> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const terminal = new Set<string>([
    JobStatus.EXECUTED,
    JobStatus.FAILED,
    JobStatus.REJECTED,
    JobStatus.POLICY_VIOLATED,
  ]);
  let last: JobWithLogs | null = null;
  await pollUntil(
    async () => {
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job) return false;
      last = await getJobWithLogs(jobId);
      return terminal.has(job.status);
    },
    { timeoutMs, intervalMs: opts.intervalMs ?? 1000, description: `job ${jobId} to reach a terminal state` }
  );
  if (!last) throw new Error(`Job ${jobId} disappeared while waiting for a terminal state`);
  return last;
}

/** Asserts the audit log of a job contains exactly this sequence of `toStatus` transitions. */
export function assertTransitionSequence(
  job: JobWithLogs,
  expected: JobStatus[]
): void {
  const actual = job.auditLogs.map((l) => l.toStatus);
  for (const status of expected) {
    if (!actual.includes(status)) {
      throw new Error(
        `Expected audit log to include transition → ${status}. Got: ${actual.join(" → ")}`
      );
    }
  }
  // Preserve order: the audit log is ordered by timestamp asc.
  const positions = expected.map((s) => actual.indexOf(s));
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] <= positions[i - 1]) {
      throw new Error(
        `Transitions out of order: expected ${expected.join(" → ")}, got ${actual.join(" → ")}`
      );
    }
  }
}

export function assertNoTransition(job: JobWithLogs, status: JobStatus): void {
  if (job.auditLogs.some((l) => l.toStatus === status)) {
    throw new Error(
      `Expected NO transition → ${status}, but audit log contains: ${job.auditLogs
        .map((l) => l.toStatus)
        .join(" → ")}`
    );
  }
}

export interface RunningSystem {
  server: Server;
  baseUrl: string;
  provisioningWorker: ReturnType<typeof initProvisioningWorker>;
  diagnosticWorker: ReturnType<typeof initDiagnosticWorker>;
  approvalWorker: ReturnType<typeof initApprovalWorker>;
}

export interface StartOptions {
  provisioning?: boolean;
  diagnostic?: boolean;
  approval?: boolean;
}

/** Boots the real Express app on an ephemeral port and (optionally) real BullMQ workers. */
export async function startTestSystem(opts: StartOptions = {}): Promise<RunningSystem> {
  const { provisioning = false, diagnostic = false, approval = false } = opts;
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const system: RunningSystem = {
    server,
    baseUrl,
    provisioningWorker: undefined as unknown as ReturnType<typeof initProvisioningWorker>,
    diagnosticWorker: undefined as unknown as ReturnType<typeof initDiagnosticWorker>,
    approvalWorker: undefined as unknown as ReturnType<typeof initApprovalWorker>,
  };
  if (provisioning) system.provisioningWorker = initProvisioningWorker();
  if (diagnostic) system.diagnosticWorker = initDiagnosticWorker();
  if (approval) system.approvalWorker = initApprovalWorker();
  return system;
}

/**
 * Shuts down the whole system — HTTP server, workers, queues, shared Redis,
 * and Prisma — so the Node process can exit on its own.
 * 
 * Must ALWAYS close Redis and Prisma, even if system is null, because test
 * files import helpers which imports db.ts and queue.ts, opening connections
 * at module load time. Leaving them open causes Jest to hang after tests exit.
 */
export async function stopTestSystem(system: RunningSystem | null): Promise<void> {
  if (system) {
    await new Promise<void>((resolve) => {
      if (!system.server.listening) return resolve();
      system.server.close(() => resolve());
    });
    if (system.provisioningWorker) await system.provisioningWorker.close();
    if (system.diagnosticWorker) await system.diagnosticWorker.close();
    if (system.approvalWorker) await system.approvalWorker.close();
  }
  // Always close these, regardless of system state, because they were opened at module load time.
  await provisioningQueue.close();
  await diagnosticQueue.close();
  await remediationQueue.close();
  await redisConnection.quit();
  await prisma.$disconnect();
}

/**
 * Submits a deployment request designed to FAIL (bad image tag), driving the
 * real provisioning flow into DIAGNOSING — the same entry point Phase 4 uses.
 */
export async function submitFailingDeployment(
  baseUrl: string,
  appName: string
): Promise<{ jobId: string; response: any }> {
  const res = await fetch(`${baseUrl}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appName,
      image: "nginx:alpine",
      cpu: 0.2,
      memory: 128,
      replicas: 1,
      simulateFailure: "bad_image",
    }),
  });
  if (res.status !== 202) {
    throw new Error(`POST /deployments returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return { jobId: body.jobId as string, response: body };
}

export { prisma, enqueueDiagnosticJob }; // re-export for convenience