"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconRocket,
  IconAlertCircle,
  IconHelpCircle,
} from "@tabler/icons-react";

interface FieldErrors {
  appName?: string[];
  image?: string[];
  cpu?: string[];
  memory?: string[];
  replicas?: string[];
}

export default function DeploymentFormPage() {
  const router = useRouter();

  const [formData, setFormData] = useState({
    appName: "web-gateway",
    image: "nginx:alpine",
    cpu: 0.2,
    memory: 128,
    replicas: 1,
  });

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === "number" ? parseFloat(value) || 0 : value,
    }));

    if (fieldErrors[name as keyof FieldErrors]) {
      setFieldErrors((prev) => ({
        ...prev,
        [name]: undefined,
      }));
    }
    setGeneralError(null);
  };

  const handleSelectPreset = (presetName: string, presetImage: string) => {
    setFormData((prev) => ({
      ...prev,
      appName: presetName,
      image: presetImage,
    }));
    setFieldErrors({});
    setGeneralError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setFieldErrors({});
    setGeneralError(null);

    try {
      const res = await fetch(`${API_URL}/deployments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appName: formData.appName.trim(),
          image: formData.image.trim(),
          cpu: Number(formData.cpu),
          memory: Number(formData.memory),
          replicas: Number(formData.replicas),
        }),
      });

      const data = await res.json();

      if (res.status === 202 && data.jobId) {
        router.push(`/jobs/${data.jobId}`);
        return;
      }

      if (res.status === 400 && data.details) {
        setFieldErrors(data.details as FieldErrors);
        setGeneralError(data.error || "Validation failed. Please review the highlighted fields.");
      } else {
        setGeneralError(data.error || data.message || `Request failed with status ${res.status}`);
      }
    } catch (err: unknown) {
      console.error("Submission error:", err);
      setGeneralError(
        err instanceof Error
          ? `Connection failed: ${err.message}. Ensure API is running on ${API_URL}`
          : "Failed to connect to the Aegis API."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-4 pb-16 space-y-8">
      {/* Page Header */}
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-[#1A1816]">
          Deploy Kubernetes Workload
        </h1>
        <p className="text-sm text-[#6B665E]">
          Provision isolated container workloads into the <span className="text-[#1A1816] font-mono font-bold">kind-aegis</span> cluster.
        </p>

        {/* Minimal inline presets */}
        <div className="pt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[#6B665E]">
          <span className="text-[#8C867A] font-medium">Presets:</span>
          <button
            type="button"
            onClick={() => handleSelectPreset("web-gateway", "nginx:alpine")}
            className="text-[#1A1816] hover:text-[#FF4F00] transition-colors underline underline-offset-4 decoration-[#D4CDC2] hover:decoration-[#FF4F00] font-mono"
          >
            Nginx Gateway
          </button>
          <span className="text-[#D4CDC2]">/</span>
          <button
            type="button"
            onClick={() => handleSelectPreset("cache-service", "redis:alpine")}
            className="text-[#1A1816] hover:text-[#FF4F00] transition-colors underline underline-offset-4 decoration-[#D4CDC2] hover:decoration-[#FF4F00] font-mono"
          >
            Redis Cache
          </button>
          <span className="text-[#D4CDC2]">/</span>
          <button
            type="button"
            onClick={() => handleSelectPreset("api-echo", "hashicorp/http-echo:0.2.3")}
            className="text-[#1A1816] hover:text-[#FF4F00] transition-colors underline underline-offset-4 decoration-[#D4CDC2] hover:decoration-[#FF4F00] font-mono"
          >
            HTTP Echo
          </button>
          <span className="text-[#D4CDC2]">&middot;</span>
          <button
            type="button"
            onClick={() => handleSelectPreset("broken-app", "nginx:invalid-tag-phase4-demo")}
            className="text-[#DC2626] hover:text-[#B91C1C] transition-colors underline underline-offset-4 decoration-[#FCA5A5] hover:decoration-[#DC2626] font-mono font-medium"
          >
            ⚠️ Simulate Failure (Bad Image)
          </button>
        </div>
      </div>

      {/* General error banner */}
      {generalError && (
        <div className="p-4 rounded-lg bg-[#FEE2E2] border border-[#F87171] text-[#991B1B] text-sm flex items-start space-x-3">
          <IconAlertCircle className="text-[#DC2626] shrink-0 mt-0.5" size={18} />
          <div>
            <span className="font-bold block text-[#991B1B]">Submission Rejected</span>
            <span className="text-xs text-[#7F1D1D]">{generalError}</span>
          </div>
        </div>
      )}

      {/* Main Form: Open, borderless-until-focus, clear visual hierarchy */}
      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Primary Field: Application Name (Hero Input) */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <label htmlFor="appName" className="text-sm font-bold text-[#1A1816]">
              Application name
            </label>
            <span className="text-xs font-mono text-[#6B665E]">
              RFC 1123 &middot; target namespace
            </span>
          </div>
          <div className="relative">
            <input
              type="text"
              id="appName"
              name="appName"
              value={formData.appName}
              onChange={handleChange}
              placeholder="e.g. order-service"
              className={`w-full bg-transparent border-0 border-b-2 rounded-none px-0 py-2 text-xl font-mono font-bold text-[#1A1816] placeholder-[#8C867A] focus:outline-none transition-colors ${
                fieldErrors.appName
                  ? "border-[#DC2626] text-[#DC2626] focus:border-[#DC2626]"
                  : "border-[#D4CDC2] focus:border-[#FF4F00]"
              }`}
            />
          </div>
          {fieldErrors.appName ? (
            <p className="text-xs text-[#DC2626] pt-1 font-medium">
              {fieldErrors.appName.join(", ")}
            </p>
          ) : (
            <p className="text-xs text-[#6B665E] pt-1">
              Lowercase alphanumeric and hyphens. Determines DNS and isolated workspace.
            </p>
          )}
        </div>

        {/* Secondary Field: Container Image */}
        <div className="space-y-2">
          <label htmlFor="image" className="block text-sm font-bold text-[#1A1816]">
            Container image
          </label>
          <input
            type="text"
            id="image"
            name="image"
            value={formData.image}
            onChange={handleChange}
            placeholder="e.g. nginx:alpine"
            className={`w-full bg-transparent border-0 border-b rounded-none px-0 py-2 text-sm font-mono text-[#1A1816] placeholder-[#8C867A] focus:outline-none transition-colors ${
              fieldErrors.image
                ? "border-[#DC2626] text-[#DC2626] focus:border-[#DC2626]"
                : "border-[#D4CDC2] focus:border-[#FF4F00]"
            }`}
          />
          {fieldErrors.image && (
            <p className="text-xs text-[#DC2626] pt-1 font-medium">
              {fieldErrors.image.join(", ")}
            </p>
          )}
        </div>

        {/* Sizing & Capacity Section: Lighter-touch quantitative parameters */}
        <div className="pt-4 space-y-4">
          <div className="text-xs font-bold uppercase tracking-wider text-[#6B665E]">
            Compute & sizing
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-6">
            {/* CPU Limit */}
            <div className="space-y-1.5">
              <label htmlFor="cpu" className="block text-xs font-medium text-[#6B665E]">
                CPU limit
              </label>
              <div className="flex items-baseline space-x-1 border-b border-[#D4CDC2] focus-within:border-[#FF4F00] transition-colors pb-1">
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  id="cpu"
                  name="cpu"
                  value={formData.cpu}
                  onChange={handleChange}
                  className="w-full bg-transparent border-0 rounded-none px-0 py-1 text-sm font-mono font-bold text-[#1A1816] focus:outline-none"
                />
                <span className="text-xs font-mono text-[#6B665E] shrink-0">cores</span>
              </div>
              {fieldErrors.cpu && (
                <p className="text-xs text-[#DC2626] pt-1 font-medium">
                  {fieldErrors.cpu.join(", ")}
                </p>
              )}
            </div>

            {/* Memory Limit */}
            <div className="space-y-1.5">
              <label htmlFor="memory" className="block text-xs font-medium text-[#6B665E]">
                Memory
              </label>
              <div className="flex items-baseline space-x-1 border-b border-[#D4CDC2] focus-within:border-[#FF4F00] transition-colors pb-1">
                <input
                  type="number"
                  step="16"
                  min="16"
                  id="memory"
                  name="memory"
                  value={formData.memory}
                  onChange={handleChange}
                  className="w-full bg-transparent border-0 rounded-none px-0 py-1 text-sm font-mono font-bold text-[#1A1816] focus:outline-none"
                />
                <span className="text-xs font-mono text-[#6B665E] shrink-0">MiB</span>
              </div>
              {fieldErrors.memory && (
                <p className="text-xs text-[#DC2626] pt-1 font-medium">
                  {fieldErrors.memory.join(", ")}
                </p>
              )}
            </div>

            {/* Replicas */}
            <div className="space-y-1.5">
              <label htmlFor="replicas" className="block text-xs font-medium text-[#6B665E]">
                Replicas
              </label>
              <div className="flex items-baseline space-x-1 border-b border-[#D4CDC2] focus-within:border-[#FF4F00] transition-colors pb-1">
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="10"
                  id="replicas"
                  name="replicas"
                  value={formData.replicas}
                  onChange={handleChange}
                  className="w-full bg-transparent border-0 rounded-none px-0 py-1 text-sm font-mono font-bold text-[#1A1816] focus:outline-none"
                />
                <span className="text-xs font-mono text-[#6B665E] shrink-0">pods</span>
              </div>
              {fieldErrors.replicas && (
                <p className="text-xs text-[#DC2626] pt-1 font-medium">
                  {fieldErrors.replicas.join(", ")}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Submit action bar */}
        <div className="pt-8 border-t border-[#E2DDD4] flex items-center justify-between">
          <span className="text-xs font-mono text-[#6B665E]">
            Creates isolated Terraform workspace
          </span>
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-md bg-[#FF4F00] hover:bg-[#E04500] disabled:bg-[#D4CDC2] disabled:text-[#8C867A] text-white font-bold text-sm shadow-sm transition-all active:scale-[0.98] cursor-pointer"
          >
            {isSubmitting ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <span>Dispatching Job...</span>
              </>
            ) : (
              <>
                <IconRocket size={17} stroke={2.5} />
                <span>Deploy Workload</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
