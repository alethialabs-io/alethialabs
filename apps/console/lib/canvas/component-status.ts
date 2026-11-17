// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The SERVER-truth half of a canvas node's status — the shapes only, so client components can
// import them without pulling in a "use server" module. The query lives in
// app/server/actions/component-status.ts; the resolver that merges this with the client-side
// design readiness lives in lib/canvas/node-status.ts.

import type {
	ComponentStatus,
	EnvironmentStage,
	ProjectStatus,
	ProvisionJobStatus,
	ProvisionJobType,
} from "@/lib/db/schema/enums";
import type { DriftDetail } from "@/types/jsonb.types";
import type { GitopsDeployStatus } from "@/lib/gitops/deploy-status";
import type { PlanSummary } from "@/lib/plan/parse-plan";
import type { IacGroup } from "./iac-inventory";

/**
 * The bring-your-own IaC module governing this environment, when one does (v1 "replace mode":
 * the module, not the component design, is the source of truth). Null for a template env.
 */
export interface IacEnvironment {
	/** The attached module: where it comes from, whether it's safe, and what's live. */
	source: {
		repoUrl: string;
		ref: string | null;
		path: string;
		/** The commit the last successful scan pinned — what a deploy would apply. */
		commitSha: string | null;
		/** The commit the last successful DEPLOY applied. Null = never deployed. */
		deployedCommitSha: string | null;
		/** unscanned | scanning | done | failed. */
		scanStatus: string;
		/**
		 * The safety gate's verdict. `false` means the module is REJECTED and will not provision.
		 * `null` means never scanned — an honest unknown, not a pass.
		 */
		scanOk: boolean | null;
		/** The module's own provisioning lifecycle (project_iac_sources.status). */
		status: ComponentStatus;
		statusMessage: string | null;
	};
	/**
	 * The module's architecture as external cards. Empty when it has been neither scanned by a
	 * W8-or-later runner nor planned — in which case the board says so rather than drawing nothing
	 * and implying the module is empty.
	 */
	groups: IacGroup[];
	/**
	 * Monthly cost per Terraform address, from the last PLAN's Infracost breakdown. This is what lets
	 * a card's panel answer "which of these resources costs the money", not just "this group costs
	 * $40". An address absent here was never priced (free, or unpriceable) — which is NOT $0, so the
	 * panel says nothing rather than a confident zero.
	 */
	costByAddress: Record<string, number>;
	/**
	 * The module's ROOT output NAMES (IacScanReport.outputs), the choices the service bind sheet
	 * offers when a service binds to a BYO-IaC resource (#823) — each facet maps to one of these
	 * (the deploy-time tofu-output keys). Empty when the module was scanned before output capture
	 * or exports none — the picker then has no candidates rather than fabricating any.
	 */
	outputs: string[];
}

/**
 * The `components` key an external card is joined on — the BYO-IaC arm of `nodeStatusKey()`.
 *
 * It lives HERE, not beside the query, because `app/server/actions/component-status.ts` is a
 * `"use server"` module: every export from one of those must be an async function, so a plain string
 * helper cannot live there (the Next build rejects it — `tsc`, lint and vitest all pass regardless,
 * so the build is the only thing that catches it).
 */
export function externalStatusKey(groupKey: string): string {
	return `external:${groupKey}`;
}

/** What the server knows about ONE provisioned component. */
export interface ComponentServerStatus {
	/** The component row's lifecycle (PENDING … DESTROYED). */
	lifecycle: ComponentStatus;
	/** `status_message` — why it failed, when it did. */
	message: string | null;
	/** Drifted resources attributed to this component. Empty when in sync. */
	drift: DriftDetail[];
	/**
	 * What the deploy actually PRODUCED — the connection details you'd otherwise open the cloud
	 * console to find. Every one of these columns (`endpoint`, `reader_endpoint`, `cluster_endpoint`,
	 * `argocd_url`, `repository_url`) is written by the deploy finalizer and, until now, was shown
	 * nowhere in the product.
	 */
	outputs?: { label: string; value: string }[];
	/** What this component costs per month, from the last PLAN's Infracost breakdown. */
	monthlyCost?: number | null;
	/** The per-resource cost lines that make up `monthlyCost` — the itemised breakdown the Cost tab
	 * shows (Terraform address → monthly). Empty/absent when the node was never priced. */
	costLines?: { address: string; monthlyCost: number }[];
	/** ArgoCD health, for components that are Applications (add-ons / charts). */
	health?: string | null;
	/** ArgoCD sync state. */
	sync?: string | null;
}

