import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class AgentGatewaySecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGatewaySecurityError";
    Object.setPrototypeOf(this, AgentGatewaySecurityError.prototype);
  }
}

export interface ToolExecutionTrace {
  tool: string;
  args: Record<string, unknown>;
  timestamp: string;
  durationMs: number;
  success: boolean;
  resultSnippet?: string;
  error?: string;
}

export interface PodCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface ContainerStatusInfo {
  name: string;
  ready: boolean;
  restartCount: number;
  state: string;
  reason?: string;
  message?: string;
}

export interface PodDiagnosticInfo {
  name: string;
  namespace: string;
  phase: string;
  conditions: PodCondition[];
  containerStatuses: ContainerStatusInfo[];
}

export interface DeploymentDiagnosticInfo {
  name: string;
  namespace: string;
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  conditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
}

export const ALLOWED_READ_ONLY_TOOLS = [
  "getPodStatus",
  "getPodLogs",
  "getEvents",
  "getDeploymentStatus",
] as const;

export type AllowedToolName = (typeof ALLOWED_READ_ONLY_TOOLS)[number];

/**
 * AgentGateway serves as the strictly read-only proxy in front of the AI agent's cluster tools.
 * It strictly forbids any mutating, creating, or deleting actions and records an audit trace
 * of every tool invocation.
 */
export class AgentGateway {
  private readonly kubeContext: string;
  private readonly traces: ToolExecutionTrace[] = [];

  constructor(kubeContext: string = "kind-aegis") {
    this.kubeContext = kubeContext;
  }

  /**
   * Returns all logged traces recorded during this gateway session.
   */
  public getTraces(): ToolExecutionTrace[] {
    return [...this.traces];
  }

