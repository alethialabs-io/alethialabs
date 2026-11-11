"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own (BYO) Helm chart server actions — attach / detach a chart from a connected git
// repo to a project environment, and read the attached charts for the canvas. A BYO chart is
// persisted as a `project_addons` row with source='byo' (chart_repo + chart_path + version=ref);
// the runner renders it as an ArgoCD Application in a hardened per-project "byo-<slug>" AppProject
// on the next DEPLOY. This layer only records intent — it never touches the cluster.
//
// TRUST GATE (MVP): the feature is flagged off by default and, when on, is limited to org-owner-
// authed edits of trusted charts on the org's own cluster. Untrusted third-party charts wait on a
// namespace-PSA + admission-controller (Kyverno/Gatekeeper) gate — see the plan's E2 section.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, FieldRefusal } from "@/lib/actions/result";
import { refusingCanvasWrite } from "@/lib/canvas/write-refusals";
import { signedJob } from "@/lib/db/signed-job";
import { refuseProjectOfAnotherOrg } from "@/lib/projects/refuse-other-org";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { authorize } from "@/lib/authz/guard";
import { type Tx, withActorScope } from "@/lib/db";
import { lockProjectPreviewNamespaces } from "@/lib/projects/preview-namespace-lock";
import {
	type ChartWorkloadKind,
	type ComponentStatus,
	jobs,
	projectAddons,
	projectChartWorkloads,
	projectEnvironments,
	projectHelmRegistries,
	projectPreviewConfig,
} from "@/lib/db/schema";
import { placementNamespacesOnFabric } from "@/lib/queries/placement-host-namespaces";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { parseValuesYaml } from "@/lib/addons/catalog";
import { inferValuePaths } from "@/lib/addons/chart-overlay";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";
import { notifyScaler } from "@/lib/scaler";
import { replaceServiceBindings } from "@/lib/db/service-bindings-sync";
import {
	chartWorkloadBindingsSchema,
	chartWorkloadConfigSchema,
	chartWorkloadValuePathsSchema,
} from "@/lib/validations/chart-workloads";
import {
	byoChartAttachSchema,
	byoChartAttachSchemaFor,
	byoChartNamespace,
	byoPreviewNamespaceMessage,
	type ByoChartAttachInput,
} from "@/lib/validations/byo-charts";
import { chartSlug } from "@/lib/validations/names";
import type {
	AddOnValues,
	ChartValuePathMap,
	ChartWorkloadConfig,
	ChartWorkloadRendered,
	ServiceBinding,
	VerifyReport,
} from "@/types/jsonb.types";

/** Throws if the feature is disabled — every mutating BYO action calls this first. */
function assertByoHelmEnabled(): void {
	if (!isByoHelmEnabled()) {
		throw new ActionRefusal(
			"conflict",
			"Bring-your-own Helm charts are not enabled on this instance (set ALETHIA_BYO_HELM_ENABLED=true).",
		);
	}
}

/** An attached BYO chart as the canvas reads it back (one per chart node). */
export interface ByoChartState {
	id: string;
	repoUrl: string;
	chartPath: string;
	ref: string;
	namespace: string;
	values: AddOnValues;
	valuesYaml: string | null;
	status: ComponentStatus;
	health: string | null;
	sync: string | null;
	lastSyncedAt: string | null;
	/** Chart-safety scan lifecycle: unscanned | scanning | done | failed. */
	scanStatus: string;
	/** The elench verify.Report over the chart's rendered manifests (null until the first scan). */
	scanReport: VerifyReport | null;
	scannedAt: string | null;
}

/**
 * Attaches (or reconfigures) a BYO Helm chart on an environment. Upserts a source='byo'
 * project_addons row as PENDING so the next DEPLOY renders it. `id` is a stable per-env slug
 * (the chart node's id); re-attaching the same id updates it in place.
 *
 * `repoUrl` is a git remote (https://…/git@…) OR an `oci://<host>/<ns>/<chart>` reference to a
 * private OCI Helm registry. For git the chart lives at `chartPath` and `ref` is a git ref; for OCI
 * the chart name is the URL's last segment (no `chartPath`) and `ref` is the chart version.
 */
