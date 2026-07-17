// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The promotion diff/merge engine. Environments each own a full design (`ProjectFormData`, the same
// shape the canvas reads/writes). "Promotion" carries a source env's *structural* changes onto a
// target env while preserving the target's *environment-tunable* knobs (sizing, capacity, retention,
// env-specific domains/repos). This keeps prod's 8-node cluster when you promote a "add redis" change
// up from dev. Pure + deterministic — no DB, unit-testable.

import { asRecord } from "@/lib/records";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import type {
	ComponentChange,
	ComponentFieldChange,
	PromotionDiff,
} from "@/types/jsonb.types";

// --- structural field classification -------------------------------------------------------------
// Promote *what a resource is* (engine, version, keys, topology, presence); preserve *how much /
// where* (instance class, capacity, node counts, retention, placement, env-specific domains/repos).
// A field absent from these lists is environment-tunable and is never overwritten by a promotion.

const CLUSTER_STRUCTURAL = ["cluster_version"] as const;
const DNS_STRUCTURAL = ["enabled", "managed_certificate", "waf_enabled"] as const;
const SOURCE_REPO_STRUCTURAL = ["services"] as const;
const DATABASE_STRUCTURAL = ["engine", "engine_version", "port", "iam_auth"] as const;
const CACHE_STRUCTURAL = ["engine", "engine_version"] as const;
const QUEUE_STRUCTURAL = ["ordered"] as const;
const TOPIC_STRUCTURAL = ["subscriptions"] as const;
const NOSQL_STRUCTURAL = [
	"partition_key",
	"partition_key_type",
	"sort_key",
	"sort_key_type",
	"table_type",
] as const;
const SECRET_STRUCTURAL = ["generate", "length", "special_chars"] as const;

// --- generic helpers ------------------------------------------------------------------------------

/** Deterministic stringify (sorted keys) for deep value comparison of nested config/arrays. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = asRecord(value);
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** True when two config values are deeply equal (order-independent for object keys). */
function valuesEqual(a: unknown, b: unknown): boolean {
	return stableStringify(a) === stableStringify(b);
}

/** The structural fields that differ between a target (current) and source (incoming) component. */
function fieldDiffs<T extends object>(
	current: T,
	incoming: T,
	fields: readonly (keyof T)[],
): Record<string, ComponentFieldChange> {
	const diffs: Record<string, ComponentFieldChange> = {};
	for (const f of fields) {
		if (!valuesEqual(current[f], incoming[f])) {
			diffs[String(f)] = { from: current[f], to: incoming[f] };
		}
	}
	return diffs;
}

/** A copy of `target` with only the given structural fields overwritten from `source`. */
function copyStructural<T extends object>(
	target: T,
	source: T,
	fields: readonly (keyof T)[],
): T {
	const out = { ...target };
	for (const f of fields) out[f] = source[f];
	return out;
}

/** Short human rendering of a field value for the summary. */
function fmtVal(v: unknown): string {
	if (v === null || v === undefined) return "none";
	if (typeof v === "object") return Array.isArray(v) ? `${v.length} item(s)` : "config";
	return String(v);
}

// --- multi-component diff/merge (databases, caches, …) --------------------------------------------

/** Diffs a list-valued component: CREATE (source-only), UPDATE (structural drift), DELETE (target-only). */
function diffMulti<T extends object>(
	componentType: string,
	label: string,
	source: T[],
	target: T[],
	structural: readonly (keyof T)[],
	keyOf: (item: T) => string,
): { changes: ComponentChange[]; summary: string[] } {
	const changes: ComponentChange[] = [];
	const summary: string[] = [];
	const targetByKey = new Map(target.map((t) => [keyOf(t), t]));
	const sourceKeys = new Set(source.map(keyOf));

	for (const s of source) {
		const key = keyOf(s);
		const t = targetByKey.get(key);
		if (!t) {
			changes.push({ component_type: componentType, key, op: "CREATE" });
			summary.push(`Add ${label} \`${key}\``);
			continue;
		}
		const fields = fieldDiffs(t, s, structural);
		if (Object.keys(fields).length > 0) {
			changes.push({ component_type: componentType, key, op: "UPDATE", fields });
			summary.push(`Update ${label} \`${key}\`: ${summarizeFields(fields)}`);
		}
	}
	for (const t of target) {
		const key = keyOf(t);
		if (!sourceKeys.has(key)) {
			changes.push({ component_type: componentType, key, op: "DELETE" });
			summary.push(`Remove ${label} \`${key}\``);
		}
	}
	return { changes, summary };
}

/** Merges a list-valued component: apply structural onto matches, copy source-only, drop target-only
 * (only when removals are opted in — otherwise target-only items are preserved). */