/** One job in the environment's recent history — the Activity tab / Overview "recent activity". */
export interface EnvironmentJob {
	id: string;
	type: ProvisionJobType;
	status: ProvisionJobStatus;
	/** ISO timestamp the job was created. */
	createdAt: string;
}

/**
 * The concrete environment the canvas is viewing — its real name, stage, and provisioning status
 * from `project_environments`. This is what the project-settings panel binds to: the stage is a FACT
 * of the environment you're on, not a free-choice radio. Null in the create flow (no env row yet).
 */
export interface EnvironmentInfo {
	id: string;
	name: string;
	stage: EnvironmentStage;
	status: ProjectStatus;
}

/** The environment's in-flight job — env-wide context, not a per-node state. */
export interface ActiveJob {
	id: string;
	type: ProvisionJobType;
	status: ProvisionJobStatus;
}

/**
 * Where the saved design stands against what the environment last deployed:
 * - `never`: the environment has no deployed design.
 * - `ahead`: the saved design differs from the deployed one.
 * - `in-sync`: the saved design is the deployed one.
 */
export type DeployState = "never" | "ahead" | "in-sync";

/**
 * The deploy state from the two fingerprints the environment status read compares: the one stored
 * at the last deploy (`project_environments.deployed_config_hash`) and the saved design's
 * (`structuralHash`). A null `designHash` means the saved design could not be read; a deployed
 * environment then reads `in-sync`, the same answer `updatePending` gives for it.
 *
 * The fingerprint is `structuralHash`, which leaves out sizing and placement fields
 * (lib/promotions/diff.ts), so a saved change to one of those alone reads `in-sync`.
 */
export function resolveDeployState(deployedHash: string | null, designHash: string | null): DeployState {
	if (!deployedHash) return "never";
	if (designHash === null) return "in-sync";
	return designHash === deployedHash ? "in-sync" : "ahead";
}

/**
 * Why the environment may not be planned or deployed, whatever its {@link DeployState}. `message`
 * is the sentence to show.
 * - `cloud-not-offered`: the project's cloud account is on a cloud this deployment does not offer.
 */
export interface DeployRefusal {
	reason: "cloud-not-offered";
	message: string;
}

/**
 * Why the environment's latest plan is not the one to deploy:
 * - `no-plan`: the environment has no plan job.
 * - `plan-not-succeeded`: the latest plan job is queued, running, failed or cancelled.
 * - `design-changed`: the design was saved after the plan was queued.
 * - `run-since-plan`: a build, deploy or destroy of the environment was queued after the plan.
 */
export type PlanStaleReason = "no-plan" | "plan-not-succeeded" | "design-changed" | "run-since-plan";

/** What {@link planStaleReason} decides from. */
export interface PlanCurrencyFacts {
	/** The latest plan job's status; null when the environment has no plan job. */
	status: ProvisionJobStatus | null;
	/** The design revision the plan was queued at; null when it is not known. */
	planRevision: string | null;
	/** The saved design's revision now. */
	savedRevision: string;
	/** True when a build, deploy or destroy of the environment was queued after the plan. */
	runSincePlan: boolean;
}

/**
 * The staleness rule: the reason the latest plan is not current, or null when it is. A plan is
 * current when it succeeded, its design revision equals the saved design's revision, and no build,
 * deploy or destroy of the environment was queued after it. The reasons are checked in that order,
 * and an unknown plan revision is `design-changed`.
 */
export function planStaleReason(facts: PlanCurrencyFacts): PlanStaleReason | null {
	if (facts.status === null) return "no-plan";
	if (facts.status !== "SUCCESS") return "plan-not-succeeded";
	if (facts.planRevision === null || facts.planRevision !== facts.savedRevision) return "design-changed";
	if (facts.runSincePlan) return "run-since-plan";
	return null;
}

