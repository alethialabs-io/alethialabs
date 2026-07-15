// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The guards that stand between an automated sweep and someone's production infrastructure.
//
// Context, because it is the whole reason this file is paranoid: the Hetzner account that runs test
// clusters is the SAME account that runs prod. An unfiltered delete loop over it once came within one
// command of destroying prod `alethia-data`. So the rule here is absolute — a resource is deleted only
// when EVERY guard passes, and a guard that cannot evaluate its input REFUSES rather than assumes.
//
// Nothing about "the adapter said so" is trusted. The adapter lists; this decides.

import type {
	CloudResourceRef,
	LabelSelector,
	ReclaimDecision,
} from "./types";

/** Kill switch. Set to "0"/"false" to make every sweep report-only, deleting nothing, everywhere. */
export function reclaimEnabled(): boolean {
	const raw = (process.env.ALETHIA_ORPHAN_RECLAIM ?? "").trim().toLowerCase();
	// Empty/unset ⇒ OFF. Auto-deleting infrastructure is opt-in, never a default a deploy can drift into.
	return raw === "1" || raw === "true";
}

/**
 * A selector must exist and be specific enough that it CANNOT match another cluster's resources. An
 * empty or trivially-short value would be a filter that filters nothing — the exact shape of the
 * account-wide delete this whole design exists to prevent. Refuse to build a sweep without one.
 */
export function assertUsableSelector(
	selector: LabelSelector | null | undefined,
): asserts selector is LabelSelector {
	if (!selector || !selector.key || !selector.value) {
		throw new Error(
			"orphan reclaim: refusing to sweep without a label selector (no selector ⇒ no filter ⇒ account-wide delete)",
		);
	}
	// Cluster names are generated (project+env+suffix). Anything this short is not one, and would risk
	// matching by accident.
	if (selector.value.trim().length < 8) {
		throw new Error(
			`orphan reclaim: refusing to sweep on an implausibly broad selector ${selector.key}=${selector.value}`,
		);
	}
}

/** Inputs the decision is made against. Every field is required — none may be inferred. */
export interface ReclaimContext {
	selector: LabelSelector;
	/** Native ids present in the tofu state file. A resource in state is tofu's to manage, never ours. */
	stateNativeIds: ReadonlySet<string>;
	/** When the job that may have orphaned these resources started. Nothing older can be its orphan. */
	jobStartedAt: Date;
}

/**
 * Decides one resource. Order matters only for the quality of the audit reason; every guard must pass.
 *
 * The guards, and why each exists:
 *  1. LABEL     — the resource must carry the exact selector the cloud returned. Re-checked here even
 *                 though the adapter filtered server-side: a list bug must not become a delete bug.
 *  2. NOT-IN-STATE — a resource tofu tracks is not an orphan. Deleting it behind tofu's back would
 *                 corrupt the state we are trying to protect, and a normal destroy already handles it.
 *  3. CREATED-AFTER — the resource must be YOUNGER than the job that supposedly created it. This is the
 *                 guard that makes pre-existing infrastructure unsweepable no matter what else goes
 *                 wrong upstream. An unknown creation time REFUSES (we cannot prove it is ours).
 */
export function decide(
	resource: CloudResourceRef,
	ctx: ReclaimContext,
): ReclaimDecision {
	const keep = (reason: string): ReclaimDecision => ({
		resource,
		action: "keep",
		reason,
	});

	if (resource.labels[ctx.selector.key] !== ctx.selector.value) {
		// The adapter returned something outside the selector. That is a bug in the adapter — but it is
		// caught here, where it is harmless, instead of in the cloud, where it is not.
		return keep(
			`label mismatch: ${ctx.selector.key}=${resource.labels[ctx.selector.key] ?? "<absent>"} ≠ ${ctx.selector.value}`,
		);
	}

	if (ctx.stateNativeIds.has(resource.native_id)) {
		return keep("tracked in tofu state (tofu's to manage, not ours)");
	}

	if (!resource.created_at) {
		return keep("creation time unknown (cannot prove this resource is ours)");
	}
	if (resource.created_at < ctx.jobStartedAt) {
		return keep(
			`predates the job (created ${resource.created_at.toISOString()} < job start ${ctx.jobStartedAt.toISOString()})`,
		);
	}

	return { resource, action: "delete", reason: "orphan" };
}

/**
 * Sorts resources so dependents die before their dependencies (a server before the volume attached to
 * it, before the network they sit in). Unknown kinds sort last — deleting them early would just fail.
 */
export function orderForDelete(
	resources: CloudResourceRef[],
	deleteOrder: string[],
): CloudResourceRef[] {
	const rank = (kind: string) => {
		const i = deleteOrder.indexOf(kind);
		return i === -1 ? deleteOrder.length : i;
	};
	return [...resources].sort((a, b) => rank(a.kind) - rank(b.kind));
}
