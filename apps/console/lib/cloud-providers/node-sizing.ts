// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A cluster has TWO ways to say what machine it runs on, and this module is the console's single
// answer to how they interact (#5267):
//
//   - `instance_types` pins concrete provider SKUs (`["e2-standard-4"]`);
//   - `node_size` is the cloud-indifferent capability (`{ vcpu: 4, memory_gb: 16 }`) the Go resolver
//     (packages/core/cloud/resolve.go, ResolveInstanceTypes) maps to the nearest catalog SKU at
//     provision time.
//
// Go's precedence is "a non-empty instance_types wins, else node_size resolves". Since #5270 every
// new cluster row is stamped with a default instance type, so a node_size written NEXT to that
// stamp would be shadowed forever — editable, shown, and ignored. Hence the ONE-WRITER RULE: a
// write that sets one of the two clears the other in the same write. The canvas inspector and the
// CLI `--set` both apply it. Rows written before the rule are NEVER rewritten; they keep whatever
// they hold and Go's precedence decides, which is why the card below resolves with that same
// precedence rather than preferring node_size.

import { formatBytes } from "@repo/format";
import type { NodeSize } from "@/types/jsonb.types";
import { nearestInstance } from "./generated/catalog";

/** The instance family the Go resolver asks NearestInstance for (resolve.go). */
const RESOLVER_FAMILY = "general";

/** Bytes in one GiB — the catalog's `memory_gb` is binary gigabytes, and formatBytes steps by 1024. */
const BYTES_PER_GB = 1024 ** 3;

/** The two sizing columns of a cluster, in the shape every layer holds them (form, row, snapshot). */
export interface ClusterSizing {
	instance_types?: string[] | null;
	node_size?: NodeSize | null;
}

/**
 * The machine types a cluster will actually be given on `provider` — the TypeScript mirror of Go's
 * ResolveInstanceTypes, with the same precedence: a non-empty `instance_types` wins, otherwise
 * `node_size` resolves to the nearest catalog SKU in the general family. Empty when neither is set
 * (the template's own default applies) or the provider has no catalog inventory.
 *
 * The nearest rule itself is NOT restated here: it is the generated catalog's `nearestInstance`,
 * which tests/lib/cloud-providers/nearest-instance-parity.test.ts locks to the Go answers.
 */
export function resolveInstanceTypes(
	provider: string | null,
	cluster: ClusterSizing,
): string[] {
	if (cluster.instance_types && cluster.instance_types.length > 0) {
		return cluster.instance_types;
	}
	if (!cluster.node_size || !provider) return [];
	const sku = nearestInstance(
		provider,
		cluster.node_size.vcpu,
		cluster.node_size.memory_gb,
		RESOLVER_FAMILY,
	);
	return sku ? [sku.value] : [];
}

/** A node_size as a person reads it: `4 vCPU / 16 GB`. */
function formatNodeSize(size: NodeSize): string {
	return `${size.vcpu} vCPU / ${formatBytes(size.memory_gb * BYTES_PER_GB)}`;
}

/**
 * The cluster card's "Shape": what the deploy will BUY, never just what was typed.
 *
 * A pinned type reads as itself. A size reads as the size AND the SKU it resolves to on the node's
 * cloud — `4 vCPU / 16 GB → e2-standard-4` — so moving the node to another cloud visibly changes
 * the machine. With no cloud to resolve against, the size alone. A legacy row carrying both reads
 * as its pinned type, because that is what Go deploys.
 */
export function describeNodeShape(
	provider: string | null,
	cluster: ClusterSizing,
): string {
	if (cluster.instance_types && cluster.instance_types.length > 0) {
		return cluster.instance_types[0];
	}
	if (!cluster.node_size) return "";
	const [sku] = resolveInstanceTypes(provider, cluster);
	const size = formatNodeSize(cluster.node_size);
	return sku ? `${size} → ${sku}` : size;
}

/** Result of applying the one-writer rule to one write: the values to persist, or why not. */
export type SizingWriteResult =
	| { ok: true; values: Record<string, unknown> }
	| { ok: false; error: string };

/** True when a value is a non-empty array (a write that pins at least one machine type). */
function pinsMachineType(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

/**
 * The one-writer rule, applied to a single write of cluster fields (the CLI's `--set` map, after
 * schema validation). Setting `node_size` clears `instance_types` (to `[]`, so the snapshot
 * carries an empty list and Go resolves the size); pinning `instance_types` clears `node_size`
 * (to `null` — explicit, because the CLI upserts and an absent key would leave the stored value in
 * place on the conflict branch). Naming BOTH in one write is refused: there is no order in which
 * "set A, which clears B; set B, which clears A" means anything.
 *
 * A write that names neither, or that only clears one (`node_size=null`, `instance_types=[]`),
 * passes through untouched — clearing one is not choosing the other.
 */
export function applySizingOneWriter(
	values: Record<string, unknown>,
): SizingWriteResult {
	const setsSize = values.node_size != null;
	const pinsType = pinsMachineType(values.instance_types);
	if (setsSize && pinsType) {
		return {
			ok: false,
			error:
				"node_size and instance_types are mutually exclusive — set one. Setting node_size " +
				"clears instance_types, and setting instance_types clears node_size.",
		};
	}
	if (setsSize) return { ok: true, values: { ...values, instance_types: [] } };
	if (pinsType) return { ok: true, values: { ...values, node_size: null } };
	return { ok: true, values };
}