export async function attachByoChart(
	input: ByoChartAttachInput,
): Promise<{ ok: true; id: string }> {
	assertByoHelmEnabled();
	const parsed = byoChartAttachSchema.parse(input);
	const actor = await authorize("edit", { type: "project", id: parsed.projectId });

	const id = chartSlug(parsed.id);
	const repoUrl = parsed.repoUrl;
	const isOci = repoUrl.startsWith("oci://");
	// git charts live at a path within the repo; OCI charts are named by the URL's last segment.
	const chartPath = isOci ? null : (parsed.chartPath ?? "").replace(/^\/+/, "");

	const valuesYaml = parsed.valuesYaml?.trim() ? parsed.valuesYaml : null;
	if (valuesYaml && !parseValuesYaml(valuesYaml)) {
		const refusal = "Advanced values must be valid YAML describing a mapping (key: value).";
		throw new FieldRefusal({ valuesYaml: [refusal] }, refusal);
	}

	const envId = await resolveActiveEnvironmentId(parsed.projectId, parsed.environmentId);
	// The `byo-` prefix rule needs the chart's stored namespace: a re-attach may keep it unchanged
	// even when it is a `byo-` name that is not the chart's own (attached before the rule), while a
	// newly chosen `byo-` name is refused. Read from the database, never from the request.
	const [stored] = await withActorScope(actor, (tx) =>
		tx
			.select({ namespace: projectAddons.namespace })
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, parsed.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, id),
					eq(projectAddons.source, "byo"),
				),
			)
			.limit(1),
	);
	byoChartAttachSchemaFor(stored?.namespace ?? null).parse(input);
	// `version` holds the git ref for a git chart, or the chart version for an OCI chart
	// (`*` = latest, an ArgoCD-supported Helm targetRevision).
	const ref = parsed.ref || (isOci ? "*" : "HEAD");
	// A chart runs in its own namespace unless it names one (#6446). "default" is reserved for the
	// platform's own workloads, and the schema above refuses it.
	const namespace = parsed.namespace || byoChartNamespace(id);
	const values: AddOnValues = parsed.values ?? {};

	await withActorScope(actor, async (tx) => {
		// The preview-namespace check and the write share one transaction under the project's lock, so
		// a concurrent preview-prefix save cannot slip a conflicting prefix in between (#6494).
		await lockProjectPreviewNamespaces(tx, parsed.projectId);
		await refusePreviewNamespace(tx, parsed.projectId, namespace, stored?.namespace ?? null);
		await refusePlacementNamespace(tx, parsed.projectId, envId, namespace, stored?.namespace ?? null);
		await tx
			.insert(projectAddons)
			.values({
				project_id: parsed.projectId,
				environment_id: envId,
				addon_id: id,
				source: "byo",
				chart_repo: repoUrl,
				chart_path: chartPath,
				git_credential_id: parsed.gitCredentialId ?? null,
				enabled: true,
				mode: "managed",
				version: ref,
				values,
				values_yaml: valuesYaml,
				namespace,
				status: "PENDING",
			})
			.onConflictDoUpdate({
				target: [projectAddons.project_id, projectAddons.environment_id, projectAddons.addon_id],
				set: {
					source: "byo",
					chart_repo: repoUrl,
					chart_path: chartPath,
					git_credential_id: parsed.gitCredentialId ?? null,
					enabled: true,
					mode: "managed",
					version: ref,
					values,
					values_yaml: valuesYaml,
					namespace,
					status: "PENDING",
					updated_at: new Date(),
				},
			});
	});

	// Auto-queue a safety scan so the user sees any issues right after attaching (best-effort — a
	// scan-queue failure must never fail the attach itself). Both chart sources scan: the runner
	// resolves a git chart by cloning and an OCI chart by pulling it from the registry (#1300).
	try {
		await scanByoChart({ projectId: parsed.projectId, environmentId: envId, id });
	} catch {
		/* ignore — the chart is attached; the user can re-run the scan from the node */
	}
	return { ok: true, id };
}

