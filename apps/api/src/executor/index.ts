import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { PrismaClient, Prisma } from "@prisma/client";
import { JobStatus } from "@aegis/shared";
import { transitionJobStatus } from "../stateMachine";

const execFileAsync = promisify(execFile);

/**
 * Core action type accepted by the Executor.
 * The Executor only accepts a strict (actionType, params) pair — never free text,
 * never kagent's raw output directly.
 */
export interface ExecutorAction {
  actionType: "restart_pod" | "rollback_deployment" | "increase_resource_limit" | "scale_replicas";
  params: Record<string, unknown>;
}

/**
 * Result of executing an action.
 */
export interface ExecutorResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Zod schemas for each action's specific parameters.
 * Each handler validates its own params — reject anything outside bounds before it reaches Kubernetes.
 */

// restart_pod: target is the pod name, params contains namespace
export const RestartPodParamsSchema = z.object({
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
});
export type RestartPodParams = z.infer<typeof RestartPodParamsSchema>;

// rollback_deployment: target is deployment name, params contains namespace
export const RollbackDeploymentParamsSchema = z.object({
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  revision: z.number().int().positive().optional(),
});
export type RollbackDeploymentParams = z.infer<typeof RollbackDeploymentParamsSchema>;

// increase_resource_limit: target is deployment name, params contains namespace, cpu, memory
export const IncreaseResourceLimitParamsSchema = z.object({
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  cpu: z.number().positive().max(4, "CPU limit cannot exceed 4 cores"),
  memory: z.number().positive().max(8192, "Memory limit cannot exceed 8192 MiB"),
});
export type IncreaseResourceLimitParams = z.infer<typeof IncreaseResourceLimitParamsSchema>;

// scale_replicas: target is deployment name, params contains namespace, replicas
export const ScaleReplicasParamsSchema = z.object({
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  replicas: z.number().int().positive().max(10, "Replica count cannot exceed 10"),
});
export type ScaleReplicasParams = z.infer<typeof ScaleReplicasParamsSchema>;

/**
 * Maps actionType to its parameter schema for validation.
 */
const ACTION_SCHEMAS: Record<ExecutorAction["actionType"], z.ZodSchema> = {
  restart_pod: RestartPodParamsSchema,
  rollback_deployment: RollbackDeploymentParamsSchema,
  increase_resource_limit: IncreaseResourceLimitParamsSchema,
  scale_replicas: ScaleReplicasParamsSchema,
};

/**
 * Validates action parameters against the appropriate schema.
 * Throws if validation fails.
 */
export function validateActionParams(action: ExecutorAction): void {
  const schema = ACTION_SCHEMAS[action.actionType];
  if (!schema) {
    throw new Error(`Unknown action type: ${action.actionType}`);
  }
  const result = schema.safeParse(action.params);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    throw new Error(`Invalid parameters for ${action.actionType}: ${JSON.stringify(errors)}`);
  }
}

/**
 * Kubernetes context used for all executor operations.
 * Defaults to kind-aegis for local development.
 */
const KUBE_CONTEXT = process.env.KUBE_CONTEXT || "kind-aegis";

/**
 * Sanitizes a Kubernetes identifier (namespace, deployment name, pod name) to RFC 1123.
 */
function sanitizeIdentifier(value: string, fieldName: string): void {
  if (!value || typeof value !== "string" || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) {
    throw new Error(`Invalid RFC 1123 identifier for ${fieldName}: '${value}'`);
  }
}

/**
 * Executes a kubectl command with the configured context.
 */
async function runKubectl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("kubectl", args, {
    env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG },
    windowsHide: true,
  });
}

/**
 * Action handler: restart_pod
 * Deletes the specified pod, allowing the Deployment to recreate it.
 * target: pod name
 * params: { namespace }
 */
export async function executeRestartPod(
  target: string,
  params: RestartPodParams
): Promise<ExecutorResult> {
  sanitizeIdentifier(target, "pod name");
  sanitizeIdentifier(params.namespace, "namespace");

  console.log(`[Executor] restart_pod: deleting pod '${target}' in namespace '${params.namespace}'...`);

  const { stdout, stderr } = await runKubectl([
    "delete",
    "pod",
    target,
    "-n",
    params.namespace,
    "--context",
    KUBE_CONTEXT,
    "--grace-period=0",
    "--force",
  ]);

  if (stderr && !stderr.includes("Warning:")) {
    throw new Error(`kubectl delete pod failed: ${stderr}`);
  }

  return {
    success: true,
    message: `Pod '${target}' deleted in namespace '${params.namespace}'. Deployment will recreate it.`,
    details: { pod: target, namespace: params.namespace, stdout: stdout.trim() },
  };
}

/**
 * Action handler: rollback_deployment
 * Rolls back the Deployment to the previous revision (or specified revision).
 * target: deployment name
 * params: { namespace, revision? }
 */
export async function executeRollbackDeployment(
  target: string,
  params: RollbackDeploymentParams
): Promise<ExecutorResult> {
  sanitizeIdentifier(target, "deployment name");
  sanitizeIdentifier(params.namespace, "namespace");

  console.log(`[Executor] rollback_deployment: rolling back deployment '${target}' in namespace '${params.namespace}'...`);

  const args = [
    "rollout",
    "undo",
    `deployment/${target}`,
    "-n",
    params.namespace,
    "--context",
    KUBE_CONTEXT,
  ];

  if (params.revision) {
    args.push("--to-revision", String(params.revision));
  }

  const { stdout, stderr } = await runKubectl(args);

  if (stderr && !stderr.includes("Warning:")) {
    throw new Error(`kubectl rollout undo failed: ${stderr}`);
  }

  return {
    success: true,
    message: `Deployment '${target}' rolled back${params.revision ? ` to revision ${params.revision}` : ""} in namespace '${params.namespace}'.`,
    details: { deployment: target, namespace: params.namespace, revision: params.revision, stdout: stdout.trim() },
  };
}

