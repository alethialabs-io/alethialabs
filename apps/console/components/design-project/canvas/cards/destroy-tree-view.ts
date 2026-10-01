// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's reading of an environment's DESTROY TREE (#5261, from #5249/#5259).
//
// The tree comes from `getDestroyTree` and is READ BEFORE the destroy is queued, never parsed out
// of a refusal: a production build redacts a server action's error text, so the
// `FabricHasLiveTenantsError` that names the tenants reaches the browser as a digest. Asking first
// is the only way the user ever sees the list.

import type { DestroyTreeNode } from "@/lib/queries/destroy-tree";

export type { DestroyTreeNode };

/**
 * What the canvas hands the Environment settings card so it can destroy the active environment.
 * Absent in the create flow, where there is no provisioned environment.
 */
export interface DestroyEnvironmentControl {
	/** The project's name — what a cascade asks the user to type. Null when it could not be read. */
	projectName: string | null;
	/** Reads the active environment's destroy tree. Must be referentially stable across renders. */
	loadTree: () => Promise<DestroyTreeNode[]>;
	/** Queues the destroy; `cascade` also queues every live tenant, tenants first. */
	destroy: (options: { cascade: boolean }) => Promise<void>;
}

/** A tree split into the environments placed on the cluster and the environment destroyed last. */
export interface SplitDestroyTree {
	/** The live tenants, in the order the cascade destroys them. Empty when nothing else is placed. */
	tenants: DestroyTreeNode[];
	/** The environment the user asked to destroy — always the tree's last node. */
	target: DestroyTreeNode;
}

/**
 * Splits a destroy tree into its tenants and its target. `buildDestroyTree` always puts the target
 * last, so this reads position rather than `owns_fabric`: a non-dedicated target owns nothing and is
 * still the last (and only) node. Null for an empty tree, which the server never returns.
 */
export function splitDestroyTree(tree: readonly DestroyTreeNode[]): SplitDestroyTree | null {
	const target = tree[tree.length - 1];
	if (!target) return null;
	return { tenants: tree.slice(0, -1), target };
}

/** How one node of the tree is placed, in words: "owns the cluster", "namespace on the cluster". */
export function placementLabel(node: DestroyTreeNode): string {
	if (node.owns_fabric) return "owns the cluster";
	return `${node.placement_mode} on the cluster`;
}

/**
 * A link to another environment's settings card on this same Architecture page — where its own
 * Destroy lives. Query-only, so it keeps the current org/project path.
 */
export function environmentSettingsHref(environmentId: string): string {
	const q = new URLSearchParams({ environment_id: environmentId, card: "env-settings" });
	return `?${q.toString()}`;
}

/** "dev-1", "dev-1 and staging", "dev-1, staging and qa" — names joined the way a sentence reads. */
export function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