/**
 * The environment's latest plan as the board's review reads it (`canvas.reviewPlan`). The three
 * values a deploy of this plan carries are `planJobId`, `designRevision` and `digest`.
 *
 * A design revision is the id of the project's latest design-write audit row (`audit_log`, actions
 * CREATED and UPDATED), as a decimal string; `"0"` when there is none. It moves on every design
 * save that goes through `updateProjectDesign`: the board's save and the CLI design route. It does
 * not move on a write to one component row from the CLI's component routes, or on an add-on
 * change. It is not the client's `designRevision` content hash (lib/canvas/design-revision.ts).
 */
export interface ReviewPlan {
	/** The environment the answer is for. */
	environmentId: string;
	/** The latest PLAN job of the environment, whatever its status; null when there is none. */
	planJobId: string | null;
	/** That job's status; null when there is none. */
	status: ProvisionJobStatus | null;
	/** ISO timestamp the plan job was queued; null when there is none. */
	createdAt: string | null;
	/** What the plan would add, change, destroy and replace; null until the job stores a plan result. */
	summary: PlanSummary["counts"] | null;
	/** The monthly cost priced from THIS plan job; null when it was never priced. */
	cost: { totalMonthly: number | null; currency: string } | null;
	/** The design revision the plan was queued at; null when there is no plan job. */
	designRevision: string | null;
	/** The saved design's revision now. */
	savedRevision: string;
	/**
	 * The SHA-256 of the plan file, lowercase hex, from the plan job's verify receipt
	 * (`plan_sha256`); null when the job has no receipt or the receipt's value is not a SHA-256.
	 */
	digest: string | null;
	/** True when {@link planStaleReason} finds no reason: this is the plan to deploy. */
	current: boolean;
	/** Why the plan is not current; null when it is. */
	staleReason: PlanStaleReason | null;
}

/**
 * Everything the canvas needs to resolve live status for one environment, in a single round-trip.
 * Keyed by `nodeStatusKey()` (kind for singletons, `kind:name` for array kinds) — the join key the
 * canvas was always designed for.
 */
export interface EnvironmentStatus {
	components: Record<string, ComponentServerStatus>;
	/** The env's queued/running job, if any. */
	activeJob: ActiveJob | null;
	/** True when the design has moved ahead of what was last deployed (structuralHash mismatch). */
	updatePending: boolean;
	/** The saved design against the deployed one. `updatePending` is true exactly when this is `ahead`. */
	deployState: DeployState;
	/** Why this environment may not be planned or deployed; null when nothing refuses it. */
	deployRefusal: DeployRefusal | null;
	/** Cluster liveness (PROBE_CLUSTER). `reachable: null` = never probed. */
	probe: { reachable: boolean | null; message: string | null } | null;
	/** Drifted resources we could not place on a node. Surfaced at the environment — never dropped. */
	unattributedDrift: DriftDetail[];
	/** When drift was last scanned; null when it never has been. */
	driftScannedAt: string | null;
	/**
	 * What this environment costs per month, from its last PLAN. Null = never priced, which is an
	 * honest "we don't know yet" rather than a misleading zero.
	 */
	monthlyCost: number | null;
	/** The plan the cost came from, so the UI can say WHEN this was true. */
	costCapturedAt: string | null;
	/** The environment's most recent jobs (newest first) — the Activity tab + Overview recent-activity. */
	recentJobs: EnvironmentJob[];
	/** The concrete environment being viewed (name/stage/status). Null in the create flow. */
	environment: EnvironmentInfo | null;
	/**
	 * The BYO IaC module governing this environment, or null for a template env. When present, the
	 * component design is inert and `iac.groups` — not `components` — is the architecture.
	 */
	iac: IacEnvironment | null;
	/**
	 * GitOps wiring + per-component ArgoCD health (#574) — the same read model the Deploy tab
	 * shows, riding this same read so canvas badges and the tab can never disagree. Null when the
	 * environment could not be read.
	 */
	gitops: GitopsDeployStatus | null;
}

/** The empty status — an environment that has never been deployed (or one we couldn't read). */
export const EMPTY_ENVIRONMENT_STATUS: EnvironmentStatus = {
	components: {},
	activeJob: null,
	updatePending: false,
	deployState: "never",
	deployRefusal: null,
	probe: null,
	unattributedDrift: [],
	driftScannedAt: null,
	monthlyCost: null,
	costCapturedAt: null,
	recentJobs: [],
	environment: null,
	iac: null,
	gitops: null,
};
