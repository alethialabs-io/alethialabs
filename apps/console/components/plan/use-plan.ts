"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { tryPlanProject, tryProvisionProject } from "@/app/server/actions/projects";
import { rpcClient } from "@/lib/rpc/client";
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
				const projectJobs = await rpcClient.jobs.project({ projectId: projectId! });
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

				const result = await rpcClient.jobs.planResult({ id: latestPlan.id });
				if (cancelled) return;

				const meta = result.execution_metadata;

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

	// A job the runner settled moves the phase as the job list shows it — set while rendering
	// (React's "adjust state while rendering" form: each branch leaves the phase it tests, so it
	// runs once), not from an effect a commit later. `settled` names the job, so the parent's
	// refresh runs once per settled job, from the effect below.
	const planJob = planJobId ? jobs.find((j) => j.id === planJobId) : undefined;
	const deployJob = deployJobId ? jobs.find((j) => j.id === deployJobId) : undefined;
	const [settled, setSettled] = useState<string | null>(null);
	if (phase === "generating" && planJob?.status === "FAILED") {
		setPhase("failed");
		setError(planJob.error_message || "Plan generation failed");
		setSettled(planJob.id);
	} else if (phase === "applying" && deployJob?.status === "FAILED") {
		setPhase("failed");
		setError(deployJob.error_message || "Deployment failed");
		setSettled(deployJob.id);
	} else if (phase === "applying" && deployJob?.status === "SUCCESS") {
		setPhase("applied");
		setSettled(deployJob.id);
	}
	/** The parent's refresh, read when it runs rather than as a dependency. */
	const refresh = useEffectEvent(() => onRefresh?.());
	useEffect(() => {
		if (settled !== null) refresh();
	}, [settled]);

	useEffect(() => {
		if (!planJobId || phase !== "generating") return;
		const job = jobs.find((j) => j.id === planJobId);
		if (!job) return;

		if (job.status === "SUCCESS") {
			rpcClient.jobs.planResult({ id: planJobId }).then((result) => {
				const meta = result.execution_metadata;
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

	const generatePlan = useCallback(async (runnerId?: string | null) => {
		if (!projectId) return;
		setPhase("generating");
		setError(null);
		setPlanResult(null);
		setCostResult(null);

		try {
			const res = await tryPlanProject(projectId, runnerId);
			// A refusal the user can act on is RETURNED (#5445) — thrown, a production build
			// replaced its sentence with a digest before it reached `error` below.
			if (!res.ok) {
				setPhase("failed");
				setError(res.error);
				return;
			}
			// Logs stream via useJobLogStream(planJobId) once this is set.
			setPlanJobId(res.jobId);
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
			const res = await tryProvisionProject(projectId, planJobId, runnerId);
			if (!res.ok) {
				setPhase("failed");
				setError(res.error);
				return;
			}
			setDeployJobId(res.jobId);
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
