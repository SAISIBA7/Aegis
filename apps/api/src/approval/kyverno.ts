import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface KyvernoEvaluationResult {
  allowed: boolean;
  reason?: string;
  policyName?: string;
  details?: Record<string, unknown>;
}

const KUBE_CONTEXT = process.env.KUBE_CONTEXT || "kind-aegis";

/**
 * Protected system namespaces where Aegis operations are prohibited.
 * Must match the namespaces in aegis-protected-namespaces policy.
 */
const PROTECTED_NAMESPACES = new Set(["kube-system", "kyverno", "local-path-storage"]);

/**
 * Checks if a namespace is protected.
 */
function isProtectedNamespace(ns: string): boolean {
  return PROTECTED_NAMESPACES.has(ns);
}

/**
 * Extracts the user-friendly Kyverno denial reason from kubectl stderr output.
 */
function extractKyvernoDenial(stderr: string): string {
  const marker = "denied the request:";
  const index = stderr.indexOf(marker);
  if (index !== -1) {
    return stderr.substring(index + marker.length).trim();
  }
  return stderr.trim();
}

/**
 * Evaluates an Aegis remediation proposal against in-cluster Kyverno ClusterPolicies
 * using server-side dry-run requests against kind-aegis.
 *
 * This performs a REAL network call to the Kubernetes API server, triggering
 * Kyverno's live ValidatingWebhookConfiguration without mutating cluster state.
 */
export async function evaluateKyvernoPolicy(
  actionType: string,
  target: string,
  params: Record<string, unknown>
): Promise<KyvernoEvaluationResult> {
  // 1. Verify action type is one of the four allowed actions
  const allowedActions = [
    "restart_pod",
    "rollback_deployment",
    "increase_resource_limit",
    "scale_replicas",
  ];

  if (!allowedActions.includes(actionType)) {
    return {
      allowed: false,
      reason: `Disallowed actionType '${actionType}': only ${allowedActions.join(", ")} are permitted.`,
    };
  }

  const namespace = (params.namespace as string) || "default";

  // Check for protected namespaces (Kyverno webhook skips these, so enforce in application code)
  if (isProtectedNamespace(namespace)) {
    return {
      allowed: false,
      reason: `Remediation actions targeting protected system namespace '${namespace}' are prohibited (Aegis policy violation).`,
    };
  }

  try {
    switch (actionType) {
      case "increase_resource_limit": {
        const cpu = params.cpu;
        const memory = params.memory;

        const patchPayload = JSON.stringify({
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: target,
                    resources: {
                      limits: {
                        cpu: String(cpu),
                        memory: `${memory}Mi`,
                      },
                    },
                  },
                ],
              },
            },
          },
        });

        await execFileAsync(
          "kubectl",
          [
            "patch",
            `deployment/${target}`,
            "-n",
            namespace,
            "--type=strategic",
            "-p",
            patchPayload,
            "--dry-run=server",
            "--context",
            KUBE_CONTEXT,
          ],
          {
            env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG },
            windowsHide: true,
          }
        );
        return { allowed: true };
      }

      case "scale_replicas": {
        const replicas = params.replicas;

        await execFileAsync(
          "kubectl",
          [
            "scale",
            `deployment/${target}`,
            `--replicas=${replicas}`,
            "-n",
            namespace,
            "--dry-run=server",
            "--context",
            KUBE_CONTEXT,
          ],
          {
            env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG },
            windowsHide: true,
          }
        );
        return { allowed: true };
      }

      case "restart_pod": {
        await execFileAsync(
          "kubectl",
          [
            "delete",
            "pod",
            target,
            "-n",
            namespace,
            "--dry-run=server",
            "--context",
            KUBE_CONTEXT,
          ],
          {
            env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG },
            windowsHide: true,
          }
        );
        return { allowed: true };
      }

      case "rollback_deployment": {
        // Enforce invariant: revision parameter was removed in Phase 5 fix
        if (params.revision !== undefined) {
          return {
            allowed: false,
            reason:
              "Arbitrary revision rollback is prohibited (revision parameter not allowed).",
          };
        }

        await execFileAsync(
          "kubectl",
          [
            "rollout",
            "undo",
            `deployment/${target}`,
            "-n",
            namespace,
            "--dry-run=server",
            "--context",
            KUBE_CONTEXT,
          ],
          {
            env: { ...process.env, KUBECONFIG: process.env.KUBECONFIG },
            windowsHide: true,
          }
        );
        return { allowed: true };
      }

      default:
        return {
          allowed: false,
          reason: `Unknown actionType '${actionType}'`,
        };
    }
  } catch (err: any) {
    const stderr: string = err.stderr || err.message || "";

    // Check if denied by Kyverno admission webhook
    if (
      stderr.includes("admission webhook") ||
      stderr.includes("denied the request") ||
      stderr.includes("policy violation")
    ) {
      const cleanReason = extractKyvernoDenial(stderr);
      return {
        allowed: false,
        reason: cleanReason,
        details: { stderr },
      };
    }

    // Check if target resource is not found
    if (stderr.includes("NotFound") || stderr.includes("not found")) {
      return {
        allowed: false,
        reason: `Target resource '${target}' not found in namespace '${namespace}': ${stderr.trim()}`,
        details: { stderr },
      };
    }

    // Any other kubectl error
    return {
      allowed: false,
      reason: `Policy evaluation error: ${stderr.trim()}`,
      details: { stderr },
    };
  }
}
