import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { JobStatus } from "@aegis/shared";
import { prisma } from "./db";
import {
  createJob,
  IllegalStateTransitionError,
  JobNotFoundError,
} from "./stateMachine";
import {
  CreateDeploymentRequestSchema,
  CreateDeploymentResponse,
  JobResponse,
} from "./schemas";
import { enqueueProvisioningJob } from "./queue";

export const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(express.json());

/**
 * Health check endpoint
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

/**
 * POST /deployments
 * Validates deployment request, creates Job row (INITIATED), writes initial AuditLog row,
 * enqueues job onto BullMQ for real Terraform provisioning, and returns 202 Accepted immediately.
 */
app.post("/deployments", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = CreateDeploymentRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const deploymentData = parseResult.data;

    // Create Job and initial AuditLog entry via state machine module
    const job = await createJob(prisma, {
      type: "deployment",
      payload: deploymentData,
      status: JobStatus.INITIATED,
      metadata: {
        source: "POST /deployments",
        appName: deploymentData.appName,
      },
    });

    // Enqueue onto BullMQ for asynchronous background Terraform provisioning
    await enqueueProvisioningJob(job.id, deploymentData);

    const response: CreateDeploymentResponse = {
      jobId: job.id,
      status: job.status as JobStatus,
      message: "Deployment job accepted",
    };

    return res.status(202).json(response);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /jobs/:id
 * Fetches Job details including status, payload, timestamps, and audit history.
 */
app.get("/jobs/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        auditLogs: {
          orderBy: { timestamp: "asc" },
        },
      },
    });

    if (!job) {
      return res.status(404).json({
        error: `Job with id ${id} not found`,
      });
    }

    const response: JobResponse = {
      id: job.id,
      type: job.type,
      status: job.status as JobStatus,
      payload: job.payload,
      proposal: job.proposal ?? undefined,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      auditLogs: job.auditLogs.map((log) => ({
        id: log.id,
        jobId: log.jobId,
        fromStatus: log.fromStatus,
        toStatus: log.toStatus,
        timestamp: log.timestamp,
        metadata: log.metadata,
      })),
    };

    return res.status(200).json(response);
  } catch (error) {
    return next(error);
  }
});

/**
 * Global Error Handler
 */
app.use(
  (
    err: unknown,
    _req: Request,
    res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: NextFunction
  ) => {
    if (err instanceof IllegalStateTransitionError) {
      return res.status(409).json({
        error: "Illegal state transition",
        message: err.message,
        fromStatus: err.fromStatus,
        toStatus: err.toStatus,
        jobId: err.jobId,
      });
    }

    if (err instanceof JobNotFoundError) {
      return res.status(404).json({
        error: "Not found",
        message: err.message,
      });
    }

    console.error("Unhandled error:", err);
    return res.status(500).json({
      error: "Internal server error",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
);
