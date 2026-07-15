// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The SERVER-truth half of a canvas node's status — the shapes only, so client components can
// import them without pulling in a "use server" module. The query lives in
// app/server/actions/component-status.ts; the resolver that merges this with the client-side
// design readiness lives in lib/canvas/node-status.ts.

import type { ComponentStatus } from "@/lib/db/schema/enums";
import type { DriftDetail } from "@/types/jsonb.types";
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
	/** ArgoCD health, for components that are Applications (add-ons / charts). */
	health?: string | null;
	/** ArgoCD sync state. */
	sync?: string | null;
}

/** The environment's in-flight job — env-wide context, not a per-node state. */
export interface ActiveJob {
	id: string;
	type: string;
	status: string;
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
	/**
	 * The BYO IaC module governing this environment, or null for a template env. When present, the
	 * component design is inert and `iac.groups` — not `components` — is the architecture.
	 */
	iac: IacEnvironment | null;
}

/** The empty status — an environment that has never been deployed (or one we couldn't read). */
export const EMPTY_ENVIRONMENT_STATUS: EnvironmentStatus = {
	components: {},
	activeJob: null,
	updatePending: false,
	probe: null,
	unattributedDrift: [],
	driftScannedAt: null,
	monthlyCost: null,
	costCapturedAt: null,
	iac: null,
};
