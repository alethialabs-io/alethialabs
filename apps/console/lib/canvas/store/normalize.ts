// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The pure rewrites the document store applies to a node set (#6764): the per-cloud normalizers,
// the builders that reunite a node's kind with its config, and unique naming. Moved out of the
// store unchanged; none of them reads or writes a store.

import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import type {
	CanvasNode,
	CanvasNodeData,
	NodeConfigMap,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import {
	normalizeKeylessAuth,
	normalizeManagedCertificate,
	normalizeWafEnabled,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import {
	type ConversionWarning,
	convertInstanceTypes,
} from "@/lib/cloud-providers/convert";
import { normalizeCapacityMode } from "@/lib/cloud-providers/nosql-capacity";
import { randomUuid } from "@/lib/random-id";
import { PROJECT_NODE_ID } from "./types";

/** A browser-only stable id for new nodes (canvas is client-side). */
export function newId(kind: NodeKind): string {
	return `${kind}-${randomUuid().slice(0, 8)}`;
}

/** The project root every design starts from. */
export function makeProjectNode(): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		deletable: false,
		data: {
			kind: "project",
			config: NODE_REGISTRY.project.defaultData("aws"),
			cloud_identity_id: null,
			provider: null,
		},
	};
}

// ── discriminant/config reunion helpers ─────────────────────────────────────
// TypeScript can't correlate a node's runtime `kind` with its `config` type through
// an object spread (the classic discriminated-union limitation), so the few spots that
// rebuild a node's data from an edited config/placement assert the reunion here, once.

/** Assemble a node's data payload from a kind + config (+ placement). */
export function buildNodeData<K extends NodeKind>(
	kind: K,
	config: NodeConfigMap[K],
	cloudIdentityId: string | null,
	provider: CloudProviderSlug | null,
): CanvasNodeData<K> {
	return {
		kind,
		config,
		cloud_identity_id: cloudIdentityId,
		provider,
	};
}

/** Merge a (partial) config patch into a node's data, keeping its kind. */
export function withConfig<T extends CanvasNodeData>(
	data: T,
	patch: Partial<T["config"]>,
): T {
	return { ...data, config: { ...data.config, ...patch } };
}

/** Update a node's placement (identity + derived provider), keeping its kind + config. */
export function withPlacement(
	data: CanvasNodeData,
	cloudIdentityId: string | null,
	provider: CloudProviderSlug | null,
): CanvasNodeData {
	return { ...data, cloud_identity_id: cloudIdentityId, provider };
}

/** The cloud a node deploys to: its own placement, else the project root's. */
function effectiveProviderIn(
	nodes: CanvasNode[],
	node: CanvasNode,
): CloudProviderSlug | null {
	return (
		node.data.provider ??
		nodes.find((n) => n.id === PROJECT_NODE_ID)?.data.provider ??
		null
	);
}

/**
 * Carry each cluster's PINNED machine types onto the cloud it now deploys to (#5269).
 *
 * Re-placing a node on another cloud's identity used to rewrite only its placement, so an AWS
 * cluster moved onto a GCP account still said `t3.large` and failed at plan, inside GCP's API.
 * The mapping is convert.ts's `convertInstanceTypes` — the same rule the whole-project conversion
 * applies, not a copy of it — including its fallback to the target's default with a notice.
 *
 * Compares each cluster's effective cloud BEFORE and AFTER, rather than looking only at the node
 * that moved, because repointing the PROJECT root moves every cluster that inherits from it. A
 * cluster sized by `node_size` (empty instance_types) is left alone: it re-resolves on the new
 * cloud by itself.
 */
export function convertInstanceTypesAcrossNodes(
	before: CanvasNode[],
	after: CanvasNode[],
): { nodes: CanvasNode[]; warnings: ConversionWarning[] } {
	const warnings: ConversionWarning[] = [];
	const nodes = after.map((n) => {
		if (n.data.kind !== "cluster") return n;
		const pinned = n.data.config.instance_types ?? [];
		if (pinned.length === 0) return n;
		const old = before.find((b) => b.id === n.id);
		const from = old ? effectiveProviderIn(before, old) : null;
		const to = effectiveProviderIn(after, n);
		if (!from || !to || from === to) return n;
		const converted = convertInstanceTypes(pinned, from, to);
		warnings.push(...converted.warnings);
		return {
			...n,
			data: {
				...n.data,
				config: { ...n.data.config, instance_types: converted.instanceTypes },
			},
		};
	});
	return { nodes, warnings };
}

/**
 * Clear `iam_auth` on every database node whose cell can no longer honor it.
 *
 * The canvas gate is a RENDER filter — it decides what the inspector draws and nothing else. Without
 * this, enabling keyless on AWS and then re-placing the node (or the whole project) on Hetzner left
 * `iam_auth: true` in the config, in the persisted draft, and all the way into the deployed snapshot,
 * with a disabled toggle showing "off" above it. That gap is the whole reason the toggle was
 * dishonest in the first place, so the display and the value are moved together (#1510).
 *
 * Runs over ALL nodes rather than the one that changed, because repointing the PROJECT node changes
 * the effective provider of every database that inherits from it.
 */
export function normalizeKeylessAcrossNodes(nodes: CanvasNode[]): CanvasNode[] {
	const projectProvider =
		nodes.find((n) => n.id === PROJECT_NODE_ID)?.data.provider ?? null;
	return nodes.map((n) => {
		if (n.data.kind !== "database") return n;
		const config = normalizeKeylessAuth(
			n.data.config,
			n.data.provider ?? projectProvider,
		);
		return config === n.data.config ? n : { ...n, data: { ...n.data, config } };
	});
}

