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

      // Check if job reached a terminal state
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

  // Stepper timeline definition for Phase 2/3 flow
  const isFailure = currentStatus === JobStatus.FAILED || currentStatus === JobStatus.REJECTED;
  const isPolicyViolation = currentStatus === JobStatus.POLICY_VIOLATED;

  const terminalStepLabel = isFailure
    ? currentStatus === JobStatus.REJECTED ? "Rejected" : "Failed"
    : isPolicyViolation
    ? "Policy Violated"
    : "Executed";

  const terminalStepDesc = isFailure
    ? "Workload execution failed"
    : isPolicyViolation
    ? "Violated cluster admission policy"
    : "Pod running in cluster namespace";

  const STEPS: { status: JobStatus; label: string; desc: string }[] = [
    {
      status: JobStatus.INITIATED,
      label: "Initiated",
      desc: "Job accepted and queued",
    },
    {
      status: JobStatus.PROVISIONING,
      label: "Provisioning",
      desc: "Terraform apply in progress",
    },
    {
      status: (currentStatus && isTerminalState(currentStatus)) ? currentStatus : JobStatus.EXECUTED,
      label: terminalStepLabel,
      desc: terminalStepDesc,
    },
  ];

  // Helper to determine step state
  const getStepState = (stepStatus: JobStatus) => {
    if (!job) return "pending";
    const logMatch = job.auditLogs.find((l) => l.toStatus === stepStatus);
    const isCurrent = job.status === stepStatus;

    if (isCurrent) return "active";
    if (logMatch) return "completed";
    return "pending";
  };

  const getStepTimestamp = (stepStatus: JobStatus) => {
    const log = job?.auditLogs.find((l) => l.toStatus === stepStatus);
    if (!log) return null;
    return new Date(log.timestamp).toLocaleTimeString();
  };

  // High-contrast physical stamp badges for functional state readability
  const renderStatusBadge = (status?: JobStatus) => {
    switch (status) {
      case JobStatus.EXECUTED:
      case JobStatus.APPROVED:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#DCFCE7] text-[#166534] border border-[#86EFAC]">
            <IconCheck size={13} stroke={3} />
            <span>{status}</span>
          </span>
        );
      case JobStatus.FAILED:
      case JobStatus.REJECTED:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#FEE2E2] text-[#991B1B] border border-[#FCA5A5]">
            <IconAlertCircle size={13} stroke={2.5} />
            <span>{status}</span>
          </span>
        );
      case JobStatus.POLICY_VIOLATED:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#FEF3C7] text-[#92400E] border border-[#FCD34D]">
            <IconAlertCircle size={13} stroke={2.5} />
            <span>POLICY VIOLATED</span>
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
    if (statusName === "EXECUTED" || statusName === "APPROVED") {
      return "bg-[#DCFCE7] text-[#166534] border-[#86EFAC]";
    }
    if (statusName === "FAILED" || statusName === "REJECTED") {
      return "bg-[#FEE2E2] text-[#991B1B] border-[#FCA5A5]";
    }
    if (statusName === "POLICY_VIOLATED") {
      return "bg-[#FEF3C7] text-[#92400E] border-[#FCD34D]";
    }
    if (statusName === "PROVISIONING") {
      return "bg-[#DBEAFE] text-[#1E40AF] border-[#93C5FD]";
    }
    return "bg-[#E2DDD4] text-[#1A1816] border-[#D4CDC2]";
  };

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
              <span className="inline-flex rounded-full h-2 w-2 bg-[#1A4FD8]"></span>
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {STEPS.map((step, idx) => {
            const state = getStepState(step.status);
            const time = getStepTimestamp(step.status);
            const isStepFailure = step.status === JobStatus.FAILED || step.status === JobStatus.REJECTED;
            const isStepPolicyViolation = step.status === JobStatus.POLICY_VIOLATED;

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
              if (isStepFailure) {
                cardClasses = "bg-[#FEF2F2] border-[#FCA5A5] text-[#991B1B]";
                badgeClasses = "bg-[#DC2626] text-white";
              } else if (isStepPolicyViolation) {
                cardClasses = "bg-[#FFFBEB] border-[#FCD34D] text-[#92400E]";
                badgeClasses = "bg-[#D97706] text-white";
              } else {
                cardClasses = "bg-[#F0FDF4] border-[#86EFAC] text-[#166534]";
                badgeClasses = "bg-[#1D7A46] text-white";
              }
            }

            return (
              <div
                key={step.status}
                className={`relative p-4 rounded-md border transition-all ${cardClasses}`}
              >
                {/* Step header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2.5">
                    <div
                      className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-mono font-bold ${badgeClasses}`}
                    >
                      {state === "completed" ? (
                        isStepFailure ? (
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
                    <span className="inline-flex rounded-full h-2 w-2 bg-[#1A4FD8]"></span>
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

      {/* AI Diagnostic Proposal Card */}
      {job?.proposal && (
        <div className="p-5 rounded-lg bg-[#FFFBEB] border-2 border-[#F59E0B] text-xs font-mono space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="px-2.5 py-1 rounded bg-[#F59E0B] text-white font-bold text-[11px] uppercase tracking-wider">
                AI Diagnosis Generated (Nemotron 3.5)
              </span>
            </div>
            <span className="text-[#92400E] font-bold text-sm">Action: {job.proposal.actionType}</span>
          </div>
          <div>
            <span className="text-[#78350F] block text-[10px] uppercase font-bold tracking-wider">Root Cause & Reasoning</span>
            <p className="text-[#92400E] text-sm mt-1 leading-relaxed font-sans font-medium">{job.proposal.reasoning}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-[#FDE68A]">
            <div>
              <span className="text-[#78350F] block text-[10px] uppercase font-bold tracking-wider">Target Resource</span>
              <span className="text-[#1A1816] font-bold text-sm">{job.proposal.target}</span>
            </div>
            <div>
              <span className="text-[#78350F] block text-[10px] uppercase font-bold tracking-wider">Parameters</span>
              <span className="text-[#1A1816] font-bold text-sm font-mono">{JSON.stringify(job.proposal.params)}</span>
            </div>
          </div>
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

          <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
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