function mergeMulti<T extends object>(
	source: T[],
	target: T[],
	structural: readonly (keyof T)[],
	includeRemovals: boolean,
	keyOf: (item: T) => string,
): T[] {
	const targetByKey = new Map(target.map((t) => [keyOf(t), t]));
	const sourceKeys = new Set(source.map(keyOf));
	const merged: T[] = [];
	for (const s of source) {
		const t = targetByKey.get(keyOf(s));
		merged.push(t ? copyStructural(t, s, structural) : structuredClone(s));
	}
	if (!includeRemovals) {
		for (const t of target) {
			if (!sourceKeys.has(keyOf(t))) merged.push(structuredClone(t));
		}
	}
	return merged;
}

/** Key function for a scanned source repo (repo + subtree path). */
function repoKey(r: ProjectFormData["source_repos"][number]): string {
	return `${r.repo_url}|${r.scan_path ?? ""}`;
}

/** Key function for a named multi-component item (databases/caches/queues/…). */
function nameKey(item: { name: string }): string {
	return item.name;
}

/** Joins field diffs into a `a → b, c → d` fragment. */
function summarizeFields(fields: Record<string, ComponentFieldChange>): string {
	return Object.entries(fields)
		.map(([f, c]) => `${f} ${fmtVal(c.from)} → ${fmtVal(c.to)}`)
		.join(", ");
}

// --- public API -----------------------------------------------------------------------------------

/**
 * Computes the promotable delta from `source` onto `target`. DELETE changes are always listed (so the
 * UI can show what a removal-inclusive promotion would drop); `includeRemovals` records the actor's
 * intent and drives `mergeChangeset`.
 */
export function diffDesigns(
	source: ProjectFormData,
	target: ProjectFormData,
	includeRemovals = false,
): PromotionDiff {
	const changes: ComponentChange[] = [];
	const summary: string[] = [];

	// Singletons — only structural UPDATEs (they always exist; network/repositories carry no
	// structural fields, so they never surface a change).
	const clusterFields = fieldDiffs(target.cluster, source.cluster, CLUSTER_STRUCTURAL);
	if (Object.keys(clusterFields).length > 0) {
		changes.push({ component_type: "cluster", key: "cluster", op: "UPDATE", fields: clusterFields });
		summary.push(`Update cluster: ${summarizeFields(clusterFields)}`);
	}
	const dnsFields = fieldDiffs(target.dns, source.dns, DNS_STRUCTURAL);
	if (Object.keys(dnsFields).length > 0) {
		changes.push({ component_type: "dns", key: "dns", op: "UPDATE", fields: dnsFields });
		summary.push(`Update DNS: ${summarizeFields(dnsFields)}`);
	}

	// Multi-components.
	const parts = [
		diffMulti("source_repos", "app repo", source.source_repos, target.source_repos, SOURCE_REPO_STRUCTURAL, repoKey),
		diffMulti("databases", "database", source.databases, target.databases, DATABASE_STRUCTURAL, nameKey),
		diffMulti("caches", "cache", source.caches, target.caches, CACHE_STRUCTURAL, nameKey),
		diffMulti("queues", "queue", source.queues, target.queues, QUEUE_STRUCTURAL, nameKey),
		diffMulti("topics", "topic", source.topics, target.topics, TOPIC_STRUCTURAL, nameKey),
		diffMulti("nosql_tables", "table", source.nosql_tables, target.nosql_tables, NOSQL_STRUCTURAL, nameKey),
		diffMulti("secrets", "secret", source.secrets, target.secrets, SECRET_STRUCTURAL, nameKey),
	];
	for (const p of parts) {
		changes.push(...p.changes);
		summary.push(...p.summary);
	}

	return { changes, summary, include_removals: includeRemovals };
}

/**
 * Produces the candidate target design: `target` with `source`'s structural changes applied and the
 * target's environment-tunable knobs preserved. CREATE copies the full source component; UPDATE
 * overwrites only structural fields; target-only components are dropped only when `includeRemovals`.
 * Project-level settings, network, and the GitOps repo stay the target's.
 */
export function mergeChangeset(
	source: ProjectFormData,
	target: ProjectFormData,
	includeRemovals = false,
): ProjectFormData {
	const merged = structuredClone(target);
	merged.cluster = copyStructural(target.cluster, source.cluster, CLUSTER_STRUCTURAL);
	merged.dns = copyStructural(target.dns, source.dns, DNS_STRUCTURAL);
	merged.source_repos = mergeMulti(source.source_repos, target.source_repos, SOURCE_REPO_STRUCTURAL, includeRemovals, repoKey);
	merged.databases = mergeMulti(source.databases, target.databases, DATABASE_STRUCTURAL, includeRemovals, nameKey);
	merged.caches = mergeMulti(source.caches, target.caches, CACHE_STRUCTURAL, includeRemovals, nameKey);
	merged.queues = mergeMulti(source.queues, target.queues, QUEUE_STRUCTURAL, includeRemovals, nameKey);
	merged.topics = mergeMulti(source.topics, target.topics, TOPIC_STRUCTURAL, includeRemovals, nameKey);
	merged.nosql_tables = mergeMulti(source.nosql_tables, target.nosql_tables, NOSQL_STRUCTURAL, includeRemovals, nameKey);
	merged.secrets = mergeMulti(source.secrets, target.secrets, SECRET_STRUCTURAL, includeRemovals, nameKey);
	return merged;
}

