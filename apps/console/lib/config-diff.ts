// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The desired-vs-live component differ, extracted from app/server/actions/staged-changes.ts.
//
// It lives here and not there because that file carries `"use server"`, and Next.js requires EVERY
// export of a server-actions module to be an async function. `diffConfig` is a synchronous pure
// function, so exporting it from there builds a console that fails at compile time with
// "Server Actions must be async functions" — and `tsc` does not catch it, because it is a Next
// constraint rather than a type error. A pure differ has no business on an actions module's public
// surface anyway: it touches no database, needs no actor, and both the staged-changes action and the
// CLI's design-apply route want it.

import { asRecord } from "@/lib/records";
import type { CreateProjectInput } from "@/app/server/actions/projects";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import type { StagedChangePayload } from "@/types/jsonb.types";

type Op = "CREATE" | "UPDATE" | "DELETE";

export interface DiffRow {
	component_type: string;
	component_id: string | null;
	op: Op;
	payload: StagedChangePayload;
}

/** True when two component configs differ (order-insensitive enough for our flat configs). */
function changed(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) !== JSON.stringify(b);
}

/** An array component's items, each carrying a unique `name`. */
type NamedItem = { name?: string } & Record<string, unknown>;

/** Diff one array section (databases/caches/…) by `name` → CREATE/UPDATE/DELETE rows. */
function diffArray(
	componentType: string,
	live: readonly NamedItem[],
	desired: readonly NamedItem[],
): DiffRow[] {
	const liveByName = new Map(live.map((i) => [i.name ?? "", i]));
	const desiredNames = new Set(desired.map((i) => i.name ?? ""));
	const rows: DiffRow[] = [];
	for (const item of desired) {
		const prev = liveByName.get(item.name ?? "");
		if (!prev)
			rows.push({ component_type: componentType, component_id: null, op: "CREATE", payload: item });
		else if (changed(prev, item))
			rows.push({ component_type: componentType, component_id: null, op: "UPDATE", payload: item });
	}
	for (const item of live)
		if (!desiredNames.has(item.name ?? ""))
			rows.push({
				component_type: componentType,
				component_id: null,
				op: "DELETE",
				payload: { name: item.name },
			});
	return rows;
}

/** Diff a desired canvas config against the live project config → staged-change rows. */
export function diffConfig(
	live: ProjectFormData | null,
	desired: CreateProjectInput,
): DiffRow[] {
	const rows: DiffRow[] = [];
	// Singletons: an UPDATE when the config differs from live (or CREATE when no live yet).
	const singletons: [string, unknown, unknown][] = [
		["network", live?.network, desired.network],
		["cluster", live?.cluster, desired.cluster],
		["dns", live?.dns, desired.dns],
		["repositories", live?.repositories, desired.repositories],
	];
	for (const [type, l, d] of singletons) {
		if (changed(l, d))
			rows.push({
				component_type: type,
				component_id: null,
				op: l ? "UPDATE" : "CREATE",
				payload: asRecord(d),
			});
	}
	// Array components keyed by name.
	rows.push(...diffArray("database", live?.databases ?? [], desired.databases ?? []));
	rows.push(...diffArray("cache", live?.caches ?? [], desired.caches ?? []));
	rows.push(...diffArray("queue", live?.queues ?? [], desired.queues ?? []));
	rows.push(...diffArray("topic", live?.topics ?? [], desired.topics ?? []));
	rows.push(...diffArray("nosql", live?.nosql_tables ?? [], desired.nosql_tables ?? []));
	rows.push(...diffArray("secret", live?.secrets ?? [], desired.secrets ?? []));
	rows.push(
		...diffArray("bucket", live?.storage_buckets ?? [], desired.storage_buckets ?? []),
	);
	rows.push(
		...diffArray(
			"registry",
			live?.container_registries ?? [],
			desired.container_registries ?? [],
		),
	);
	rows.push(
		...diffArray(
			"helm_registry",
			live?.helm_registries ?? [],
			desired.helm_registries ?? [],
		),
	);
	rows.push(...diffArray("service", live?.services ?? [], desired.services ?? []));
	rows.push(
		...diffArray("source_repo", live?.source_repos ?? [], desired.source_repos ?? []),
	);
	return rows;
}
