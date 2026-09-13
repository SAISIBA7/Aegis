"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { JobStatus } from "@aegis/shared";
import {
  IconChecklist,
  IconClock,
  IconArrowRight,
  IconAlertCircle,
  IconRefresh,
  IconCheck,
  IconX,
  IconCpu,
} from "@tabler/icons-react";

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
}

export default function ApprovalsDashboardPage() {
  const [jobs, setJobs] = useState<JobData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ id: string; text: string; isError?: boolean } | null>(null);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

  const fetchPendingJobs = async () => {
    try {
      const res = await fetch(`${API_URL}/jobs?status=PENDING_APPROVAL`);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data: JobData[] = await res.json();
      setJobs(data);
    } catch (err) {
      console.error("Failed to fetch pending jobs:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPendingJobs();
    const interval = setInterval(fetchPendingJobs, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleApprove = async (jobId: string) => {
    setActionInProgress(jobId);
    setActionMessage(null);
    try {
      const res = await fetch(`${API_URL}/jobs/${jobId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approver: "approval_dashboard" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Approval failed`);
      }
      setActionMessage({ id: jobId, text: "Approved! Policy check and execution queued." });
      await fetchPendingJobs();
    } catch (err: any) {
      setActionMessage({ id: jobId, text: err.message, isError: true });
    } finally {
      setActionInProgress(null);
    }
  };

  const handleReject = async (jobId: string) => {
    setActionInProgress(jobId);
    setActionMessage(null);
    try {
      const res = await fetch(`${API_URL}/jobs/${jobId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rejecter: "approval_dashboard", reason: "Rejected via Approvals Dashboard" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Rejection failed`);
      }
      setActionMessage({ id: jobId, text: "Proposal rejected. Cluster remains untouched." });
      await fetchPendingJobs();
    } catch (err: any) {
      setActionMessage({ id: jobId, text: err.message, isError: true });
    } finally {
      setActionInProgress(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-[#E2DDD4]">
        <div>
          <div className="flex items-center space-x-3">
            <div className="h-9 w-9 rounded-lg bg-[#FF4F00] text-white flex items-center justify-center font-bold shadow-sm">
              <IconChecklist size={20} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[#1A1816] tracking-tight">
                Governance Approvals
              </h1>
              <p className="text-xs text-[#6B665E]">
                Remediation proposals requiring human sign-off before Kyverno admission verification
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-3 text-xs font-mono">
          <span className="px-3 py-1.5 rounded-md bg-[#FEF3C7] text-[#92400E] border border-[#FCD34D] font-bold">
            {jobs.length} Pending {jobs.length === 1 ? "Action" : "Actions"}
          </span>
          <button
            onClick={fetchPendingJobs}
            title="Refresh list"
            className="p-1.5 rounded-md bg-[#EFECE4] hover:bg-[#E7E3DA] border border-[#E2DDD4] text-[#6B665E] hover:text-[#1A1816] transition-colors"
          >
            <IconRefresh size={14} />
          </button>
        </div>
      </div>

      {/* Jobs List */}
      {isLoading ? (
        <div className="py-16 text-center text-xs font-mono text-[#6B665E]">
          Loading pending approvals...
        </div>
      ) : jobs.length === 0 ? (
        <div className="py-16 px-4 text-center rounded-lg bg-white border border-[#E2DDD4] space-y-3 shadow-sm">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[#DCFCE7] text-[#166534]">
            <IconCheck size={24} stroke={2.5} />
          </div>
          <h3 className="text-base font-bold text-[#1A1816]">No Pending Approvals</h3>
          <p className="text-xs text-[#6B665E] max-w-sm mx-auto">
            All workload remediations have been reviewed. New failure diagnoses will appear here automatically.
          </p>
          <div className="pt-2">
            <Link
              href="/"
              className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-md bg-[#1A1816] hover:bg-[#2C2825] text-white text-xs font-bold transition-colors"
            >
              <span>Back to deployments</span>
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="p-6 rounded-lg bg-white border-2 border-[#E2DDD4] hover:border-[#D4CDC2] transition-colors shadow-sm space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-[#E2DDD4]">
                <div>
                  <div className="flex items-center space-x-2.5">
                    <span className="text-lg font-bold text-[#1A1816]">
                      {job.payload?.appName}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-[#FEF3C7] text-[#92400E] border border-[#FCD34D]">
                      PENDING APPROVAL
                    </span>
                  </div>
                  <span className="text-xs font-mono text-[#6B665E]">
                    Job: <Link href={`/jobs/${job.id}`} className="underline hover:text-[#1A1816]">{job.id}</Link> &middot; Namespace: {job.payload?.appName}
                  </span>
                </div>
                <div className="text-xs font-mono text-[#6B665E]">
                  Queued: {new Date(job.createdAt).toLocaleTimeString()}
                </div>
              </div>

              {/* Proposal Reasoning */}
              {job.proposal && (
                <div className="bg-[#FFFBEB] p-3.5 rounded-md border border-[#FDE68A] text-xs font-mono space-y-1">
                  <div className="flex items-center space-x-1.5 text-[#92400E] font-bold">
                    <IconCpu size={14} />
                    <span>AI Diagnosis (Nemotron 3.5) &middot; Action: {job.proposal.actionType}</span>
                  </div>
                  <p className="text-xs text-[#78350F] leading-relaxed font-sans font-medium">
                    {job.proposal.reasoning}
                  </p>
                </div>
              )}

              {/* Proposed Mutation Diff */}
              {job.proposal && (
                <div className="p-3.5 rounded-md bg-[#F6F4EE] border border-[#E2DDD4] text-xs font-mono space-y-2">
                  <span className="text-[11px] font-bold text-[#6B665E] uppercase tracking-wider block">
                    Proposed Mutation
                  </span>

                  {job.proposal.actionType === "increase_resource_limit" && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <span className="text-[#6B665E] block text-[10px]">CPU Limit</span>
                        <span className="font-bold text-[#1A1816]">
                          {job.payload.cpu}c &rarr; {String(job.proposal.params.cpu)}c
                        </span>
                      </div>
                      <div>
                        <span className="text-[#6B665E] block text-[10px]">Memory Limit</span>
                        <span className="font-bold text-[#1A1816]">
                          {job.payload.memory}Mi &rarr; {String(job.proposal.params.memory)}Mi
                        </span>
                      </div>
                    </div>
                  )}

                  {job.proposal.actionType === "scale_replicas" && (
                    <div>
                      <span className="text-[#6B665E] block text-[10px]">Replica Count</span>
                      <span className="font-bold text-[#1A1816]">
                        {job.payload.replicas || 1} &rarr; {String(job.proposal.params.replicas)} replicas
                      </span>
                    </div>
                  )}

                  {job.proposal.actionType === "rollback_deployment" && (
                    <div>
                      <span className="font-bold text-[#1A1816]">
                        Roll back deployment/{job.proposal.target} to immediately preceding revision
                      </span>
                    </div>
                  )}

                  {job.proposal.actionType === "restart_pod" && (
                    <div>
                      <span className="font-bold text-[#1A1816]">
                        Delete pod/{job.proposal.target} in namespace {String(job.proposal.params.namespace || "default")}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Feedback Message */}
              {actionMessage && actionMessage.id === job.id && (
                <div
                  className={`p-2.5 rounded text-xs font-mono ${
                    actionMessage.isError
                      ? "bg-[#FEF2F2] border border-[#FCA5A5] text-[#991B1B]"
                      : "bg-[#DCFCE7] border border-[#86EFAC] text-[#166534]"
                  }`}
                >
                  {actionMessage.text}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-2 border-t border-[#E2DDD4]">
                <Link
                  href={`/jobs/${job.id}`}
                  className="text-xs font-mono text-[#6B665E] hover:text-[#1A1816] flex items-center space-x-1"
                >
                  <span>View full audit timeline</span>
                  <IconArrowRight size={13} />
                </Link>

                <div className="flex items-center space-x-2.5">
                  <button
                    onClick={() => handleReject(job.id)}
                    disabled={actionInProgress === job.id}
                    className="px-3.5 py-1.5 rounded-md bg-white hover:bg-[#FEE2E2] border border-[#FCA5A5] text-[#991B1B] text-xs font-bold transition-all disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => handleApprove(job.id)}
                    disabled={actionInProgress === job.id}
                    className="px-4 py-1.5 rounded-md bg-[#1D7A46] hover:bg-[#166534] text-white text-xs font-bold transition-all disabled:opacity-50 shadow-sm"
                  >
                    {actionInProgress === job.id ? "Processing..." : "Approve & Execute"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