/** Whether a diff has anything to apply given the removal preference. */
export function diffIsEmpty(diff: PromotionDiff): boolean {
	return diff.changes.every(
		(c) => c.op === "DELETE" && !diff.include_removals,
	);
}

// --- structural fingerprint (stable across environments) -----------------------------------------

/** A copy of `obj` with only the given fields — the structural subset for fingerprinting. */
function pick<T extends object>(obj: T, fields: readonly (keyof T)[]): Partial<T> {
	const out: Partial<T> = {};
	for (const f of fields) out[f] = obj[f];
	return out;
}

/** A small, dependency-free, deterministic string hash (cyrb53-style) rendered as hex. */
function hashString(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
	return n.toString(16).padStart(14, "0");
}

/** The structural projection of a design — only promotable fields, arrays sorted by key so order
 * and env-tunable knobs never affect the fingerprint. */
function structuralProjection(d: ProjectFormData) {
	const sortByKey = <T>(items: T[], keyOf: (t: T) => string) =>
		items
			.map((item) => ({ key: keyOf(item), fields: item }))
			.sort((a, b) => a.key.localeCompare(b.key));
	const projectMulti = <T extends object>(
		items: T[],
		fields: readonly (keyof T)[],
		keyOf: (t: T) => string,
	) => sortByKey(items, keyOf).map((e) => ({ key: e.key, ...pick(e.fields, fields) }));

	return {
		cluster: pick(d.cluster, CLUSTER_STRUCTURAL),
		dns: pick(d.dns, DNS_STRUCTURAL),
		source_repos: projectMulti(d.source_repos, SOURCE_REPO_STRUCTURAL, repoKey),
		databases: projectMulti(d.databases, DATABASE_STRUCTURAL, nameKey),
		caches: projectMulti(d.caches, CACHE_STRUCTURAL, nameKey),
		queues: projectMulti(d.queues, QUEUE_STRUCTURAL, nameKey),
		topics: projectMulti(d.topics, TOPIC_STRUCTURAL, nameKey),
		nosql_tables: projectMulti(d.nosql_tables, NOSQL_STRUCTURAL, nameKey),
		secrets: projectMulti(d.secrets, SECRET_STRUCTURAL, nameKey),
	};
}

/**
 * A fingerprint of a design's *structural* shape — identical across environments that share the same
 * promotable design, regardless of sizing/placement/env-identity. Used to prove "the predecessor
 * deployed THIS design" (gate) and to detect config-vs-desired divergence (reconcile).
 */
export function structuralHash(design: ProjectFormData): string {
	return hashString(stableStringify(structuralProjection(design)));
}

/** One promotable component instance in a design, with a structural signature. */
export interface DesignComponentEntry {
	component_type: string;
	key: string;
	sig: string;
}

/**
 * The promotable components present in a design, each with a structural signature. Powers the
 * cross-environment consistency view (same key + differing sig across envs = "differs").
 */
export function designInventory(d: ProjectFormData): DesignComponentEntry[] {
	const entries: DesignComponentEntry[] = [];
	const sig = (v: unknown) => hashString(stableStringify(v));
	const addMulti = <T extends object>(
		type: string,
		items: T[],
		fields: readonly (keyof T)[],
		keyOf: (t: T) => string,
	) => {
		for (const it of items)
			entries.push({ component_type: type, key: keyOf(it), sig: sig(pick(it, fields)) });
	};

	// Cluster is always present; DNS only counts when enabled. Network/repositories are env-local.
	entries.push({ component_type: "cluster", key: "cluster", sig: sig(pick(d.cluster, CLUSTER_STRUCTURAL)) });
	if (d.dns.enabled) entries.push({ component_type: "dns", key: "dns", sig: sig(pick(d.dns, DNS_STRUCTURAL)) });
	addMulti("source_repos", d.source_repos, SOURCE_REPO_STRUCTURAL, repoKey);
	addMulti("databases", d.databases, DATABASE_STRUCTURAL, nameKey);
	addMulti("caches", d.caches, CACHE_STRUCTURAL, nameKey);
	addMulti("queues", d.queues, QUEUE_STRUCTURAL, nameKey);
	addMulti("topics", d.topics, TOPIC_STRUCTURAL, nameKey);
	addMulti("nosql_tables", d.nosql_tables, NOSQL_STRUCTURAL, nameKey);
	addMulti("secrets", d.secrets, SECRET_STRUCTURAL, nameKey);
	return entries;
}
