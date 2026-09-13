"use client";

import React, { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { JobStatus, isTerminalState } from "@aegis/shared";
import {
  IconCheck,
  IconClock,
  IconAlertCircle,
  IconArrowLeft,
  IconRefresh,
  IconActivity,
  IconX,
  IconShieldCheck,
  IconShieldX,
  IconCpu,
  IconArrowRight,
  IconChecklist,
} from "@tabler/icons-react";

interface AuditLogEntry {
  id: string;
  jobId: string;
  fromStatus: string | null;
  toStatus: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface JobData {
  id: string;
  type: string;
  status: JobStatus;
  payload: {
    appName: string;
    image: string;
    cpu: number;
    memory: number;
    replicas: number;
  };
  proposal?: {
    actionType: string;
    target: string;
    params: Record<string, unknown>;
    reasoning: string;
  };
  createdAt: string;
  updatedAt: string;
  auditLogs: AuditLogEntry[];
}

export default function JobStatusPage() {
  const params = useParams();
  const id = params?.id as string;

  const [job, setJob] = useState<JobData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Approval / rejection action states
  const [isActionSubmitting, setIsActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchJob = async (showLoading = false) => {
    if (showLoading) setIsLoading(true);
    try {
      const res = await fetch(`${API_URL}/jobs/${id}`, {
        headers: { Accept: "application/json" },
      });

      if (res.status === 404) {
        setNotFound(true);
        setJob(null);
        return;
      }

      if (!res.ok) {
        throw new Error(`API returned status ${res.status}`);
      }

      const data: JobData = await res.json();
      setJob(data);
      setNotFound(false);
      setError(null);

      // Stop polling once a terminal state is reached
      if (isTerminalState(data.status)) {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }
    } catch (err: unknown) {
      console.error("Polling error:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch job status");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;

    fetchJob(true);

    timerRef.current = setInterval(() => {
      fetchJob(false);
    }, 1500);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [id]);

  // Handle human approval click
  const handleApprove = async () => {
    setIsActionSubmitting(true);
    setActionError(null);
    try {
      const res = await fetch(`${API_URL}/jobs/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approver: "dashboard_operator" }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `Approval failed with status ${res.status}`);
      }

      await fetchJob(false);
    } catch (err: any) {
      setActionError(err.message || "Failed to approve proposal");
    } finally {
      setIsActionSubmitting(false);
    }
  };

  // Handle human rejection click
  const handleReject = async () => {
    setIsActionSubmitting(true);
    setActionError(null);
    try {
      const res = await fetch(`${API_URL}/jobs/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rejecter: "dashboard_operator",
          reason: "Rejected by operator via dashboard",
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `Rejection failed with status ${res.status}`);
      }

      await fetchJob(false);
    } catch (err: any) {
      setActionError(err.message || "Failed to reject proposal");
    } finally {
      setIsActionSubmitting(false);
    }
  };

  // Handle 404 Not Found gracefully
  if (notFound) {
    return (
      <div className="max-w-md mx-auto py-16 text-center space-y-4">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-lg bg-[#FEF3C7] border border-[#FCD34D] text-[#D97706]">
          <IconAlertCircle size={24} stroke={2} />
        </div>
        <h1 className="text-xl font-bold text-[#1A1816]">Job not found</h1>
        <p className="text-sm text-[#6B665E]">
          No deployment record found matching UUID <span className="font-mono text-[#1A1816] text-xs px-1.5 py-0.5 rounded bg-[#EFECE4] border border-[#E2DDD4] font-bold">{id}</span>.
        </p>
        <div className="pt-2">
          <Link
            href="/"
            className="inline-flex items-center space-x-2 px-4 py-2 rounded-md bg-[#1A1816] hover:bg-[#2C2825] text-sm font-bold text-white transition-colors shadow-sm"
          >
            <IconArrowLeft size={16} />
            <span>Return to deployments</span>
          </Link>
        </div>
      </div>
    );
  }

  // Initial loading state
  if (isLoading && !job) {
    return (
      <div className="max-w-3xl mx-auto py-20 flex flex-col items-center justify-center space-y-3">
        <svg className="animate-spin h-7 w-7 text-[#FF4F00]" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span className="text-sm font-mono text-[#6B665E]">Loading deployment status...</span>
      </div>
    );
  }

  const currentStatus = job?.status;
  const isComplete = currentStatus && isTerminalState(currentStatus);

  // Determine whether the job took the failure/diagnosis/governance pipeline path
  const hasDiagnosisOrProposal =
    job?.proposal !== undefined ||
    currentStatus === JobStatus.DIAGNOSING ||
    currentStatus === JobStatus.PROPOSAL_GENERATED ||
    currentStatus === JobStatus.PENDING_APPROVAL ||
    currentStatus === JobStatus.APPROVED ||
    currentStatus === JobStatus.APPLYING ||
    currentStatus === JobStatus.POLICY_VIOLATED ||
    currentStatus === JobStatus.REJECTED ||
    (job?.auditLogs &&
      job.auditLogs.some((l) =>
        [
          JobStatus.DIAGNOSING,
          JobStatus.PROPOSAL_GENERATED,
          JobStatus.PENDING_APPROVAL,
          JobStatus.APPROVED,
          JobStatus.APPLYING,
          JobStatus.POLICY_VIOLATED,
          JobStatus.REJECTED,
        ].includes(l.toStatus as JobStatus)
      ));

  // Build responsive stepper depending on standard provisioning vs governed remediation flow
  const STEPS: {
    key: string;
    label: string;
    desc: string;
    matchStatuses: JobStatus[];
  }[] = hasDiagnosisOrProposal
    ? [
        {
          key: "provisioning",
          label: "1. Provisioning",
          desc: "Terraform apply & health check",
          matchStatuses: [JobStatus.INITIATED, JobStatus.PROVISIONING],
        },
        {
          key: "diagnosis",
          label: "2. AI Diagnosis",
          desc: "agentgateway inspection & Nemotron reasoning",
          matchStatuses: [JobStatus.DIAGNOSING, JobStatus.PROPOSAL_GENERATED],
        },
        {
          key: "approval",
          label: "3. Human Gate",
          desc:
            currentStatus === JobStatus.REJECTED
              ? "Remediation rejected by human operator"
              : currentStatus === JobStatus.PENDING_APPROVAL
              ? "Awaiting human operator approval"
              : "Remediation proposal approved",
          matchStatuses: [
            JobStatus.PENDING_APPROVAL,
            JobStatus.APPROVED,
            JobStatus.REJECTED,
          ],
        },
        {
          key: "execution",
          label:
            currentStatus === JobStatus.POLICY_VIOLATED
              ? "4. Policy Violated"
              : currentStatus === JobStatus.FAILED
              ? "4. Remediation Failed"
              : "4. Policy & Apply",
          desc:
            currentStatus === JobStatus.POLICY_VIOLATED
              ? "Blocked by Kyverno admission webhook"
              : currentStatus === JobStatus.EXECUTED
              ? "Kyverno passed & Executor patched cluster"
              : currentStatus === JobStatus.APPLYING
              ? "Kyverno check & Executor run in progress"
              : "Kyverno dry-run check and Executor action",
          matchStatuses: [
            JobStatus.APPLYING,
            JobStatus.EXECUTED,
            JobStatus.POLICY_VIOLATED,
            JobStatus.FAILED,
          ],
        },
      ]
    : [
        {
          key: "initiated",
          label: "Initiated",
          desc: "Job accepted and queued",
          matchStatuses: [JobStatus.INITIATED],
        },
        {
          key: "provisioning",
          label: "Provisioning",
          desc: "Terraform apply in progress",
          matchStatuses: [JobStatus.PROVISIONING],
        },
        {
          key: "executed",
          label: currentStatus === JobStatus.FAILED ? "Failed" : "Executed",
          desc:
            currentStatus === JobStatus.FAILED
              ? "Workload deployment failed"
              : "Workload active in cluster",
          matchStatuses: [JobStatus.EXECUTED, JobStatus.FAILED],
        },
      ];

  const getStepState = (matchStatuses: JobStatus[]) => {
    if (!job) return "pending";
    const isCurrentlyActive = matchStatuses.includes(job.status);
    const hasBeenVisited = job.auditLogs.some((l) =>
      matchStatuses.includes(l.toStatus as JobStatus)
    );

    if (isCurrentlyActive) return "active";
    if (hasBeenVisited) return "completed";
    return "pending";
  };

  const getStepTimestamp = (matchStatuses: JobStatus[]) => {
    if (!job) return null;
    const log = job.auditLogs
      .slice()
      .reverse()
      .find((l) => matchStatuses.includes(l.toStatus as JobStatus));
    return log ? new Date(log.timestamp).toLocaleTimeString() : null;
  };

  // High-contrast physical stamp badges for functional state readability
  const renderStatusBadge = (status?: JobStatus) => {
    switch (status) {
      case JobStatus.EXECUTED:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#DCFCE7] text-[#166534] border border-[#86EFAC]">
            <IconCheck size={13} stroke={3} />
            <span>EXECUTED</span>
          </span>
        );
      case JobStatus.APPROVED:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#E0E7FF] text-[#3730A3] border border-[#C7D2FE]">
            <IconCheck size={13} stroke={3} />
            <span>APPROVED</span>
          </span>
        );
      case JobStatus.APPLYING:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#EDE9FE] text-[#5B21B6] border border-[#DDD6FE]">
            <IconActivity size={13} className="animate-spin" />
            <span>APPLYING</span>
          </span>
        );
      case JobStatus.PENDING_APPROVAL:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#FEF3C7] text-[#92400E] border border-[#FCD34D] animate-pulse">
            <IconClock size={13} stroke={2.5} />
            <span>PENDING APPROVAL</span>
          </span>
        );
      case JobStatus.POLICY_VIOLATED:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#FEF3C7] text-[#B45309] border border-[#F59E0B]">
            <IconShieldX size={13} stroke={2.5} />
            <span>POLICY VIOLATED</span>
          </span>
        );
      case JobStatus.REJECTED:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#FEE2E2] text-[#991B1B] border border-[#FCA5A5]">
            <IconX size={13} stroke={2.5} />
            <span>REJECTED</span>
          </span>
        );
      case JobStatus.FAILED:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#FEE2E2] text-[#991B1B] border border-[#FCA5A5]">
            <IconAlertCircle size={13} stroke={2.5} />
            <span>FAILED</span>
          </span>
        );
      case JobStatus.DIAGNOSING:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#F3E8FF] text-[#6B21A8] border border-[#D8B4FE]">
            <IconCpu size={13} className="animate-pulse" />
            <span>DIAGNOSING</span>
          </span>
        );
      case JobStatus.PROVISIONING:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#DBEAFE] text-[#1E40AF] border border-[#93C5FD]">
            <IconActivity size={13} className="animate-spin" />
            <span>PROVISIONING</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#EFECE4] text-[#1A1816] border border-[#E2DDD4]">
            <IconClock size={13} />
            <span>{status || "UNKNOWN"}</span>
          </span>
        );
    }
  };

  // High-contrast audit badge helper
  const getAuditStatusColor = (statusName: string) => {
    switch (statusName) {
      case "EXECUTED":
        return "bg-[#DCFCE7] text-[#166534] border-[#86EFAC]";
      case "APPROVED":
        return "bg-[#E0E7FF] text-[#3730A3] border-[#C7D2FE]";
      case "APPLYING":
        return "bg-[#EDE9FE] text-[#5B21B6] border-[#DDD6FE]";
      case "PENDING_APPROVAL":
        return "bg-[#FEF3C7] text-[#92400E] border-[#FCD34D]";
      case "POLICY_VIOLATED":
        return "bg-[#FEF3C7] text-[#B45309] border-[#F59E0B]";
      case "REJECTED":
      case "FAILED":
        return "bg-[#FEE2E2] text-[#991B1B] border-[#FCA5A5]";
      case "PROVISIONING":
        return "bg-[#DBEAFE] text-[#1E40AF] border-[#93C5FD]";
      case "DIAGNOSING":
      case "PROPOSAL_GENERATED":
        return "bg-[#F3E8FF] text-[#6B21A8] border-[#D8B4FE]";
      default:
        return "bg-[#E2DDD4] text-[#1A1816] border-[#D4CDC2]";
    }
  };

  // Extract policy violation details if available in audit log
  const policyViolationLog = job?.auditLogs.find(
    (l) => l.toStatus === JobStatus.POLICY_VIOLATED
  );
  const policyReason =
    (policyViolationLog?.metadata?.reason as string) ||
    (policyViolationLog?.metadata?.error as string) ||
    "Action was rejected by Kyverno validating admission policy.";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Top navigation & Polling indicator */}
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center space-x-1.5 text-xs text-[#6B665E] hover:text-[#1A1816] transition-colors font-medium"
        >
          <IconArrowLeft size={14} />
          <span>Back to deployments</span>
        </Link>

        {/* Polling telemetry indicator */}
        <div className="flex items-center space-x-2 text-xs font-mono">
          {!isComplete ? (
            <span className="inline-flex items-center space-x-2 px-2.5 py-1 rounded-md bg-[#EFECE4] text-[#1A1816] border border-[#E2DDD4]">
              <span className="inline-flex rounded-full h-2 w-2 bg-[#1A4FD8] animate-pulse"></span>
              <span>Live polling</span>
            </span>
          ) : (
            <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-[#DCFCE7] text-[#166534] border border-[#86EFAC]">
              <IconCheck size={13} stroke={2.5} />
              <span>Completed</span>
            </span>
          )}
          <button
            onClick={() => fetchJob(false)}
            title="Manual refresh"
            className="p-1 rounded-md bg-[#EFECE4] hover:bg-[#E7E3DA] border border-[#E2DDD4] text-[#6B665E] hover:text-[#1A1816] transition-colors"
          >
            <IconRefresh size={13} />
          </button>
        </div>
      </div>

      {/* Main Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-[#E2DDD4]">
        <div>
          <div className="flex items-center space-x-3">
            <h1 className="text-2xl font-bold text-[#1A1816] tracking-tight">
              {job?.payload?.appName}
            </h1>
            {renderStatusBadge(currentStatus)}
          </div>
          <p className="text-xs font-mono text-[#6B665E] mt-1">
            Job ID: <span className="text-[#1A1816] font-bold">{job?.id}</span>
          </p>
        </div>

        {/* Metadata summary */}
        <div className="flex items-center space-x-4 text-xs font-mono bg-[#EFECE4] border border-[#E2DDD4] rounded-md px-4 py-2.5">
          <div>
            <span className="text-[#6B665E] block text-[10px]">Replicas</span>
            <span className="text-[#1A1816] font-bold">{job?.payload?.replicas || 1}</span>
          </div>
          <div className="h-5 w-px bg-[#D4CDC2]"></div>
          <div>
            <span className="text-[#6B665E] block text-[10px]">CPU / Mem</span>
            <span className="text-[#1A1816] font-bold">{job?.payload?.cpu}c / {job?.payload?.memory}M</span>
          </div>
          <div className="h-5 w-px bg-[#D4CDC2]"></div>
          <div>
            <span className="text-[#6B665E] block text-[10px]">Namespace</span>
            <span className="text-[#1A1816] font-bold">{job?.payload?.appName}</span>
          </div>
        </div>
      </div>

      {/* State Machine Stepper */}
      <div className="py-2">
        <div className="text-xs font-bold uppercase tracking-wider text-[#6B665E] mb-4">
          Lifecycle Progression
        </div>

        <div className={`grid grid-cols-1 sm:grid-cols-${STEPS.length} gap-4`}>
          {STEPS.map((step, idx) => {
            const state = getStepState(step.matchStatuses);
            const time = getStepTimestamp(step.matchStatuses);

            const isStepFailure =
              currentStatus === JobStatus.FAILED || currentStatus === JobStatus.REJECTED;
            const isStepPolicyViolation = currentStatus === JobStatus.POLICY_VIOLATED;

            let cardClasses = "bg-[#F6F4EE] border-[#E2DDD4] text-[#6B665E]";
            let badgeClasses = "bg-[#E2DDD4] text-[#6B665E]";

            if (state === "active") {
              if (isStepFailure) {
                cardClasses = "bg-[#FEF2F2] border-[#DC2626] text-[#991B1B]";
                badgeClasses = "bg-[#DC2626] text-white";
              } else if (isStepPolicyViolation) {
                cardClasses = "bg-[#FFFBEB] border-[#D97706] text-[#92400E]";
                badgeClasses = "bg-[#D97706] text-white";
              } else {
                cardClasses = "bg-[#EFF6FF] border-[#2563EB] text-[#1E40AF]";
                badgeClasses = "bg-[#2563EB] text-white";
              }
            } else if (state === "completed") {
              if (isStepFailure && idx === STEPS.length - 1) {
                cardClasses = "bg-[#FEF2F2] border-[#FCA5A5] text-[#991B1B]";
                badgeClasses = "bg-[#DC2626] text-white";
              } else if (isStepPolicyViolation && idx === STEPS.length - 1) {
                cardClasses = "bg-[#FFFBEB] border-[#FCD34D] text-[#92400E]";
                badgeClasses = "bg-[#D97706] text-white";
              } else {
                cardClasses = "bg-[#F0FDF4] border-[#86EFAC] text-[#166534]";
                badgeClasses = "bg-[#1D7A46] text-white";
              }
            }

            return (
              <div
                key={step.key}
                className={`relative p-4 rounded-md border transition-all ${cardClasses}`}
              >
                {/* Step header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2.5">
                    <div
                      className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-mono font-bold ${badgeClasses}`}
                    >
                      {state === "completed" ? (
                        isStepFailure && idx === STEPS.length - 1 ? (
                          <IconX size={13} stroke={3} />
                        ) : (
                          <IconCheck size={13} stroke={3} />
                        )
                      ) : (
                        <span>{idx + 1}</span>
                      )}
                    </div>
                    <span className="font-bold text-sm text-[#1A1816]">
                      {step.label}
                    </span>
                  </div>

                  {state === "active" && (
                    <span className="inline-flex rounded-full h-2 w-2 bg-[#1A4FD8] animate-pulse"></span>
                  )}
                </div>

                <p className="text-xs text-[#6B665E] mb-3">{step.desc}</p>

                {/* Timestamp */}
                <div className="text-[11px] font-mono text-[#6B665E] flex items-center space-x-1 pt-2 border-t border-[#E2DDD4]">
                  <IconClock size={12} />
                  <span>{time ? `At ${time}` : "Pending"}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* HUMAN APPROVAL GATE PANEL (Phase 6 Core Feature) */}
      {job?.proposal && (
        <div className="p-6 rounded-lg bg-white border-2 border-[#E2DDD4] space-y-5 shadow-sm">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-[#E2DDD4]">
            <div className="flex items-center space-x-3">
              <div className="h-8 w-8 rounded-md bg-[#FFF7ED] border border-[#FFEDD5] text-[#C2410C] flex items-center justify-center font-bold">
                <IconChecklist size={20} />
              </div>
              <div>
                <h2 className="text-base font-bold text-[#1A1816]">
                  Governed Remediation Proposal
                </h2>
                <p className="text-xs text-[#6B665E]">
                  AI-generated diagnosis awaiting human review and independent Kyverno policy verification
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <span className="px-2.5 py-1 rounded bg-[#F3E8FF] text-[#6B21A8] border border-[#D8B4FE] text-xs font-mono font-bold">
                Nemotron 3.5 Lightning
              </span>
              <span className="px-2.5 py-1 rounded bg-[#EFECE4] text-[#1A1816] border border-[#E2DDD4] text-xs font-mono font-bold">
                {job.proposal.actionType}
              </span>
            </div>
          </div>

          {/* AI Diagnosis Reasoning */}
          <div className="bg-[#FFFBEB] p-4 rounded-md border border-[#FDE68A] space-y-1.5">
            <div className="flex items-center space-x-1.5 text-[#92400E] text-xs font-bold font-mono uppercase tracking-wider">
              <IconCpu size={14} />
              <span>Root Cause Diagnosis</span>
            </div>
            <p className="text-sm text-[#78350F] leading-relaxed">
              {job.proposal.reasoning}
            </p>
          </div>

          {/* Human-Readable Action Evaluation (Side-by-side comparison) */}
          <div className="space-y-3">
            <span className="text-xs font-bold uppercase tracking-wider text-[#6B665E] block">
              Proposed Cluster Mutation (Human-Readable Diff)
            </span>

            {job.proposal.actionType === "increase_resource_limit" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* CPU Comparison */}
                <div className="p-4 rounded-md bg-[#F6F4EE] border border-[#E2DDD4] space-y-2">
                  <div className="flex items-center justify-between text-xs text-[#6B665E] font-mono">
                    <span>CPU Limit</span>
                    <span className="text-[11px] text-[#1D7A46] font-bold">Policy Bound: ≤ 4 cores</span>
                  </div>
                  <div className="flex items-center space-x-3 text-lg font-mono font-bold">
                    <span className="text-[#6B665E]">{job.payload?.cpu || "--"} cores</span>
                    <IconArrowRight size={18} className="text-[#FF4F00]" />
                    <span className="text-[#1A1816] text-xl font-extrabold">
                      {String(job.proposal.params?.cpu || "--")} cores
                    </span>
                  </div>
                </div>

                {/* Memory Comparison */}
                <div className="p-4 rounded-md bg-[#F6F4EE] border border-[#E2DDD4] space-y-2">
                  <div className="flex items-center justify-between text-xs text-[#6B665E] font-mono">
                    <span>Memory Limit</span>
                    <span className="text-[11px] text-[#1D7A46] font-bold">Policy Bound: ≤ 8192 MiB</span>
                  </div>
                  <div className="flex items-center space-x-3 text-lg font-mono font-bold">
                    <span className="text-[#6B665E]">{job.payload?.memory || "--"} MiB</span>
                    <IconArrowRight size={18} className="text-[#FF4F00]" />
                    <span className="text-[#1A1816] text-xl font-extrabold">
                      {String(job.proposal.params?.memory || "--")} MiB
                    </span>
                  </div>
                </div>
              </div>
            )}

            {job.proposal.actionType === "scale_replicas" && (
              <div className="p-4 rounded-md bg-[#F6F4EE] border border-[#E2DDD4] space-y-2">
                <div className="flex items-center justify-between text-xs text-[#6B665E] font-mono">
                  <span>Replica Count for Deployment: {job.proposal.target}</span>
                  <span className="text-[11px] text-[#1D7A46] font-bold">Kyverno Bound: ≤ 10 replicas</span>
                </div>
                <div className="flex items-center space-x-3 text-lg font-mono font-bold">
                  <span className="text-[#6B665E]">{job.payload?.replicas || 1} replicas</span>
                  <IconArrowRight size={18} className="text-[#FF4F00]" />
                  <span className="text-[#1A1816] text-xl font-extrabold">
                    {String(job.proposal.params?.replicas || "--")} replicas
                  </span>
                </div>
              </div>
            )}

            {job.proposal.actionType === "rollback_deployment" && (
              <div className="p-4 rounded-md bg-[#F6F4EE] border border-[#E2DDD4] space-y-2">
                <div className="flex items-center justify-between text-xs text-[#6B665E] font-mono">
                  <span>Target Deployment</span>
                  <span className="text-[11px] text-[#1D7A46] font-bold">Preceding Revision Rollback</span>
                </div>
                <div className="text-sm font-mono font-bold text-[#1A1816]">
                  deployment/{job.proposal.target} in namespace {String(job.proposal.params?.namespace || "default")}
                </div>
                <p className="text-xs text-[#6B665E]">
                  Reverts deployment pod template to the immediately preceding revision. Arbitrary revision selection disabled for security.
                </p>
              </div>
            )}

            {job.proposal.actionType === "restart_pod" && (
              <div className="p-4 rounded-md bg-[#F6F4EE] border border-[#E2DDD4] space-y-2">
                <div className="flex items-center justify-between text-xs text-[#6B665E] font-mono">
                  <span>Target Pod Deletion</span>
                  <span className="text-[11px] text-[#1D7A46] font-bold">Protected Namespaces Enforced</span>
                </div>
                <div className="text-sm font-mono font-bold text-[#1A1816]">
                  pod/{job.proposal.target} in namespace {String(job.proposal.params?.namespace || "default")}
                </div>
                <p className="text-xs text-[#6B665E]">
                  Deletes pod to trigger immediate replica recreation by the Kubernetes Deployment controller.
                </p>
              </div>
            )}
          </div>

          {/* Action Feedback Alerts */}
          {actionError && (
            <div className="p-3 rounded-md bg-[#FEF2F2] border border-[#FCA5A5] text-xs font-mono text-[#991B1B] flex items-center space-x-2">
              <IconAlertCircle size={16} />
              <span>{actionError}</span>
            </div>
          )}

          {/* Status-specific Callouts */}
          {currentStatus === JobStatus.PENDING_APPROVAL && (
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-[#E2DDD4]">
              <div className="text-xs text-[#6B665E]">
                <span className="font-bold text-[#1A1816]">Safety Policy Notice:</span> Clicking Approve will trigger Kyverno admission verification before executing changes on the cluster.
              </div>
              <div className="flex items-center space-x-3 w-full sm:w-auto">
                <button
                  onClick={handleReject}
                  disabled={isActionSubmitting}
                  className="flex-1 sm:flex-none px-4 py-2 rounded-md bg-white hover:bg-[#FEE2E2] border border-[#FCA5A5] text-[#991B1B] font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                >
                  {isActionSubmitting ? "Processing..." : "Reject Remediation"}
                </button>
                <button
                  onClick={handleApprove}
                  disabled={isActionSubmitting}
                  className="flex-1 sm:flex-none px-5 py-2 rounded-md bg-[#1D7A46] hover:bg-[#166534] text-white font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                >
                  {isActionSubmitting ? "Approving..." : "Approve & Execute"}
                </button>
              </div>
            </div>
          )}

          {currentStatus === JobStatus.POLICY_VIOLATED && (
            <div className="p-4 rounded-md bg-[#FEF3C7] border border-[#F59E0B] text-xs font-mono space-y-1.5">
              <div className="flex items-center space-x-2 text-[#92400E] font-bold">
                <IconShieldX size={18} />
                <span>Admission Policy Vetoed by Kyverno</span>
              </div>
              <p className="text-xs text-[#78350F] leading-relaxed">
                {policyReason}
              </p>
              <div className="text-[11px] text-[#92400E] pt-1">
                Remediation stopped immediately. The cluster was not modified.
              </div>
            </div>
          )}

          {currentStatus === JobStatus.REJECTED && (
            <div className="p-4 rounded-md bg-[#FEE2E2] border border-[#FCA5A5] text-xs font-mono space-y-1">
              <div className="flex items-center space-x-2 text-[#991B1B] font-bold">
                <IconX size={18} />
                <span>Proposal Rejected by Operator</span>
              </div>
              <p className="text-xs text-[#7F1D1D]">
                The proposed remediation was rejected during human review. Job terminated with zero cluster modifications.
              </p>
            </div>
          )}

          {currentStatus === JobStatus.EXECUTED && (
            <div className="p-4 rounded-md bg-[#DCFCE7] border border-[#86EFAC] text-xs font-mono space-y-1">
              <div className="flex items-center space-x-2 text-[#166534] font-bold">
                <IconShieldCheck size={18} />
                <span>Remediation Successfully Executed</span>
              </div>
              <p className="text-xs text-[#14532D]">
                Independent Kyverno admission policy passed. Cluster state updated by Aegis Executor.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Specifications & Audit Log Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-2">
        {/* Workload Specifications */}
        <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-[#6B665E]">
            Workload Specifications
          </div>

          <div className="space-y-2 text-xs font-mono">
            <div className="p-3 rounded-md bg-[#EFECE4] border border-[#E2DDD4] flex justify-between items-center">
              <span className="text-[#6B665E]">Image</span>
              <span className="text-[#1A1816] font-bold truncate max-w-[160px]" title={job?.payload?.image}>
                {job?.payload?.image}
              </span>
            </div>
            <div className="p-3 rounded-md bg-[#EFECE4] border border-[#E2DDD4] flex justify-between items-center">
              <span className="text-[#6B665E]">CPU</span>
              <span className="text-[#1A1816] font-bold">{job?.payload?.cpu} cores</span>
            </div>
            <div className="p-3 rounded-md bg-[#EFECE4] border border-[#E2DDD4] flex justify-between items-center">
              <span className="text-[#6B665E]">Memory</span>
              <span className="text-[#1A1816] font-bold">{job?.payload?.memory} MiB</span>
            </div>
            <div className="p-3 rounded-md bg-[#EFECE4] border border-[#E2DDD4] flex justify-between items-center">
              <span className="text-[#6B665E]">Created</span>
              <span className="text-[#1A1816]">
                {job?.createdAt ? new Date(job.createdAt).toLocaleTimeString() : "--"}
              </span>
            </div>
          </div>
        </div>

        {/* Audit Log */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-[#6B665E]">
            <span>Audit Log ({job?.auditLogs?.length || 0})</span>
          </div>

          <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
            {job?.auditLogs && job.auditLogs.length > 0 ? (
              job.auditLogs.map((log, i) => (
                <div
                  key={log.id}
                  className="p-3 rounded-md bg-[#EFECE4] border border-[#E2DDD4] text-xs font-mono space-y-1.5"
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center space-x-2">
                      <span className="text-[#6B665E]">#{i + 1}</span>
                      <span className="px-1.5 py-0.5 rounded bg-[#E2DDD4] text-[#1A1816]">
                        {log.fromStatus || "START"}
                      </span>
                      <span className="text-[#8C867A]">&rarr;</span>
                      <span className={`px-1.5 py-0.5 rounded font-bold border ${getAuditStatusColor(log.toStatus)}`}>
                        {log.toStatus}
                      </span>
                    </div>
                    <span className="text-[#6B665E]">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>

                  {/* Metadata display if available */}
                  {log.metadata && Object.keys(log.metadata).length > 0 && (
                    <div className="text-[11px] text-[#1A1816] bg-[#F6F4EE] p-2 rounded border border-[#E2DDD4] overflow-x-auto">
                      {typeof log.metadata === "object" ? (
                        <div className="space-y-0.5">
                          {Object.entries(log.metadata).map(([k, v]) => (
                            <div key={k} className="flex space-x-1.5">
                              <span className="text-[#6B665E]">{k}:</span>
                              <span className="text-[#1A1816] font-bold truncate max-w-sm">
                                {typeof v === "object" ? JSON.stringify(v) : String(v)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span>{String(log.metadata)}</span>
                      )}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className="text-xs text-[#6B665E] font-mono py-4 text-center">
                Awaiting initial state transitions...
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
