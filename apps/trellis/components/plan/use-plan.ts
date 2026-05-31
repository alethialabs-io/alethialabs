"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { planVine, provisionVine } from "@/app/server/actions/vines";
import { getPlanResult, getVineJobs } from "@/app/server/actions/jobs";
import { finalizeDeployment } from "@/app/server/actions/deployments";
import {
	parsePlanJSON,
	type PlanSummary,
} from "@/lib/plan/parse-plan";
import {
	parseCostBreakdown,
	type CostSummary,
} from "@/lib/plan/parse-cost";
import { createClient } from "@/lib/supabase/client";

export type PlanPhase =
	| "idle"
	| "generating"
	| "ready"
	| "applying"
	| "applied"
	| "failed";

interface LogEntry {
	id: number;
	log_chunk: string;
	stream_type: string;
	created_at: string;
}

export interface UsePlanReturn {
	phase: PlanPhase;
	planJobId: string | null;
	deployJobId: string | null;
	planResult: PlanSummary | null;
	costResult: CostSummary | null;
	logs: LogEntry[];
	error: string | null;
	generatePlan: (workerId?: string | null) => Promise<void>;
	applyPlan: (workerId?: string | null) => Promise<void>;
}

export function usePlan(vineId: string | null): UsePlanReturn {
	const [phase, setPhase] = useState<PlanPhase>("idle");
	const [planJobId, setPlanJobId] = useState<string | null>(null);
	const [deployJobId, setDeployJobId] = useState<string | null>(null);
	const [planResult, setPlanResult] = useState<PlanSummary | null>(null);
	const [costResult, setCostResult] = useState<CostSummary | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const channelRef = useRef<ReturnType<
		ReturnType<typeof createClient>["channel"]
	> | null>(null);

	const cleanup = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
		if (channelRef.current) {
			const supabase = createClient();
			supabase.removeChannel(channelRef.current);
			channelRef.current = null;
		}
	}, []);

	useEffect(() => cleanup, [cleanup]);

	useEffect(() => {
		if (!vineId) return;
		let cancelled = false;

		async function loadExistingPlan() {
			try {
				const jobs = await getVineJobs(vineId!);
				const latestPlan = jobs
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

				const meta = result.execution_metadata as Record<
					string,
					unknown
				> | null;

				if (meta?.plan_result) {
					setPlanResult(
						parsePlanJSON(
							meta.plan_result as Record<string, unknown>,
						),
					);
				}
				if (meta?.cost_breakdown) {
					setCostResult(
						parseCostBreakdown(
							meta.cost_breakdown as Record<string, unknown>,
						),
					);
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
	}, [vineId]);

	const generatePlan = useCallback(async (workerId?: string | null) => {
		if (!vineId) return;
		setPhase("generating");
		setError(null);
		setLogs([]);
		setPlanResult(null);
		setCostResult(null);

		try {
			const { jobId } = await planVine(vineId, workerId);
			setPlanJobId(jobId);

			const supabase = createClient();
			const channel = supabase
				.channel(`plan_logs:${jobId}`)
				.on(
					"postgres_changes",
					{
						event: "INSERT",
						schema: "public",
						table: "job_logs",
						filter: `job_id=eq.${jobId}`,
					},
					(payload) => {
						setLogs((prev) => [...prev, payload.new as LogEntry]);
					},
				)
				.subscribe();
			channelRef.current = channel;

			pollRef.current = setInterval(async () => {
				try {
					const result = await getPlanResult(jobId);
					if (
						result.status === "SUCCESS" ||
						result.status === "FAILED"
					) {
						cleanup();

						if (result.status === "FAILED") {
							setPhase("failed");
							setError(
								result.error_message ||
									"Plan generation failed",
							);
							return;
						}

						const meta = result.execution_metadata as Record<
							string,
							unknown
						>;
						if (meta?.plan_result) {
							setPlanResult(
								parsePlanJSON(
									meta.plan_result as Record<
										string,
										unknown
									>,
								),
							);
						}
						if (meta?.cost_breakdown) {
							setCostResult(
								parseCostBreakdown(
									meta.cost_breakdown as Record<
										string,
										unknown
									>,
								),
							);
						}
						setPhase("ready");
					}
				} catch {
					// polling error, keep trying
				}
			}, 3000);
		} catch (err) {
			setPhase("failed");
			setError(
				err instanceof Error
					? err.message
					: "Failed to start plan",
			);
		}
	}, [vineId, cleanup]);

	const applyPlan = useCallback(async (workerId?: string | null) => {
		if (!vineId || !planJobId) return;
		setPhase("applying");
		setError(null);

		try {
			const { jobId } = await provisionVine(vineId, planJobId, workerId);
			setDeployJobId(jobId);

			pollRef.current = setInterval(async () => {
				try {
					const result = await getPlanResult(jobId);
					if (result.status === "SUCCESS" || result.status === "FAILED") {
						cleanup();

						if (result.status === "FAILED") {
							setPhase("failed");
							setError(result.error_message || "Deployment failed");
							return;
						}

						await finalizeDeployment(jobId);
						setPhase("applied");
					}
				} catch {
					// polling error, keep trying
				}
			}, 5000);
		} catch (err) {
			setPhase("failed");
			setError(
				err instanceof Error
					? err.message
					: "Failed to start provisioning",
			);
		}
	}, [vineId, planJobId, cleanup]);

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
