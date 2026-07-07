"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Marketplace add-on server actions — enable / configure / disable free OSS Helm charts on a
// project environment, and read the catalog + install state for the Add-ons page. Add-ons are
// applied by the runner on the next DEPLOY (managed mode renders an ArgoCD Application); this
// layer only persists intent + the tuned knobs into project_addons.

import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";
import { type AddonMode, type ComponentStatus, projectAddons } from "@/lib/db/schema";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { ADDON_CATALOG, getAddOn } from "@/lib/addons/catalog";
import type {
	AddOnCategory,
	AddOnField,
	AddOnIcon,
	AddOnRequirement,
} from "@/lib/addons/types";

/** The install state of an add-on on an environment (null when not enabled). */
export interface AddonInstallState {
	enabled: boolean;
	mode: AddonMode;
	values: Record<string, unknown>;
	status: ComponentStatus;
	health: string | null;
	sync: string | null;
	lastSyncedAt: string | null;
}

/** One marketplace row: the catalog display metadata + this environment's install state. */
export interface AddonMarketItem {
	id: string;
	name: string;
	category: AddOnCategory;
	icon: AddOnIcon;
	summary: string;
	docsUrl: string;
	license: string;
	chart: string;
	version: string;
	namespace: string;
	requires: AddOnRequirement[];
	fields: AddOnField[];
	install: AddonInstallState | null;
}

export interface ProjectAddonsView {
	environmentId: string;
	items: AddonMarketItem[];
}

/**
 * The catalog joined with an environment's install state — the Add-ons page payload. Resolves
 * the active environment (the given one, else the project default) since add-ons are
 * environment-scoped.
 */
export async function getProjectAddons(
	projectId: string,
	environmentId?: string | null,
): Promise<ProjectAddonsView> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envId = await resolveActiveEnvironmentId(projectId, environmentId);

	const rows = await withOwnerScope(actor.userId, async (tx) =>
		tx
			.select()
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, projectId),
					eq(projectAddons.environment_id, envId),
				),
			),
	);
	const byId = new Map(rows.map((r) => [r.addon_id, r]));

	const items: AddonMarketItem[] = ADDON_CATALOG.map((def) => {
		const row = byId.get(def.id);
		const install: AddonInstallState | null = row
			? {
					enabled: row.enabled,
					mode: row.mode,
					values: row.values ?? {},
					status: row.status,
					health: row.health,
					sync: row.sync_status,
					lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
				}
			: null;
		return {
			id: def.id,
			name: def.name,
			category: def.category,
			icon: def.icon,
			summary: def.summary,
			docsUrl: def.docsUrl,
			license: def.license,
			chart: def.chart,
			version: def.version,
			namespace: def.namespace,
			requires: def.requires ?? [],
			fields: def.fields,
			install,
		};
	});

	return { environmentId: envId, items };
}

/**
 * Enables (or reconfigures) an add-on on an environment: validates the knobs against the
 * add-on's Zod schema, then upserts the project_addons row as PENDING so the next DEPLOY
 * applies it. Re-enabling an existing add-on resets it to PENDING with the new config.
 */
export async function enableAddon(input: {
	projectId: string;
	environmentId?: string | null;
	addonId: string;
	mode?: AddonMode;
	values?: Record<string, unknown>;
}): Promise<{ ok: true }> {
	const actor = await authorize("edit", {
		type: "project",
		id: input.projectId,
	});
	const def = getAddOn(input.addonId);
	if (!def) throw new Error(`Unknown add-on: ${input.addonId}`);
	// Validate + normalise the knobs (defaults filled) so a bad value is rejected here, not
	// mid-deploy.
	const parsed = def.configSchema.safeParse(input.values ?? {});
	if (!parsed.success) {
		throw new Error(`Invalid add-on configuration: ${parsed.error.message}`);
	}
	const envId = await resolveActiveEnvironmentId(
		input.projectId,
		input.environmentId,
	);
	const mode: AddonMode = input.mode ?? "managed";

	await withOwnerScope(actor.userId, async (tx) => {
		await tx
			.insert(projectAddons)
			.values({
				project_id: input.projectId,
				environment_id: envId,
				addon_id: def.id,
				enabled: true,
				mode,
				values: parsed.data as Record<string, unknown>,
				namespace: def.namespace,
				status: "PENDING",
			})
			.onConflictDoUpdate({
				target: [
					projectAddons.project_id,
					projectAddons.environment_id,
					projectAddons.addon_id,
				],
				set: {
					enabled: true,
					mode,
					values: parsed.data as Record<string, unknown>,
					status: "PENDING",
					updated_at: new Date(),
				},
			});
	});
	return { ok: true };
}

/**
 * Disables an add-on: removes the project_addons row so it is no longer rendered on deploy.
 * NB: this does not yet prune the live ArgoCD Application in-cluster (Phase 2 adds a runner
 * prune step); until then a disabled add-on stops being managed but its workloads remain.
 */
export async function disableAddon(input: {
	projectId: string;
	environmentId?: string | null;
	addonId: string;
}): Promise<{ ok: true }> {
	const actor = await authorize("edit", {
		type: "project",
		id: input.projectId,
	});
	const envId = await resolveActiveEnvironmentId(
		input.projectId,
		input.environmentId,
	);
	await withOwnerScope(actor.userId, async (tx) => {
		await tx
			.delete(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, input.addonId),
				),
			);
	});
	return { ok: true };
}
