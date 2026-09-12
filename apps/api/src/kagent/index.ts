import {
  AgentGateway,
  PodDiagnosticInfo,
  DeploymentDiagnosticInfo,
} from "../agentgateway";
import { nimCircuitBreaker, CircuitBreaker } from "../circuitBreaker";
import { DiagnosticProposal } from "../schemas";

export interface DiagnosisContext {
  appName: string;
  namespace: string;
  podStatuses: PodDiagnosticInfo[];
  events: string[];
  podLogs: string;
  deploymentStatus?: DeploymentDiagnosticInfo | null;
  failureDetails?: string;
}

export interface KAgentOptions {
  apiKey?: string;
  model?: string;
  circuitBreaker?: CircuitBreaker;
  apiBaseUrl?: string;
}

/**
 * kagent is the AI diagnostic agent powered by NVIDIA Nemotron 3.5 Lightning.
 * It analyzes failure data retrieved exclusively through read-only tools and
 * returns a structured JSON remediation proposal.
 */
export class KAgent {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly apiBaseUrl: string;

  constructor(options: KAgentOptions = {}) {
    this.apiKey =
      options.apiKey ||
      process.env.NVIDIA_NIM_API_KEY ||
      "";
    this.model =
      options.model ||
      process.env.NVIDIA_NIM_MODEL ||
      "nvidia/nemotron-3.5-lightning-30b-a3b";
    this.circuitBreaker = options.circuitBreaker ?? nimCircuitBreaker;
    this.apiBaseUrl =
      options.apiBaseUrl || "https://integrate.api.nvidia.com/v1";
  }

  /**
   * Orchestrates read-only diagnostic gathering through the AgentGateway and
   * prompts Nemotron 3.5 Lightning to formulate a structured remediation proposal.
   */
  public async diagnoseFailure(
    gateway: AgentGateway,
    appName: string,
    namespace: string,
    failureDetails?: string
  ): Promise<{ proposal: DiagnosticProposal; rawResponse: string }> {
    // 1. Gather read-only data strictly through the gateway
    console.log(`[kagent] Inspecting cluster for app '${appName}' in namespace '${namespace}' via AgentGateway...`);
    const podStatuses = await gateway.getPodStatus(namespace, appName);
    const events = await gateway.getEvents(namespace, appName);
    const deploymentStatus = await gateway.getDeploymentStatus(namespace, appName);
    const podLogs = await gateway.getPodLogs({ namespace, appName, tailLines: 50 });

    const context: DiagnosisContext = {
      appName,
      namespace,
      podStatuses,
      events,
      podLogs,
      deploymentStatus,
      failureDetails,
    };

    // 2. Call NVIDIA NIM API with Circuit Breaker protection
    console.log(`[kagent] Calling NVIDIA Nemotron 3.5 Lightning for structured diagnosis...`);
    const responseText = await this.callNemotronWithCircuitBreaker(context);

    // 3. Parse and extract structured JSON proposal
    const proposal = this.parseProposalJson(responseText);

    return { proposal, rawResponse: responseText };
  }

  /**
   * Executes the chat completion request through the Circuit Breaker.
   */
  public async callNemotronWithCircuitBreaker(
    context: DiagnosisContext
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error("NVIDIA_NIM_API_KEY is not configured in environment.");
    }

    const systemPrompt = `You are Aegis AI Diagnostic Agent (kagent). Your responsibility is to diagnose Kubernetes deployment failures using the provided read-only cluster data (pod status, container wait reasons, pod logs, and Kubernetes events).

CRITICAL SAFETY & GOVERNANCE RULES:
1. You have ZERO write or execution privileges on the cluster. Do NOT produce bash commands, kubectl CLI commands, or shell scripts.
2. You MUST return ONLY a structured remediation proposal in valid JSON matching this exact schema:
{
  "actionType": "string",  // remediation action name (e.g. "update_image", "restart_pod", "rollback_deployment", "adjust_resources")
  "target": "string",      // target resource name (e.g. "deployment/my-app" or "my-app")
  "params": { ... },       // key-value dictionary of parameters required to fix the failure, e.g. {"image": "nginx:alpine"} or {"cpu": 0.5, "memory": 512}
  "reasoning": "string"    // concise root-cause diagnosis explaining what failed and why this remediation will resolve it
}
3. Your output MUST be ONLY the JSON object. Do NOT include any thinking process, analysis, explanation, preamble, markdown code fences, or trailing text. Start your response directly with the opening brace { and end with the closing brace }.`;

    const userPrompt = `A deployment failure occurred on Kubernetes for application '${context.appName}' in namespace '${context.namespace}'.

DIAGNOSTIC EVIDENCE:
- Failure details: ${context.failureDetails || "Deployment failed health/readiness checks"}
- Pod Statuses:
${JSON.stringify(context.podStatuses, null, 2)}
- Recent Events:
${context.events.length > 0 ? context.events.join("\n") : "No recent events recorded."}
- Container Logs:
${context.podLogs || "No logs available."}
- Deployment Status:
${JSON.stringify(context.deploymentStatus, null, 2)}

Analyze the evidence, determine the exact root cause (such as ImagePullBackOff, ErrImagePull, CrashLoopBackOff, resource limits, or misconfiguration), and output the structured JSON remediation proposal.`;

    return await this.circuitBreaker.execute(async () => {
      const response = await fetch(`${this.apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 2000,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `NVIDIA NIM API error (${response.status} ${response.statusText}): ${errorText}`
        );
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content || typeof content !== "string") {
        throw new Error("NVIDIA NIM API returned empty or invalid content.");
      }

      return content.trim();
    });
  }

  /**
   * Robustly extracts and parses the JSON proposal from the model's text response.
   * Handles verbose model output by trying the whole text first, then each
   * candidate JSON object block found in the text.
   */
  public parseProposalJson(rawText: string): DiagnosticProposal {
    let cleanText = rawText.trim();

    // Strip markdown code fences if model enclosed JSON in ```json ... ```
    if (cleanText.includes("```")) {
      const match = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) {
        cleanText = match[1].trim();
      }
    }

    // Strategy 1: Try parsing the entire text as JSON
    try {
      const parsed = JSON.parse(cleanText);
      return parsed;
    } catch {
      // Fall through to strategy 2
    }

    // Strategy 2: Scan for candidate JSON objects ({...}) and try each one.
    // This handles models that wrap the JSON in conversational prose or
    // "thinking" text. We iterate through every '{' position and try to
    // parse a balanced JSON object starting there.
    for (let i = 0; i < cleanText.length; i++) {
      if (cleanText[i] !== "{") continue;

      // Try to find a balanced closing brace for this opening brace
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let j = i; j < cleanText.length; j++) {
        const ch = cleanText[j];

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === "\\") {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            // Found a balanced JSON object candidate
            const candidate = cleanText.slice(i, j + 1);
            try {
              const parsed = JSON.parse(candidate);
              // Verify it looks like a diagnostic proposal
              if (
                parsed &&
                typeof parsed === "object" &&
                typeof parsed.actionType === "string" &&
                typeof parsed.target === "string" &&
                typeof parsed.reasoning === "string" &&
                parsed.params &&
                typeof parsed.params === "object"
              ) {
                return parsed;
              }
            } catch {
              // Not valid JSON, continue scanning
            }
            break; // Move to next opening brace
          }
        }
      }
    }

    throw new Error(
      `Failed to extract valid JSON proposal from model response: "${rawText.slice(0, 200)}..."`
    );
  }
}
