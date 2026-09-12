import { prisma } from "./db";

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: npx tsx src/check-audit.ts <jobId>");
    process.exit(1);
  }
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { auditLogs: { orderBy: { timestamp: "desc" } } },
  });
  console.log(JSON.stringify(job?.auditLogs, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());