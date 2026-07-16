// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W3 Path-B seed (#620): map a scanned service's detected `needs` (per-service backing
// signals from packages/core/scanner) to SUGGESTED ServiceBindings — the {target, inject}
// edges of the W3 binding contract (#615). Suggestions are proposals the user accepts or
// edits on the canvas (#619) — they are NEVER auto-applied, and every suggestion targets a
// component that actually exists in the design (a binding to a dangling {kind,name} would
// trip buildConfigSnapshot's fail-closed target gate).

import type {
	DetectedService,
	ServiceBinding,
	ServiceBindingInjection,
	ServiceBindingKind,
} from "@/types/jsonb.types";

/** A bindable component of the design (the {kind, name} join key bindings reference). */
export interface BindableComponent {
	kind: ServiceBindingKind;
	name: string;
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
 * mergeScansToFormData produces / the canvas edits). */
export function bindableComponents(form: {
	databases?: { name: string }[];
	caches?: { name: string }[];
	queues?: { name: string }[];
	secrets?: { name: string }[];
}): BindableComponent[] {
	const of = (kind: ServiceBindingKind, rows?: { name: string }[]) =>
		(rows ?? []).map((r) => ({ kind, name: r.name }));
	return [
		...of("database", form.databases),
		...of("cache", form.caches),
		...of("queue", form.queues),
		...of("secret", form.secrets),
	];
}
