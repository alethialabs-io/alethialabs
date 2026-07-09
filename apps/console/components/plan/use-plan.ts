"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useCallback, useEffect, useState } from "react";
import { planProject, provisionProject } from "@/app/server/actions/projects";
import { getPlanResult, getProjectJobs } from "@/app/server/actions/jobs";
import {
	parsePlanJSON,
	type PlanSummary,
} from "@/lib/plan/parse-plan";
import {
	parseCostBreakdown,
	type CostSummary,
} from "@/lib/plan/parse-cost";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import type { ExecutionMetadata } from "@/types/jsonb.types";
import {
	type JobLogEntry,
	useJobLogStream,
} from "@/hooks/use-job-log-stream";

export type PlanPhase =
	| "idle"
	| "generating"
	| "ready"
	| "applying"
	| "applied"
	| "failed";

export interface UsePlanReturn {
	phase: PlanPhase;
	planJobId: string | null;
	deployJobId: string | null;
	planResult: PlanSummary | null;
	costResult: CostSummary | null;
	logs: JobLogEntry[];
	error: string | null;
	generatePlan: (runnerId?: string | null) => Promise<void>;
	applyPlan: (runnerId?: string | null) => Promise<void>;
}

export function usePlan(projectId: string | null, onRefresh?: () => void): UsePlanReturn {
	const [phase, setPhase] = useState<PlanPhase>("idle");
	const [planJobId, setPlanJobId] = useState<string | null>(null);
	const [deployJobId, setDeployJobId] = useState<string | null>(null);
	const [planResult, setPlanResult] = useState<PlanSummary | null>(null);
	const [costResult, setCostResult] = useState<CostSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { logs } = useJobLogStream(planJobId);

	const { data: jobs = [] } = useJobsQuery();

	useEffect(() => {
		if (!projectId) return;
		let cancelled = false;

		async function loadExistingPlan() {
			try {
				const projectJobs = await getProjectJobs(projectId!);
				const latestPlan = projectJobs
					.filter(
						(j) =>
							j.job_type === "PLAN" && j.status === "SUCCESS",
					)
					.sort(
						(a, b) =>
							new Date(b.created_at ?? 0).getTime() -
							new Date(a.created_at ?? 0).getTime(),
					)[0];

				if (!latestPlan || cancelled) return;

				const result = await getPlanResult(latestPlan.id);
				if (cancelled) return;

				const meta = result.execution_metadata as ExecutionMetadata | null;

				if (meta?.plan_result) {
					setPlanResult(parsePlanJSON(meta.plan_result));
				}
				if (meta?.cost_breakdown) {
					setCostResult(parseCostBreakdown(meta.cost_breakdown));
				}

				if (meta?.plan_result || meta?.cost_breakdown) {
					setPlanJobId(latestPlan.id);
					setPhase("ready");
				}
			} catch {
				// ignore — no existing plan
			}
		}

		loadExistingPlan();
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	useEffect(() => {
		if (!planJobId || phase !== "generating") return;
		const job = jobs.find((j) => j.id === planJobId);
		if (!job) return;

		if (job.status === "FAILED") {
			setPhase("failed");
			setError(job.error_message || "Plan generation failed");
			onRefresh?.();
			return;
		}

		if (job.status === "SUCCESS") {
			getPlanResult(planJobId).then((result) => {
				const meta = result.execution_metadata as ExecutionMetadata;
				if (meta?.plan_result) {
					setPlanResult(parsePlanJSON(meta.plan_result));
				}
				if (meta?.cost_breakdown) {
					setCostResult(parseCostBreakdown(meta.cost_breakdown));
				}
				setPhase("ready");
				onRefresh?.();
			}).catch(() => {
				setPhase("failed");
				setError("Failed to load plan results");
			});
		}
	}, [jobs, planJobId, phase, onRefresh]);

	useEffect(() => {
		if (!deployJobId || phase !== "applying") return;
		const job = jobs.find((j) => j.id === deployJobId);
		if (!job) return;

		if (job.status === "FAILED") {
			setPhase("failed");
			setError(job.error_message || "Deployment failed");
			onRefresh?.();
			return;
		}

		if (job.status === "SUCCESS") {
			setPhase("applied");
			onRefresh?.();
		}
	}, [jobs, deployJobId, phase, onRefresh]);

	const generatePlan = useCallback(async (runnerId?: string | null) => {
		if (!projectId) return;
		setPhase("generating");
		setError(null);
		setPlanResult(null);
		setCostResult(null);

		try {
			const { jobId } = await planProject(projectId, runnerId);
			// Logs stream via useJobLogStream(planJobId) once this is set.
			setPlanJobId(jobId);
		} catch (err) {
			setPhase("failed");
			setError(
				err instanceof Error
					? err.message
					: "Failed to start plan",
			);
		}
	}, [projectId]);

	const applyPlan = useCallback(async (runnerId?: string | null) => {
		if (!projectId || !planJobId) return;
		setPhase("applying");
		setError(null);

		try {
			const { jobId } = await provisionProject(projectId, planJobId, runnerId);
			setDeployJobId(jobId);
		} catch (err) {
			setPhase("failed");
			setError(
				err instanceof Error
					? err.message
					: "Failed to start provisioning",
			);
		}
	}, [projectId, planJobId]);

	return {
		phase,
		planJobId,
		deployJobId,
		planResult,
		costResult,
		logs,
		error,
		generatePlan,
		applyPlan,
	};
}
