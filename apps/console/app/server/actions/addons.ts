"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Marketplace add-on server actions — enable / configure / disable free OSS Helm charts on a
// project environment, and read the catalog + install state for the Add-ons page. Add-ons are
// applied by the runner on the next DEPLOY (managed mode renders an ArgoCD Application); this
// layer only persists intent + the tuned knobs into project_addons.

import { asRecord } from "@/lib/records";
import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	type AddonMode,
	type ComponentStatus,
	projectAddons,
	projectRepositories,
	projects,
} from "@/lib/db/schema";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { ADDON_CATALOG, getAddOn, parseValuesYaml } from "@/lib/addons/catalog";
import { mergeAddonSecrets, redactAddonSecrets } from "@/lib/addons/secrets";
import type {
	AddOnCategory,
	AddOnField,
	AddOnIcon,
	AddOnRequirement,
} from "@/lib/addons/types";
import type { AddOnValues } from "@/types/jsonb.types";

/** The install state of an add-on on an environment (null when not enabled). */
export interface AddonInstallState {
	enabled: boolean;
	mode: AddonMode;
	values: AddOnValues;
	/** Raw Helm-values YAML override (Advanced), or null. */
	valuesYaml: string | null;
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
	/** Whether the environment has a GitOps apps repo configured — gates GitOps mode. */
	hasAppsRepo: boolean;
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

	// `project_addons` / `project_repositories` are RLS-less project-child tables, so the
	// org boundary is enforced HERE, not by a policy: join to the parent project and filter
	// on the caller's org (mirrors lib/queries/evidence.ts queryOrgEvidence and drift.ts).
	// The service db bypasses RLS, so the explicit `projects.org_id = actor.orgId` predicate
	// is the tenancy wall — a foreign project UUID yields no rows even though the org-blind
	// PDP grant let authorize() through. Using actor.orgId (not withOwnerScope on
	// actor.userId) keeps it correct for Teams orgs (project owned by another member).
	const db = getServiceDb();
	const rows = await db
		.select({
			addon_id: projectAddons.addon_id,
			enabled: projectAddons.enabled,
			mode: projectAddons.mode,
			values: projectAddons.values,
			values_yaml: projectAddons.values_yaml,
			status: projectAddons.status,
			health: projectAddons.health,
			sync_status: projectAddons.sync_status,
			last_synced_at: projectAddons.last_synced_at,
		})
		.from(projectAddons)
		.innerJoin(projects, eq(projectAddons.project_id, projects.id))
		.where(
			and(
				eq(projectAddons.project_id, projectId),
				eq(projectAddons.environment_id, envId),
				eq(projects.org_id, actor.orgId),
			),
		);
	// GitOps mode needs a destination apps repo on this environment.
	const [repo] = await db
		.select({ repo: projectRepositories.apps_destination_repo })
		.from(projectRepositories)
		.innerJoin(projects, eq(projectRepositories.project_id, projects.id))
		.where(
			and(
				eq(projectRepositories.project_id, projectId),
				eq(projectRepositories.environment_id, envId),
				eq(projects.org_id, actor.orgId),
			),
		)
		.limit(1);
	const hasAppsRepo = Boolean(repo?.repo);
	const byId = new Map(rows.map((r) => [r.addon_id, r]));

	const items: AddonMarketItem[] = ADDON_CATALOG.map((def) => {
		const row = byId.get(def.id);
		const install: AddonInstallState | null = row
			? {
					enabled: row.enabled,
					mode: row.mode,
					// Secrets redacted for the client — a set/unset marker, never the stored ciphertext.
					values: redactAddonSecrets(def, row.values ?? {}),
					valuesYaml: row.values_yaml,
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

	return { environmentId: envId, items, hasAppsRepo };
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
	values?: AddOnValues;
	/** Raw Helm-values YAML override (Advanced). Validated as YAML here. */
	valuesYaml?: string | null;
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
	// Validate the raw YAML override parses to a mapping (reject a scalar/list/garbage here).
	const valuesYaml = input.valuesYaml?.trim() ? input.valuesYaml : null;
	if (valuesYaml && !parseValuesYaml(valuesYaml)) {
		throw new Error(
			"Advanced values must be valid YAML describing a mapping (key: value).",
		);
	}
	const envId = await resolveActiveEnvironmentId(
		input.projectId,
		input.environmentId,
	);
	const mode: AddonMode = input.mode ?? "managed";

	await withOwnerScope(actor.userId, async (tx) => {
		// Encrypt secret knobs before they touch the DB (stored as EncryptedSecret, never plaintext —
		// W4), PRESERVING any secret the user left blank: the row is replaced wholesale, so without
		// this a reconfigure of other knobs would wipe a set secret. Read the existing envelopes and
		// carry them forward for untouched secrets (mergeAddonSecrets).
		const [existing] = await tx
			.select({ values: projectAddons.values })
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, def.id),
				),
			)
			.limit(1);
		const storedValues: AddOnValues = mergeAddonSecrets(
			def,
			asRecord(parsed.data),
			existing?.values ?? null,
		);
		await tx
			.insert(projectAddons)
			.values({
				project_id: input.projectId,
				environment_id: envId,
				addon_id: def.id,
				enabled: true,
				mode,
				values: storedValues,
				values_yaml: valuesYaml,
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
					values: storedValues,
					values_yaml: valuesYaml,
					status: "PENDING",
					updated_at: new Date(),
				},
			});
	});
	return { ok: true };
}

/**
 * Disables an add-on: removes the project_addons row so it is no longer in the desired set.
 * The live cluster is reconciled on the next Deploy — managed add-ons are pruned
 * (`argocd.PruneManagedAddOns`) and gitops manifests are removed from the apps repo.
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