/**
 * Refuses, as a `namespace` field error, a chart namespace that is one of the project's preview
 * namespaces (#6494, {@link byoPreviewNamespaceMessage}). Checked on the namespace the chart will be
 * STORED with — a blank field's `byo-<chart id>` included — against the project's stored preview
 * prefix, which only the server can read. Runs in the write's transaction, under
 * lockProjectPreviewNamespaces.
 *
 * A re-attach that keeps the chart's stored namespace unchanged is not refused, the same exception the
 * `byo-` rule makes: a chart attached there before this rule keeps deploying (the runner reports it on
 * the Deploy tab instead), and refusing every edit to it would leave its values unchangeable without
 * moving it.
 */
async function refusePreviewNamespace(
	tx: Tx,
	projectId: string,
	namespace: string,
	storedNamespace: string | null,
): Promise<void> {
	if (storedNamespace !== null && namespace === storedNamespace) return;
	const [preview] = await tx
		.select({ namespace_prefix: projectPreviewConfig.namespace_prefix })
		.from(projectPreviewConfig)
		.where(eq(projectPreviewConfig.project_id, projectId))
		.limit(1);
	const message = byoPreviewNamespaceMessage(namespace, preview?.namespace_prefix);
	if (message) throw new FieldRefusal({ namespace: [message] }, message);
}

/**
 * Refuses, as a `namespace` field error, a chart namespace that a live namespace placement on the
 * environment's Fabric resolves to (#6562), naming that environment. The reverse of #6551, which
 * refuses a placement the namespace a host chart chose: a chart there would share the placement's
 * namespace, and so its hardened AppProject and everything the placement's own workloads can reach.
 * The placements and their effective namespaces are #6551's (placementNamespacesOnFabric), so the
 * two directions cannot disagree about what a placement holds. The runner refuses it again at deploy,
 * from the Namespace's labels on the cluster.
 *
 * A re-attach that keeps the chart's stored namespace unchanged is not refused, the same exception the
 * preview rule makes: a chart attached there before this rule keeps deploying (the runner reports it
 * on the Deploy tab instead), and refusing every edit to it would leave its values unchangeable without
 * moving it. An environment with no Fabric shares no cluster, so nothing is held there.
 */
async function refusePlacementNamespace(
	tx: Tx,
	projectId: string,
	environmentId: string,
	namespace: string,
	storedNamespace: string | null,
): Promise<void> {
	if (storedNamespace !== null && namespace === storedNamespace) return;
	const [env] = await tx
		.select({ fabric_id: projectEnvironments.fabric_id })
		.from(projectEnvironments)
		.where(and(eq(projectEnvironments.id, environmentId), eq(projectEnvironments.project_id, projectId)))
		.limit(1);
	if (!env?.fabric_id) return;
	const placements = await placementNamespacesOnFabric(tx, projectId, env.fabric_id);
	const holder = placements.find((p) => p.namespace === namespace);
	if (!holder) return;
	const message = `Namespace “${namespace}” is used by the namespace-placed environment “${holder.environment}” on this cluster. A bring-your-own chart needs a namespace of its own; choose another, or leave it blank.`;
	throw new FieldRefusal({ namespace: [message] }, message);
}

/** Detaches a BYO chart (deletes its row); the runner prunes it on the next DEPLOY. */
export async function detachByoChart(input: {
	projectId: string;
	environmentId?: string | null;
	id: string;
}): Promise<{ ok: true }> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", { type: "project", id: input.projectId });
	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
	await withActorScope(actor, async (tx) => {
		await tx
			.delete(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, chartSlug(input.id)),
					eq(projectAddons.source, "byo"),
				),
			);
	});
	return { ok: true };
}

/** A DESCRIBED chart workload as the canvas reads it back (W5 Path A). */
export interface ChartWorkloadState {
	id: string;
	/** The owning chart node (project_addons.addon_id slug) these group under. */
	chartId: string;
	name: string;
	kind: ChartWorkloadKind;
	/** Read-only description from `helm template` (image/ports/env keys/resources/replicas). */
	rendered: ChartWorkloadRendered;
	/** W3 bindings + the editable overlay — preserved across re-scans (empty until the bind lane). */
	bindings: ServiceBinding[];
	config: ChartWorkloadConfig;
	/** Logical knob → chart-values dot-path (inferred at scan, user-overridable). */
	valuePaths: ChartValuePathMap;
}

