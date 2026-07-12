// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { finalizeDeployment } from "@/app/server/actions/deployments";
import { finalizeChartScan } from "@/app/server/actions/byo-charts";
import { finalizeIacScan } from "@/app/server/actions/byo-iac";
import { recordDriftPosture } from "@/app/server/actions/drift";
import {
	advancePromotionOnPlan,
	failPromotionForJob,
	finalizePromotionOnDeploy,
} from "@/app/server/actions/promotions";
import { maybeAutoHeal } from "@/app/server/actions/reconcile";
import {
	recordAddonHealth,
	recordSecurityPosture,
} from "@/lib/addons/inspection-persistence";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { reportJobUsageOnce } from "@/lib/billing/meter";
import { getServiceDb } from "@/lib/db";
import {
	type EnvTransitionContext,
	transitionEnv,
} from "@/lib/db/env-status";
import { jobs } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { verifyRunnerToken } from "@/lib/runners/auth";

export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId, tokenHash, error: authError } =
		await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;
	const jlog = log.child({
		component: "job-status",
		job_id: jobId,
		runner_id: runnerId,
	});

	try {
		const { status, error_message, execution_metadata } = await req.json();

		if (!status) {
			return NextResponse.json(
				{ error: "status is required" },
				{ status: 400 },
			);
		}

		const validStatuses = ["PROCESSING", "SUCCESS", "FAILED", "CANCELLED"];
		if (!validStatuses.includes(status)) {
			return NextResponse.json(
				{ error: `status must be one of: ${validStatuses.join(", ")}` },
				{ status: 400 },
			);
		}

		const db = getServiceDb();

		await db.execute(
			sql`select update_job_status(${runnerId}::uuid, ${tokenHash}, ${jobId}::uuid, ${status}, ${error_message || null}, ${execution_metadata ? JSON.stringify(execution_metadata) : null}::jsonb)`,
		);

		if (
			status === "PROCESSING" ||
			status === "SUCCESS" ||
			status === "FAILED" ||
			status === "CANCELLED"
		) {
			const [job] = await db
				.select({
					job_type: jobs.job_type,
					project_id: jobs.project_id,
					environment_id: jobs.environment_id,
					org_id: jobs.org_id,
					cloud_identity_id: jobs.cloud_identity_id,
					execution_metadata: jobs.execution_metadata,
				})
				.from(jobs)
				.where(eq(jobs.id, jobId))
				.limit(1);

			// Cancelled (torn down mid-flight by the runner after a user cancel). Alert on the
			// cancellation, and — when the runner flagged orphan risk (apply was interrupted) —
			// raise a distinct, higher-severity alert so an operator reconciles cloud vs state,
			// and mark the environment FAILED (its infra is in an unknown, partially-applied state).
			if (job?.org_id && status === "CANCELLED") {
				const orphanRisk = job.execution_metadata?.orphan_risk === true;
				emitAlertEventSafe(job.org_id, "system.job.cancelled", {
					title: `Job cancelled: ${job.job_type}`,
					summary: error_message || undefined,
					severity: "warning",
					job_id: jobId,
					job_type: job.job_type,
					project_id: job.project_id ?? undefined,
				});
				if (orphanRisk) {
					emitAlertEventSafe(job.org_id, "system.project.orphan_risk", {
						title: "Possible orphaned resources after cancel",
						summary:
							"An apply was interrupted mid-flight; cloud resources may exist outside tofu state and need reconciliation.",
						severity: "critical",
						job_id: jobId,
						job_type: job.job_type,
						project_id: job.project_id ?? undefined,
					});
				}
				// A cancelled DEPLOY leaves the env in an indeterminate (partially provisioned)
				// state → FAILED so it surfaces as needing attention (best-effort). Route through the
				// env-status CAS (deployFailed: QUEUED|PROVISIONING → FAILED) rather than a naked
				// update, so a cancel that lost the race to a real terminal outcome (the deploy already
				// reached ACTIVE, or a DESTROY already moved it on) can't clobber that state back to
				// FAILED — transitionEnv logs + alerts on a rejected transition and never throws.
				if (
					job.job_type === "DEPLOY" &&
					job.project_id &&
					job.environment_id
				) {
					await transitionEnv(db, job.environment_id, "deployFailed", jobId, {
						orgId: job.org_id,
						projectId: job.project_id,
					}).catch((err) =>
						jlog.error("set env FAILED on cancel error", { err }),
					);
				}
			}

			// Ops alerts (free in core): job start, terminal state, project destroy.
			if (job?.org_id && status === "PROCESSING") {
				emitAlertEventSafe(job.org_id, "system.job.started", {
					title: `Job started: ${job.job_type}`,
					severity: "info",
					job_id: jobId,
					job_type: job.job_type,
					project_id: job.project_id ?? undefined,
				});
			}
			if (job?.org_id && (status === "SUCCESS" || status === "FAILED")) {
				const base = {
					job_id: jobId,
					job_type: job.job_type,
					project_id: job.project_id ?? undefined,
				};
				if (status === "FAILED") {
					emitAlertEventSafe(job.org_id, "system.job.failed", {
						title: `Job failed: ${job.job_type}`,
						summary: error_message || undefined,
						severity: "critical",
						...base,
					});
				} else {
					emitAlertEventSafe(job.org_id, "system.job.succeeded", {
						title: `Job succeeded: ${job.job_type}`,
						severity: "info",
						...base,
					});
					if (job.job_type === "DESTROY") {
						emitAlertEventSafe(job.org_id, "system.project.destroyed", {
							title: "Project destroyed",
							severity: "warning",
							...base,
						});
					}
				}
			}

			// M1: provisioning status lives on the targeted environment (the job carries
			// environment_id). Legacy / non-project jobs without one simply skip the update.
			if (job?.project_id && job.environment_id) {
				const environmentId = job.environment_id;
				const envMeta = {
					orgId: job.org_id,
					projectId: job.project_id,
				};
				// Route EVERY env-status write through the CAS RPC (lib/db/env-status.ts) so a
				// late/racing runner callback can't clobber a newer terminal state (last-writer-wins).
				// A rejected transition (a lost race) is logged + alerted inside transitionEnv and
				// never throws — a status callback must never fail on a lost race. A dropped-but-legal
				// update surfaces via that alert; converging it is the B2c reconciler backstop.
				const move = (context: EnvTransitionContext) =>
					transitionEnv(db, environmentId, context, jobId, envMeta);
				if (job.job_type === "DEPLOY") {
					if (status === "PROCESSING") {
						await move("deployStart");
					} else if (status === "FAILED") {
						await move("deployFailed");
						// A promotion's deploy failed → mark the promotion FAILED (no-op otherwise).
						await failPromotionForJob(jobId).catch((err) =>
							jlog.error("fail promotion (deploy) error", { err }),
						);
					} else if (status === "SUCCESS") {
						try {
							// finalizeDeployment moves the env to ACTIVE through the same CAS.
							await finalizeDeployment(jobId);
						} catch (err) {
							jlog.error("finalize deployment error", { err });
							await move("deployFailed");
						}
						// Mark a promotion SUCCEEDED if this deploy was one (no-op otherwise).
						await finalizePromotionOnDeploy(jobId).catch((err) =>
							jlog.error("finalize promotion error", { err }),
						);
					}
				} else if (job.job_type === "DESTROY") {
					if (status === "PROCESSING") {
						await move("destroyStart");
					} else if (status === "FAILED") {
						await move("destroyFailed");
					} else if (status === "SUCCESS") {
						// A successful DESTROY tore down the env's infra — clear the BYO-IaC
						// deployed-commit pin so the source can be detached again (finalizeDeployment
						// no-ops for template envs). Best-effort: never fail the status update.
						await finalizeDeployment(jobId).catch((err) =>
							jlog.error("finalize destroy error", { err }),
						);
						await move("destroySuccess");
					}
				} else if (job.job_type === "PLAN") {
					if (status === "FAILED") {
						await move("planFailed");
						await failPromotionForJob(jobId).catch((err) =>
							jlog.error("fail promotion (plan) error", { err }),
						);
					} else if (status === "SUCCESS") {
						await move("planSuccess");
						// If this PLAN backs a promotion, evaluate its gates now (deploy / await / block).
						await advancePromotionOnPlan(jobId).catch((err) =>
							jlog.error("advance promotion error", { err }),
						);
					}
				}
			}

			// DETECT_DRIFT: persist the runner's drift posture (posted in execution_metadata
			// by the refresh-only plan → drift.Analyze) into the per-environment day-2 record.
			if (
				job?.job_type === "DETECT_DRIFT" &&
				status === "SUCCESS" &&
				job.project_id
			) {
				const posture = job.execution_metadata?.drift_posture;
				if (posture) {
					try {
						await recordDriftPosture({
							projectId: job.project_id,
							environmentId: job.environment_id ?? null,
							inSync: posture.in_sync,
							drifted: posture.drifted,
							details: (posture.details ?? []).map((d) => ({
								address: d.address,
								type: d.type,
								kind: String(d.kind),
							})),
							scannedAt: posture.scanned_at ?? new Date().toISOString(),
						});
					} catch (err) {
						jlog.error("persist drift posture error", { err });
					}
					// Day-2 reconcile: if the env drifted, consider auto-healing it (opt-in;
					// prod stays approval-gated; guarded by backoff + circuit breaker).
					if (!posture.in_sync && job.environment_id) {
						await maybeAutoHeal(job.project_id, job.environment_id).catch(
							(err) => jlog.error("auto-heal error", { err }),
						);
					}
				}
				// Continuous day-2 refresh (Phase 4): the drift job also inspected the live
				// cluster (ArgoCD add-on health + Trivy security), posted alongside the posture.
				// Persist them so the Add-ons page + Evidence Security tab stay current between
				// deploys. Best-effort — never fail the status update.
				if (job.environment_id) {
					const addonStatus = job.execution_metadata?.addon_status;
					if (addonStatus) {
						await recordAddonHealth(
							job.project_id,
							job.environment_id,
							addonStatus,
						).catch((err) =>
							jlog.error("persist add-on health (drift) error", { err }),
						);
					}
					const security = job.execution_metadata?.security_report;
					if (security) {
						await recordSecurityPosture(
							job.project_id,
							job.environment_id,
							security,
						).catch((err) =>
							jlog.error("persist security posture (drift) error", { err }),
						);
					}
				}
			}

			// CHART_SCAN: write the chart-safety verify.Report back onto the chart row (done/failed).
			if (job?.job_type === "CHART_SCAN" && (status === "SUCCESS" || status === "FAILED")) {
				await finalizeChartScan(jobId).catch((err) =>
					jlog.error("finalize chart scan error", { err }),
				);
			}

			// IAC_SCAN: write the BYO-IaC scan report back onto its project_iac_sources row and
			// pin the scanned commit (done/failed).
			if (job?.job_type === "IAC_SCAN" && (status === "SUCCESS" || status === "FAILED")) {
				await finalizeIacScan(jobId).catch((err) =>
					jlog.error("finalize IaC scan error", { err }),
				);
			}

		}

		// Bill managed-runner job-minutes once the job is terminal (best-effort; a
		// metering failure must never fail the runner's status update).
		if (status === "SUCCESS" || status === "FAILED") {
			try {
				await reportJobUsageOnce(jobId);
			} catch (err) {
				jlog.error("usage metering failed", { err });
			}
		}

		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
