// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W3 Path-B seed (#620): map a scanned service's detected `needs` (per-service backing
// signals from packages/core/scanner) to SUGGESTED ServiceBindings — the {target, inject}
// edges of the W3 binding contract (#615). Suggestions are proposals the user accepts or
// edits on the canvas (#619) — they are NEVER auto-applied, and every suggestion targets a
// component that actually exists in the design (a binding to a dangling {kind,name} would
// trip buildConfigSnapshot's fail-closed target gate).

import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import type { IacGroup } from "@/lib/canvas/iac-inventory";
import type {
	DetectedService,
	ServiceBinding,
	ServiceBindingInjection,
	ServiceBindingKind,
} from "@/types/jsonb.types";

/** A bindable component of the design (the {kind, name} join key bindings reference). A BYO-IaC
 * bind target additionally carries `address` (its Terraform address, the real join key the runner
 * resolves against) and `outputs` (the customer module's declared output names the bind sheet maps
 * each facet to) — see #687. First-class components leave both undefined. */
export interface BindableComponent {
	kind: ServiceBindingKind;
	name: string;
	/** Terraform address of a BYO-IaC target; undefined for a first-class component. */
	address?: string;
	/** The module's declared root output names (IacScanReport.outputs) offered as facet→output
	 * choices when binding to this BYO-IaC resource; undefined for a first-class component. */
	outputs?: string[];
}

/** Narrow an IaC group's canvas kind to a bindable ServiceBindingKind, or null when the kind is
 * not a bindable backing resource (network/cluster/bucket/…). Only database/cache/queue have a
 * deploy-time endpoint/port/credential resolution in packages/core/manifests, so only those become
 * BYO-IaC bind targets; the comparison narrows without an `as` cast. */
function bindableKindForIac(kind: NodeKind | null): ServiceBindingKind | null {
	if (kind === "database" || kind === "cache" || kind === "queue") {
		return kind;
	}
	return null;
}

/** Default env injections per target kind — conservative, resolvable facets (endpoint/port
 * from tofu outputs; credentials keylessly via ExternalSecret → secretKeyRef). The user
 * renames/prunes them in the binding editor. */
const DEFAULT_INJECTIONS: Record<ServiceBindingKind, ServiceBindingInjection[]> = {
	database: [
		{ env: "DATABASE_HOST", from: "endpoint" },
		{ env: "DATABASE_PORT", from: "port" },
		{ env: "DATABASE_USER", from: "username" },
		{ env: "DATABASE_PASSWORD", from: "password" },
	],
	cache: [
		{ env: "CACHE_HOST", from: "endpoint" },
		{ env: "CACHE_PORT", from: "port" },
		{ env: "CACHE_PASSWORD", from: "password" },
	],
	queue: [
		{ env: "QUEUE_HOST", from: "endpoint" },
		{ env: "QUEUE_PORT", from: "port" },
		{ env: "QUEUE_USER", from: "username" },
		{ env: "QUEUE_PASSWORD", from: "password" },
	],
	// No scanner signal maps to a secret binding today (secrets are user-declared), but
	// the kind stays mapped so a future signal (or an AI-inferred need) has defaults.
	secret: [{ env: "SECRET_VALUE", from: "password" }],
};

/** Scanner signal → the bindable kind it suggests. Signals whose backing resource has no
 * bindable kind yet (object-storage, dynamodb, elasticsearch, …) are intentionally
 * absent — an unmappable need surfaces nothing rather than a wrong edge. `task-queue`
 * (celery/sidekiq/bullmq) suggests the cache: those brokers are redis-backed by default. */
const SIGNAL_TO_KIND: Record<string, ServiceBindingKind> = {
	postgresql: "database",
	mysql: "database",
	redis: "cache",
	memcached: "cache",
	rabbitmq: "queue",
	"task-queue": "cache",
};

/**
 * Suggest bindings for one scanned service: each mappable need becomes one binding to the
 * FIRST existing component of the suggested kind (deterministic — the design's own order),
 * with the kind's default injections. De-duped per {kind, target}: two needs suggesting
 * the same kind (e.g. redis + task-queue) yield one binding. Needs with no mappable kind
 * or no matching component are skipped — never invented.
 */
export function suggestBindings(
	service: Pick<DetectedService, "needs">,
	components: BindableComponent[],
): ServiceBinding[] {
	const out: ServiceBinding[] = [];
	const seen = new Set<string>();
	for (const need of service.needs ?? []) {
		const kind = SIGNAL_TO_KIND[need];
		if (!kind) continue;
		const target = components.find((c) => c.kind === kind);
		if (!target) continue;
		const key = `${kind}:${target.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			target: { kind, name: target.name },
			inject: DEFAULT_INJECTIONS[kind].map((i) => ({ ...i })),
		});
	}
	return out;
}

/** The design's bindable components, flattened from form data (the shape
 * mergeScansToFormData produces / the canvas edits). When the environment is BYO-IaC, pass the
 * scanned module's `iacGroups` (from buildIacInventory) + its declared `iacOutputs`
 * (IacScanReport.outputs): each database/cache/queue resource in the customer module becomes a
 * bindable target carrying its Terraform address + the module's outputs for the facet picker (#687). */
export function bindableComponents(form: {
	databases?: { name: string }[];
	caches?: { name: string }[];
	queues?: { name: string }[];
	secrets?: { name: string }[];
	iacGroups?: IacGroup[];
	iacOutputs?: string[];
}): BindableComponent[] {
	const of = (kind: ServiceBindingKind, rows?: { name: string }[]) =>
		(rows ?? []).map((r) => ({ kind, name: r.name }));
	const firstClass = [
		...of("database", form.databases),
		...of("cache", form.caches),
		...of("queue", form.queues),
		...of("secret", form.secrets),
	];
	// BYO-IaC members: one bindable target per database/cache/queue resource in the customer
	// module, identified by Terraform address and carrying the module's outputs for the picker.
	const byo = (form.iacGroups ?? []).flatMap((g) => {
		const kind = bindableKindForIac(g.kind);
		if (!kind) return [];
		return g.members.map((m) => ({
			kind,
			name: m.name,
			address: m.address,
			outputs: form.iacOutputs ?? [],
		}));
	});
	return [...firstClass, ...byo];
}
