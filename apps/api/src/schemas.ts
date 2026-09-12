import { z } from "zod";
import { JobStatus } from "@aegis/shared";

/**
 * Request schema for POST /deployments
 */
export const CreateDeploymentRequestSchema = z.object({
  appName: z
    .string({
      required_error: "appName is required",
      invalid_type_error: "appName must be a string",
    })
    .trim()
    .min(1, "appName cannot be empty")
    .max(63, "appName must be at most 63 characters")
    .regex(
      /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
      "appName must be a valid RFC 1123 label: lowercase alphanumeric characters and hyphens only, starting and ending with an alphanumeric character (max 63 chars)"
    ),
  image: z
    .string({
      required_error: "image is required",
      invalid_type_error: "image must be a string",
    })
    .trim()
    .min(1, "image cannot be empty"),
  cpu: z
    .number({
      required_error: "cpu limit is required",
      invalid_type_error: "cpu must be a number",
    })
    .positive("cpu must be greater than 0"),
  memory: z
    .number({
      required_error: "memory limit is required",
      invalid_type_error: "memory must be a number",
    })
    .positive("memory must be greater than 0"),
  replicas: z
    .number({
      invalid_type_error: "replicas must be a number",
    })
    .int("replicas must be an integer")
    .positive("replicas must be at least 1")
    .optional()
    .default(1),
  env: z.record(z.string(), z.string()).optional(),
  simulateFailure: z
    .enum(["bad_image", "crashloop", "resource_quota"])
    .optional(),
});

export type CreateDeploymentRequest = z.infer<typeof CreateDeploymentRequestSchema>;

/**
 * Structured diagnostic proposal produced by kagent and validated before acceptance
 */
export const DiagnosticProposalSchema = z.object({
  actionType: z.string().min(1, "actionType cannot be empty"),
  target: z.string().min(1, "target cannot be empty"),
  params: z.record(z.string(), z.unknown()),
  reasoning: z.string().min(1, "reasoning cannot be empty"),
});

export type DiagnosticProposal = z.infer<typeof DiagnosticProposalSchema>;

/**
 * Response schema for POST /deployments
 */
export const CreateDeploymentResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: z.nativeEnum(JobStatus),
  message: z.string(),
});

export type CreateDeploymentResponse = z.infer<typeof CreateDeploymentResponseSchema>;

/**
 * Audit log entry schema
 */
export const AuditLogResponseSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  fromStatus: z.string().nullable(),
  toStatus: z.string(),
  timestamp: z.union([z.string(), z.date()]),
  metadata: z.unknown().optional(),
});

/**
 * Response schema for GET /jobs/:id
 */
export const JobResponseSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  status: z.nativeEnum(JobStatus),
  payload: z.unknown(),
  proposal: z.unknown().optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
  auditLogs: z.array(AuditLogResponseSchema).optional(),
});

export type JobResponse = z.infer<typeof JobResponseSchema>;