/**
 * Action handler: increase_resource_limit
 * Patches the Deployment's container resource limits (CPU/memory).
 * target: deployment name
 * params: { namespace, cpu, memory }
 */
export async function executeIncreaseResourceLimit(
  target: string,
  params: IncreaseResourceLimitParams
): Promise<ExecutorResult> {
  sanitizeIdentifier(target, "deployment name");
  sanitizeIdentifier(params.namespace, "namespace");

  console.log(`[Executor] increase_resource_limit: patching deployment '${target}' in namespace '${params.namespace}' with cpu=${params.cpu}, memory=${params.memory}Mi...`);

  // Use kubectl patch to update resource limits
  const patch = JSON.stringify({
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: target,
              resources: {
                limits: {
                  cpu: String(params.cpu),
                  memory: `${params.memory}Mi`,
                },
                requests: {
                  cpu: String(params.cpu / 2),
                  memory: `${params.memory / 2}Mi`,
                },
              },
            },
          ],
        },
      },
    },
  });

  const { stdout, stderr } = await runKubectl([
    "patch",
    `deployment/${target}`,
    "-n",
    params.namespace,
    "--context",
    KUBE_CONTEXT,
    "--type",
    "strategic",
    "-p",
    patch,
  ]);

  if (stderr && !stderr.includes("Warning:")) {
    throw new Error(`kubectl patch failed: ${stderr}`);
  }

  return {
    success: true,
    message: `Deployment '${target}' resource limits updated to cpu=${params.cpu}, memory=${params.memory}Mi in namespace '${params.namespace}'.`,
    details: { deployment: target, namespace: params.namespace, cpu: params.cpu, memory: params.memory, stdout: stdout.trim() },
  };
}

/**
 * Action handler: scale_replicas
 * Adjusts the Deployment's replica count.
 * target: deployment name
 * params: { namespace, replicas }
 */
export async function executeScaleReplicas(
  target: string,
  params: ScaleReplicasParams
): Promise<ExecutorResult> {
  sanitizeIdentifier(target, "deployment name");
  sanitizeIdentifier(params.namespace, "namespace");

  console.log(`[Executor] scale_replicas: scaling deployment '${target}' in namespace '${params.namespace}' to ${params.replicas} replicas...`);

  const { stdout, stderr } = await runKubectl([
    "scale",
    `deployment/${target}`,
    "-n",
    params.namespace,
    "--context",
    KUBE_CONTEXT,
    `--replicas=${params.replicas}`,
  ]);

  if (stderr && !stderr.includes("Warning:")) {
    throw new Error(`kubectl scale failed: ${stderr}`);
  }

  return {
    success: true,
    message: `Deployment '${target}' scaled to ${params.replicas} replicas in namespace '${params.namespace}'.`,
    details: { deployment: target, namespace: params.namespace, replicas: params.replicas, stdout: stdout.trim() },
  };
}

/**
 * Dispatches an action to the appropriate handler.
 * This is the ONLY entry point for executing actions — never call handlers directly from outside.
 */
export async function executeAction(
  action: ExecutorAction,
  target: string
): Promise<ExecutorResult> {
  // Validate params first
  validateActionParams(action);

  switch (action.actionType) {
    case "restart_pod":
      return executeRestartPod(target, action.params as RestartPodParams);
    case "rollback_deployment":
      return executeRollbackDeployment(target, action.params as RollbackDeploymentParams);
    case "increase_resource_limit":
      return executeIncreaseResourceLimit(target, action.params as IncreaseResourceLimitParams);
    case "scale_replicas":
      return executeScaleReplicas(target, action.params as ScaleReplicasParams);
    default:
      throw new Error(`Unknown action type: ${action.actionType}`);
  }
}

/**
 * Runs an action through the state machine: APPROVED -> APPLYING -> EXECUTED/FAILED.
 * This is the main entry point that integrates with the existing state machine.
 * The Job must already be in APPROVED state.
 */
export async function runExecutorWithStateMachine(
  prismaClient: PrismaClient,
  jobId: string,
  action: ExecutorAction,
  target: string
): Promise<ExecutorResult> {
  // First transition: APPROVED -> APPLYING
  await transitionJobStatus(prismaClient, jobId, JobStatus.APPLYING, {
    step: "executor_started",
    actionType: action.actionType,
    target,
    params: action.params as Prisma.InputJsonValue,
  });

  try {
    // Execute the action
    const result = await executeAction(action, target);

    // Success transition: APPLYING -> EXECUTED
    await transitionJobStatus(prismaClient, jobId, JobStatus.EXECUTED, {
      step: "executor_completed",
      actionType: action.actionType,
      target,
      result: result.details as Prisma.InputJsonValue,
    });

    return result;
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Failure transition: APPLYING -> FAILED
    await transitionJobStatus(prismaClient, jobId, JobStatus.FAILED, {
      step: "executor_failed",
      actionType: action.actionType,
      target,
      error: errorMsg,
    });

    return {
      success: false,
      message: `Executor failed: ${errorMsg}`,
      details: { actionType: action.actionType, target, error: errorMsg },
    };
  }
}

/**
 * Manual test helper: runs an action directly without state machine (for Phase 5 manual testing).
 * This is NOT the production path — it's for manual verification only.
 */
export async function runExecutorManual(
  action: ExecutorAction,
  target: string
): Promise<ExecutorResult> {
  validateActionParams(action);
  return executeAction(action, target);
}