  /**
   * Generic tool invoker enforcing the read-only boundary at runtime.
   */
  public async invokeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!ALLOWED_READ_ONLY_TOOLS.includes(toolName as AllowedToolName)) {
      const securityError = new AgentGatewaySecurityError(
        `AgentGateway Security Violation: Tool '${toolName}' is forbidden. Only read-only tools (${ALLOWED_READ_ONLY_TOOLS.join(
          ", "
        )}) are allowed.`
      );

      this.traces.push({
        tool: toolName,
        args,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        success: false,
        error: securityError.message,
      });

      throw securityError;
    }

    switch (toolName) {
      case "getPodStatus":
        return await this.getPodStatus(
          args.namespace as string,
          args.appName as string
        );
      case "getPodLogs":
        return await this.getPodLogs(args as {
          namespace: string;
          podName?: string;
          appName?: string;
          tailLines?: number;
        });
      case "getEvents":
        return await this.getEvents(
          args.namespace as string,
          args.appName as string | undefined
        );
      case "getDeploymentStatus":
        return await this.getDeploymentStatus(
          args.namespace as string,
          args.appName as string
        );
      default:
        throw new AgentGatewaySecurityError(`Unhandled tool: ${toolName}`);
    }
  }

  /**
   * Read-only tool: inspect pod phases, readiness, container waiting reasons and exit codes.
   */
  public async getPodStatus(
    namespace: string,
    appName: string
  ): Promise<PodDiagnosticInfo[]> {
    const startTime = Date.now();
    const args = { namespace, appName };

    try {
      this.sanitizeIdentifier(namespace, "namespace");
      this.sanitizeIdentifier(appName, "appName");

      const cmd = `kubectl get pods -n ${namespace} -l app=${appName} -o json --context ${this.kubeContext}`;
      const { stdout } = await execAsync(cmd);
      const parsed = JSON.parse(stdout || "{}");

      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const diagnosticInfos: PodDiagnosticInfo[] = items.map((pod: any) => {
        const name = pod.metadata?.name || "unknown";
        const phase = pod.status?.phase || "Unknown";
        const conditions: PodCondition[] = (pod.status?.conditions || []).map(
          (c: any) => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
            message: c.message,
          })
        );

        const containerStatuses: ContainerStatusInfo[] = (
          pod.status?.containerStatuses || []
        ).map((cs: any) => {
          let state = "unknown";
          let reason: string | undefined;
          let message: string | undefined;

          if (cs.state?.waiting) {
            state = "waiting";
            reason = cs.state.waiting.reason;
            message = cs.state.waiting.message;
          } else if (cs.state?.running) {
            state = "running";
          } else if (cs.state?.terminated) {
            state = "terminated";
            reason = cs.state.terminated.reason;
            message = cs.state.terminated.message;
          }

          return {
            name: cs.name,
            ready: cs.ready || false,
            restartCount: cs.restartCount || 0,
            state,
            reason,
            message,
          };
        });

        return {
          name,
          namespace,
          phase,
          conditions,
          containerStatuses,
        };
      });

      this.recordTrace("getPodStatus", args, startTime, true, JSON.stringify(diagnosticInfos));
      return diagnosticInfos;
    } catch (error: any) {
      this.recordTrace("getPodStatus", args, startTime, false, undefined, error.message);
      return [];
    }
  }

  /**
   * Read-only tool: get container logs from pods in a given namespace.
   */
  public async getPodLogs(options: {
    namespace: string;
    podName?: string;
    appName?: string;
    tailLines?: number;
  }): Promise<string> {
    const startTime = Date.now();
    const { namespace, podName, appName, tailLines = 50 } = options;
    const args = { namespace, podName, appName, tailLines };

    try {
      this.sanitizeIdentifier(namespace, "namespace");

      let targetPod = podName;
      if (!targetPod && appName) {
        this.sanitizeIdentifier(appName, "appName");
        const pods = await this.getPodStatus(namespace, appName);
        if (pods.length > 0) {
          targetPod = pods[0].name;
        }
      }

      if (!targetPod) {
        const noPodMsg = `No target pod found in namespace ${namespace}`;
        this.recordTrace("getPodLogs", args, startTime, true, noPodMsg);
        return noPodMsg;
      }

      this.sanitizeIdentifier(targetPod, "podName");

      const cmd = `kubectl logs ${targetPod} -n ${namespace} --tail=${tailLines} --context ${this.kubeContext}`;
      const { stdout, stderr } = await execAsync(cmd);
      const output = (stdout || stderr || "No logs emitted.").trim();

      this.recordTrace("getPodLogs", args, startTime, true, output.slice(0, 300));
      return output;
    } catch (error: any) {
      const errMsg = `Failed to fetch logs: ${error.message}`;
      this.recordTrace("getPodLogs", args, startTime, false, undefined, errMsg);
      return errMsg;
    }
  }

  /**
   * Read-only tool: get recent Kubernetes events in the namespace.
   */
  public async getEvents(
    namespace: string,
    appName?: string
  ): Promise<string[]> {
    const startTime = Date.now();
    const args = { namespace, appName };

    try {
      this.sanitizeIdentifier(namespace, "namespace");

      const cmd = `kubectl get events -n ${namespace} --sort-by=.metadata.creationTimestamp -o json --context ${this.kubeContext}`;
      const { stdout } = await execAsync(cmd);
      const parsed = JSON.parse(stdout || "{}");
      const items = Array.isArray(parsed.items) ? parsed.items : [];

      const formattedEvents: string[] = items.map((e: any) => {
        const type = e.type || "Normal";
        const reason = e.reason || "Unknown";
        const message = e.message || "";
        const involvedObject = `${e.involvedObject?.kind || ""}/${e.involvedObject?.name || ""}`;
        return `[${type}] ${involvedObject} - ${reason}: ${message}`;
      });

      this.recordTrace(
        "getEvents",
        args,
        startTime,
        true,
        `Retrieved ${formattedEvents.length} events`
      );
      return formattedEvents;
    } catch (error: any) {
      this.recordTrace("getEvents", args, startTime, false, undefined, error.message);
      return [];
    }
  }

  /**
   * Read-only tool: get deployment object status.
   */
  public async getDeploymentStatus(
    namespace: string,
    appName: string
  ): Promise<DeploymentDiagnosticInfo | null> {
    const startTime = Date.now();
    const args = { namespace, appName };

    try {
      this.sanitizeIdentifier(namespace, "namespace");
      this.sanitizeIdentifier(appName, "appName");

      const cmd = `kubectl get deployment ${appName} -n ${namespace} -o json --context ${this.kubeContext}`;
      const { stdout } = await execAsync(cmd);
      const d = JSON.parse(stdout || "{}");

      const info: DeploymentDiagnosticInfo = {
        name: appName,
        namespace,
        replicas: d.status?.replicas || 0,
        readyReplicas: d.status?.readyReplicas || 0,
        availableReplicas: d.status?.availableReplicas || 0,
        conditions: (d.status?.conditions || []).map((c: any) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
      };

      this.recordTrace("getDeploymentStatus", args, startTime, true, JSON.stringify(info));
      return info;
    } catch (error: any) {
      this.recordTrace("getDeploymentStatus", args, startTime, false, undefined, error.message);
      return null;
    }
  }

  private sanitizeIdentifier(value: string, fieldName: string) {
    if (!value || typeof value !== "string" || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) {
      throw new Error(`Invalid RFC 1123 identifier for ${fieldName}: '${value}'`);
    }
  }

  private recordTrace(
    tool: string,
    args: Record<string, unknown>,
    startTime: number,
    success: boolean,
    resultSnippet?: string,
    error?: string
  ) {
    this.traces.push({
      tool,
      args,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      success,
      resultSnippet: resultSnippet ? resultSnippet.slice(0, 200) : undefined,
      error,
    });
  }
}
