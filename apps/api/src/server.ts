import dotenv from "dotenv";
import path from "path";

// Load environment variables (.env from apps/api or repo root)
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { app } from "./app";
import { initProvisioningWorker } from "./workers/provisioning.worker";
import { initDiagnosticWorker } from "./workers/diagnostic.worker";
import { provisioningQueue, diagnosticQueue, redisConnection } from "./queue";

const PORT = process.env.PORT || 3000;

// Start the BullMQ background workers
const provisioningWorker = initProvisioningWorker();
const diagnosticWorker = initDiagnosticWorker();

const server = app.listen(PORT, () => {
  console.log(`[Aegis API] Server listening on port ${PORT}`);
  console.log(`[Aegis API] Health check: http://localhost:${PORT}/health`);
  console.log(`[Aegis API] Deployments: POST http://localhost:${PORT}/deployments`);
  console.log(`[Aegis API] Jobs: GET http://localhost:${PORT}/jobs/:id`);
  console.log(`[Aegis API] Provisioning worker active and listening on queue.`);
  console.log(`[Aegis API] Diagnostic worker active and listening on queue.`);
});

async function shutdown(signal: string) {
  console.log(`[Aegis API] ${signal} received, shutting down gracefully...`);
  server.close(async () => {
    try {
      await provisioningWorker.close();
      await diagnosticWorker.close();
      await provisioningQueue.close();
      await diagnosticQueue.close();
      await redisConnection.quit();
      console.log("[Aegis API] Server and background workers closed.");
      process.exit(0);
    } catch (err) {
      console.error("[Aegis API] Error during shutdown:", err);
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