/**
 * Updates one described workload's overlay (config / value_paths), scoped to the caller's project.
 * `authorize("edit", project)` + RLS-scoped tx; the workload is matched by id AND project so a
 * cross-project id can never be written. Throws if the workload doesn't belong to the project.
 */
async function updateChartWorkloadOverlay(
	projectId: string,
	workloadId: string,
	patch: Partial<{ config: ChartWorkloadConfig; value_paths: ChartValuePathMap }>,
): Promise<void> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", { type: "project", id: projectId });
	await withActorScope(actor, async (tx) => {
		const [row] = await tx
			.update(projectChartWorkloads)
			.set({ ...patch, updated_at: new Date() })
			.where(
				and(
					eq(projectChartWorkloads.id, workloadId),
					eq(projectChartWorkloads.project_id, projectId),
					// Bound to the actor's org as well as the project: the PDP's answer for an org-wide
					// role does not bind the project id it was asked about.
					eq(projectChartWorkloads.org_id, actor.orgId),
				),
			)
			.returning({ id: projectChartWorkloads.id });
		if (!row) throw new ActionRefusal("not-found", "Chart workload not found");
	});
}

/** Sets a described workload's editable config (v1: replicas + env), written to the chart on deploy. */
export async function setChartWorkloadConfig(input: {
	projectId: string;
	workloadId: string;
	config: ChartWorkloadConfig;
}): Promise<{ ok: true }> {
	const config = chartWorkloadConfigSchema.parse(input.config);
	await updateChartWorkloadOverlay(input.projectId, input.workloadId, {
		config,
	});
	return { ok: true };
}

/**
 * Overrides a described workload's value-paths (logical knob → chart-values dot-path) — the user's
 * correction of the inferred defaults.
 */
export async function setChartWorkloadValuePaths(input: {
	projectId: string;
	workloadId: string;
	valuePaths: ChartValuePathMap;
}): Promise<{ ok: true }> {
	const value_paths = chartWorkloadValuePathsSchema.parse(input.valuePaths);
	await updateChartWorkloadOverlay(input.projectId, input.workloadId, {
		value_paths,
	});
	return { ok: true };
}

/**
 * Sets a described workload's W3 bindings, merging inferred value-paths for any new credential facet
 * (existing user paths win — an override is never clobbered). The binding write-back to the chart's
 * values is runner-side (Lane 2b); this records the declared bindings + where each credential ref
 * will land, so nothing is composed with a plaintext credential console-side.
 */
export async function setChartWorkloadBindings(input: {
	projectId: string;
	workloadId: string;
	bindings: ServiceBinding[];
}): Promise<{ ok: true }> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", {
		type: "project",
		id: input.projectId,
	});
	const bindings = chartWorkloadBindingsSchema.parse(input.bindings);
	await withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({
				rendered: projectChartWorkloads.rendered,
				config: projectChartWorkloads.config,
				value_paths: projectChartWorkloads.value_paths,
			})
			.from(projectChartWorkloads)
			.where(
				and(
					eq(projectChartWorkloads.id, input.workloadId),
					eq(projectChartWorkloads.project_id, input.projectId),
					eq(projectChartWorkloads.org_id, actor.orgId),
				),
			)
			.limit(1);
		if (!row) throw new ActionRefusal("not-found", "Chart workload not found");
		const inferred = inferValuePaths({
			rendered: row.rendered,
			config: row.config,
			bindings,
		});
		const value_paths: ChartValuePathMap = { ...inferred, ...row.value_paths };
		await tx
			.update(projectChartWorkloads)
			.set({ value_paths, updated_at: new Date() })
			.where(
				and(
					eq(projectChartWorkloads.id, input.workloadId),
					eq(projectChartWorkloads.project_id, input.projectId),
				),
			);
		// The bindings JSONB was dropped in the contract phase (#1426); service_bindings is the store.
		// This is a granular UPDATE (not delete-all-reinsert), so replace this workload's binding rows.
		await replaceServiceBindings(
			tx,
			{ chart_workload_id: input.workloadId },
			bindings,
		);
	});
	return { ok: true };
}

