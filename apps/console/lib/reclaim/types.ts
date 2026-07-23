// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The contract every cloud adapter implements for orphan reclaim.
//
// An ORPHAN is a resource that exists in the cloud, carries this environment's cluster label, and is
// absent from its tofu state file. It bills forever and no `tofu destroy` will ever find it, because
// destroy only knows what state knows.
//
// This is the most dangerous code in the product: it deletes real infrastructure, in an account that
// (for Hetzner) is SHARED WITH PROD. The guard rails live in guards.ts and are fail-closed by
// construction — an adapter cannot opt out of them, because it never deletes anything itself on the
// strength of its own list. It reports candidates; the core decides.

import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";

/** A live resource seen in the cloud under this environment's label selector. */
export interface CloudResourceRef {
	/** Provider-native id — the handle a delete is issued against. Must be exact, never a name. */
	native_id: string;
	/** Provider-native kind ("hcloud_server", "aws_instance", …). Drives delete ordering. */
	kind: string;
	/** Human name, for the audit trail only — NEVER used to select what to delete. */
	name: string | null;
	/** Region/location, when the delete call needs it. */
	region: string | null;
	/**
	 * When the cloud says this resource was created. Load-bearing: the created-after guard refuses to
	 * delete anything older than the job that supposedly created it, so pre-existing infrastructure can
	 * never be swept. An adapter that cannot report this must return null — the guard then REFUSES the
	 * resource rather than assuming it is young.
	 */
	created_at: Date | null;
	/** The labels/tags the cloud actually returned. The core re-checks the selector against these. */
	labels: Record<string, string>;
}

/**
 * The label selector identifying one environment's resources. `cluster=<name>` is the authoritative
 * base label every template stamps (and a `check` block asserts nothing can shadow it).
 */
export interface LabelSelector {
	key: string;
	value: string;
}

/** Per-cloud reclaim adapter. Lists and deletes — it never decides. */
export interface ReclaimAdapter {
	provider: CloudProviderSlug;

	/**
	 * Lists live resources matching `selector`, using a SERVER-SIDE label filter wherever the cloud
	 * offers one (a client-side filter over a full account listing is forbidden: one bad predicate and
	 * the blast radius is the whole account).
	 *
	 * MUST NOT return resources that don't carry the selector. The core re-verifies anyway, but an
	 * adapter that over-returns is a bug, not a nuisance.
	 */
	list(
		identityId: string,
		selector: LabelSelector,
	): Promise<CloudResourceRef[]>;

	/**
	 * Deletes ONE resource by native id. Called only for resources the core has already cleared through
	 * every guard. Must be idempotent — a resource that has since vanished is a success, not an error.
	 */
	delete(identityId: string, resource: CloudResourceRef): Promise<void>;

	/**
	 * Delete order for this cloud's kinds, most-dependent FIRST (servers before volumes before
	 * networks). Kinds absent from the list sort last. Getting this wrong makes deletes fail, not
	 * over-delete, so it is a correctness-of-cleanup concern rather than a safety one.
	 */
	deleteOrder: string[];
}

/** What the core decided about one candidate, and why. Written to the audit trail before any delete. */
export interface ReclaimDecision {
	resource: CloudResourceRef;
	action: "delete" | "keep";
	/** The guard that rejected it, or "orphan" when every guard passed. Always populated. */
	reason: string;
}