/**
 * Clear `waf_enabled` on the DNS node when the cloud does not offer a WAF.
 *
 * Same shape and same reason as `normalizeKeylessAcrossNodes` above, for the offer withdrawn on
 * Alibaba by #1841 — without it, a project designed on AWS with the WAF on and re-placed on Alibaba
 * carries `waf_enabled: true` into the config snapshot, the deployment payload, the clone path and
 * env promotions, under a disabled toggle reading "off".
 *
 * One difference worth knowing: this one ALSO runs at load, which the keyless normalizer does not.
 * It has to. The switch renders disabled, so a user cannot toggle a stale `true` off by hand, and
 * the deploy gate will refuse the project until it is cleared — normalizing at load is what turns
 * that dead end into a staged change they can simply save.
 */
export function normalizeWafAcrossNodes(nodes: CanvasNode[]): CanvasNode[] {
	const projectProvider =
		nodes.find((n) => n.id === PROJECT_NODE_ID)?.data.provider ?? null;
	let changed = false;
	const next = nodes.map((n) => {
		if (n.data.kind !== "dns") return n;
		// The Managed TLS switch beside it is withheld on Alibaba for the same reason and by the same
		// mechanism (#4320), so one pass over the DNS node clears both.
		const provider = n.data.provider ?? projectProvider;
		const config = normalizeManagedCertificate(
			normalizeWafEnabled(n.data.config, provider),
			provider,
		);
		if (config === n.data.config) return n;
		changed = true;
		return { ...n, data: { ...n.data, config } };
	});
	// Returns the SAME array when nothing was coerced, so a caller can tell "nothing to normalize"
	// by identity — a `.map()` result is always a fresh array.
	return changed ? next : nodes;
}

/**
 * Rewrite a NoSQL table's `capacity_mode` to one its cloud can build — in practice, Azure rows saved
 * as `provisioned` before #4320 made Cosmos serverless only.
 *
 * Same shape as `normalizeWafAcrossNodes`, and it runs at the same four moments (load, reseed, edit,
 * re-placement) for the same reason: the Capacity mode card no longer offers the stored value, so the
 * user could not clear it by hand, and normalising the DESIRED graph but not the baseline turns it
 * into a staged change they can see and save. Returns the SAME array when nothing was rewritten, so
 * a clean project does not open with a pending change.
 */
export function normalizeCapacityAcrossNodes(nodes: CanvasNode[]): CanvasNode[] {
	const projectProvider =
		nodes.find((n) => n.id === PROJECT_NODE_ID)?.data.provider ?? null;
	let changed = false;
	const next = nodes.map((n) => {
		if (n.data.kind !== "nosql") return n;
		const config = normalizeCapacityMode(
			n.data.config,
			n.data.provider ?? projectProvider,
		);
		if (config === n.data.config) return n;
		changed = true;
		return { ...n, data: { ...n.data, config } };
	});
	return changed ? next : nodes;
}

/** The normalizers every design EDIT runs: keyless, WAF and managed TLS, capacity mode. */
export function normalizeAfterEdit(nodes: CanvasNode[]): CanvasNode[] {
	return normalizeCapacityAcrossNodes(
		normalizeWafAcrossNodes(normalizeKeylessAcrossNodes(nodes)),
	);
}

/** The normalizers a freshly LOADED design runs: the two whose stale value has no control to clear it. */
export function normalizeAfterLoad(nodes: CanvasNode[]): CanvasNode[] {
	return normalizeCapacityAcrossNodes(normalizeWafAcrossNodes(nodes));
}

/** A name unique among existing names of the same kind. */
export function uniqueName(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	let i = 2;
	while (taken.has(`${base}-${i}`)) i++;
	return `${base}-${i}`;
}

/** The names already taken by nodes of `kind` (every kind when `kind` is omitted). */
export function takenNames(nodes: CanvasNode[], kind?: NodeKind): Set<string> {
	return new Set(
		nodes
			.filter((n) => kind === undefined || n.data.kind === kind)
			.map((n) => configName(n.data))
			.filter((v): v is string => typeof v === "string"),
	);
}

/** For array kinds, suffix the config's `name` so it's unique among same-kind nodes. */
export function applyUniqueName<K extends NodeKind>(
	kind: K,
	config: NodeConfigMap[K],
	nodes: CanvasNode[],
): NodeConfigMap[K] {
	// @ts-expect-error distributed-union variance (see buildNodeData): the generic {kind,config} can't be proven a CanvasNodeData member
	const nodeData: CanvasNodeData = {
		kind,
		config,
		cloud_identity_id: null,
		provider: null,
	};
	const current = configName(nodeData);
	if (NODE_REGISTRY[kind].cardinality !== "array" || !current) return config;
	return { ...config, name: uniqueName(current, takenNames(nodes, kind)) };
}

/** Approximate node footprint used by overlap repair (px). */
const NODE_W = 240;
const NODE_H = 130;

/** Push apart any nodes whose footprints overlap (keeps the project root anchored). */
export function spreadOverlaps(nodes: CanvasNode[]): CanvasNode[] {
	const placed: CanvasNode[] = [];
	const overlaps = (a: CanvasNode, b: CanvasNode) =>
		Math.abs(a.position.x - b.position.x) < NODE_W &&
		Math.abs(a.position.y - b.position.y) < NODE_H;
	for (const node of nodes) {
		if (node.id === PROJECT_NODE_ID) {
			placed.push(node);
			continue;
		}
		let pos = { ...node.position };
		let guard = 0;
		while (placed.some((p) => overlaps({ ...node, position: pos }, p)) && guard < 200) {
			pos = { x: pos.x, y: pos.y + NODE_H + 20 };
			guard++;
		}
		placed.push({ ...node, position: pos });
	}
	return placed;
}