/** The refusal for scanning a chart that is not attached to the environment. */
const CHART_NOT_ATTACHED = "Chart not found (attach it before scanning).";

/** Reports whether a chart_repo value addresses an OCI registry rather than a git repository. */
function isOciChartRepo(chartRepo: string): boolean {
	return chartRepo.trim().toLowerCase().startsWith("oci://");
}

/**
 * Queues a CHART_SCAN job for an attached BYO chart: the runner resolves the chart to a local
 * directory (git clone, or an OCI registry pull), `helm template`s it, and runs
 * verify.EvaluateManifests over the rendered manifests, posting a verify.Report that
 * finalizeChartScan writes back onto the row. Marks the row `scanning` immediately so the UI can
 * show progress. The job's config_snapshot carries the chart coords (repo_url so the runner's
 * git-token route resolves a token) + the row identity so the result maps back.
 *
 * For an OCI chart there is no chart_path (the repository path IS the chart), and the pull may need
 * the project's private chart-repo credential. The snapshot therefore carries the environment's
 * `helm_registries` selections — their non-secret provider config only. The claim route reads that
 * same key to attach the DECRYPTED credential out-of-band, so the secret half never touches the
 * snapshot (and so never reaches the job row, the logs, or the sandbox).
 */
export async function scanByoChart(input: {
	projectId: string;
	environmentId?: string | null;
	id: string;
}): Promise<{ ok: true; jobId: string }> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", { type: "project", id: input.projectId });
	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
	const id = chartSlug(input.id);

	await assertJobQuotaAllowed(actor.orgId);
	const jobId = await withActorScope(actor, async (tx) => {
		// The scan is filed on its project (project_id, #6121), and a job of a project belongs to that
		// project's org — the database refuses any other stamp. Say so in a sentence first.
		await refuseProjectOfAnotherOrg(tx, input.projectId, actor);
		const [row] = await tx
			.select()
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, id),
					eq(projectAddons.source, "byo"),
				),
			)
			.limit(1);
		if (!row || !row.chart_repo) {
			throw new ActionRefusal("not-found", CHART_NOT_ATTACHED);
		}
		const isOci = isOciChartRepo(row.chart_repo);
		// A git chart needs a directory inside the repo; an OCI chart's repository path IS the chart.
		if (!isOci && !row.chart_path) {
			throw new ActionRefusal("not-found", CHART_NOT_ATTACHED);
		}

		// The environment's connected chart repos — non-secret provider config only. The runner
		// matches the chart's host against these the same way ArgoCD matches an Application to a
		// repository credential, so the scan authenticates against exactly the repo the deploy will.
		const helmRegistries = isOci
			? (
					await tx
						.select({
							name: projectHelmRegistries.name,
							provider: projectHelmRegistries.provider,
							provider_config: projectHelmRegistries.provider_config,
						})
						.from(projectHelmRegistries)
						.where(
							and(
								eq(projectHelmRegistries.project_id, input.projectId),
								eq(projectHelmRegistries.environment_id, envId),
							),
						)
				).map((r) => ({
					name: r.name,
					provider: r.provider,
					provider_config: r.provider_config ?? {},
				}))
			: [];

		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				org_id: actor.orgId,
				job_type: "CHART_SCAN",
				// The project the scan acts on, in the column as well as the snapshot: job visibility
				// and the cancel permission read the column (lib/jobs/visibility.ts, operation.ts).
				project_id: input.projectId,
				initiated_by: "user",
				status: "QUEUED",
				config_snapshot: {
					// repo_url (not chart_repo) so the runner's FetchGitToken route resolves a token.
					repo_url: row.chart_repo,
					chart_path: row.chart_path,
					// Carries a git ref for a git chart and a chart version for an OCI one. "*" is
					// Helm's "latest release", which is also what the deploy path sends ArgoCD.
					ref: row.version ?? (isOci ? "*" : "HEAD"),
					values: row.values ?? {},
					// Read by the claim route to attach the decrypted chart-repo credential.
					...(isOci ? { helm_registries: helmRegistries } : {}),
					// Row identity for finalizeChartScan → the result maps back to this chart.
					project_id: input.projectId,
					environment_id: envId,
					addon_id: id,
				},
			}))
			.returning({ id: jobs.id });
		await tx
			.update(projectAddons)
			.set({ scan_status: "scanning", updated_at: new Date() })
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, id),
				),
			);
		return job.id;
	});
	notifyScaler();
	return { ok: true, jobId };
}

