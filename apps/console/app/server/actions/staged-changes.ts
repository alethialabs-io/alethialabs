"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { asRecord } from "@/lib/records";
import { withActorScope } from "@/lib/db";
import { projectChanges } from "@/lib/db/schema";
import type { StagedChangePayload } from "@/types/jsonb.types";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import {
	type CreateProjectInput,
	getProjectAsFormData,
	updateProjectDesign,
} from "./projects";

type Op = "CREATE" | "UPDATE" | "DELETE";

interface DiffRow {
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
function diffConfig(
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
	return rows;
}

/** Scopes the staging rows to one (project, environment) — the canvas always edits the env in
 * `?environment_id=`, so each environment owns its own pending diff. */
function changeScope(projectId: string, environmentId: string) {
	return and(
		eq(projectChanges.project_id, projectId),
		eq(projectChanges.environment_id, environmentId),
	);
}

/** An environment's durable staged changes (canvas diff), newest patches last. */
export async function listStagedChanges(
	projectId: string,
	environmentId: string,
) {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, (tx) =>
		tx
			.select()
			.from(projectChanges)
			.where(changeScope(projectId, environmentId))
			.orderBy(projectChanges.created_at),
	);
}

/**
 * Replace an environment's staged changes with the diff of the desired canvas config against
 * that environment's live config — so the Pending Changes bar is durable + shared across sessions.
 */
export async function stageChanges(
	projectId: string,
	environmentId: string,
	data: CreateProjectInput,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const owner = actor.userId;
	const live = await getProjectAsFormData(projectId, environmentId)
		.then((r) => r.formData)
		.catch(() => null);
	const rows = diffConfig(live, data);
	return withActorScope(actor, async (tx) => {
		await tx.delete(projectChanges).where(changeScope(projectId, environmentId));
		if (rows.length)
			await tx.insert(projectChanges).values(
				rows.map((r) => ({
					project_id: projectId,
					environment_id: environmentId,
					user_id: owner,
					...r,
				})),
			);
		return { count: rows.length };
	});
}

/** Clear an environment's staged changes (the Discard action). */
export async function discardStagedChanges(
	projectId: string,
	environmentId: string,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		await tx.delete(projectChanges).where(changeScope(projectId, environmentId));
		return { success: true };
	});
}

/**
 * Apply the desired config to the environment's live component tables (updateProjectDesign) and
 * clear its staged rows. The canvas is the source of truth, so the full desired config is passed
 * in; the staged rows are the durable record of *what* changed for the bar.
 */
export async function applyStagedChanges(
	projectId: string,
	environmentId: string,
	data: CreateProjectInput,
) {
	await updateProjectDesign(projectId, environmentId, data);
	const actor = await authorize("edit", { type: "project", id: projectId });
	await withActorScope(actor, async (tx) => {
		await tx.delete(projectChanges).where(changeScope(projectId, environmentId));
	});
	return { success: true };
}