// The CHART_SCAN write-back (finalizeChartScan) lives in lib/addons/chart-scan-finalize.ts: it is the
// job-status route's service-role seam, and as an export of this `"use server"` file it was a public
// Server Action (#5219).

// ── The console's mutation contract (ADR 0005 §D4, #6119) ───────────────────────────────────────
//
// The Architecture board calls these, through `useActionMutation`, never the functions above
// directly: each parses its input, runs the SAME function the CLI routes call (so every flag,
// authorize, environment-resolution and org check above is the one that runs), and answers an
// `ActionResult` whose refusals the board renders by kind. Each is a plain async function whose body
// builds its contract inline, so the action-boundary guard can follow it to `authorize`.

const uuid = z.string().uuid();

const chartTargetInput = z.object({
	projectId: uuid,
	environmentId: uuid.nullable().optional(),
	id: z.string().trim().min(1).max(128),
});

/** Attaches (or reconfigures) a BYO chart and queues its first scan; answers the chart's id. */
export async function attachByoChartAction(raw: z.input<typeof byoChartAttachSchema>) {
	return defineAction({
		input: byoChartAttachSchema,
		run: async ({ input }) => {
			const { id } = await refusingCanvasWrite(() => attachByoChart(input));
			return { id };
		},
	})(raw);
}

/** Detaches a BYO chart (pruned on the next Deploy); answers the chart's id. */
export async function detachByoChartAction(raw: z.input<typeof chartTargetInput>) {
	return defineAction({
		input: chartTargetInput,
		run: async ({ input }) => {
			await refusingCanvasWrite(() => detachByoChart(input));
			return { id: input.id };
		},
	})(raw);
}

/** Queues a safety scan of an attached BYO chart; answers the queued job. */
export async function scanByoChartAction(raw: z.input<typeof chartTargetInput>) {
	return defineAction({
		input: chartTargetInput,
		run: async ({ input }) => {
			const { jobId } = await refusingCanvasWrite(() => scanByoChart(input));
			return { jobId };
		},
	})(raw);
}

const workloadOverlayInput = z.object({
	projectId: uuid,
	workloadId: uuid,
	bindings: chartWorkloadBindingsSchema.optional(),
	config: chartWorkloadConfigSchema.optional(),
	valuePaths: chartWorkloadValuePathsSchema.optional(),
});

/**
 * Saves the parts of a described workload's overlay that changed — one ACTION for the panel's one
 * Save, which runs up to three setters in turn, each in its own transaction. It is NOT atomic: a
 * refusal part-way (the workload is gone) leaves the parts before it saved, and the panel shows the
 * refusal. Bindings first: they infer and merge value-paths for a new binding, so an explicit
 * value-path override in the same save must run after them to win.
 */
export async function saveChartWorkloadOverlayAction(raw: z.input<typeof workloadOverlayInput>) {
	return defineAction({
		input: workloadOverlayInput,
		run: async ({ input }) => {
			const target = { projectId: input.projectId, workloadId: input.workloadId };
			const { bindings, config, valuePaths } = input;
			await refusingCanvasWrite(async () => {
				if (bindings) await setChartWorkloadBindings({ ...target, bindings });
				if (config) await setChartWorkloadConfig({ ...target, config });
				if (valuePaths) await setChartWorkloadValuePaths({ ...target, valuePaths });
			});
			return { workloadId: input.workloadId };
		},
	})(raw);
}
