"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Marketplace add-on server actions — enable / configure / disable free OSS Helm charts on a
// project environment, and read the catalog + install state for the Add-ons page. Add-ons are
// applied by the runner on the next DEPLOY (managed mode renders an ArgoCD Application); this
// layer only persists intent + the tuned knobs into project_addons. The READ (the catalog joined
// with an environment's install state) is `canvas.addons` in lib/rpc/procedures/canvas.ts (#6119).

import { asRecord } from "@/lib/records";
import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import {
	type AddonMode,
	type ComponentStatus,
	projectAddons,
} from "@/lib/db/schema";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { getAddOn, parseValuesYaml } from "@/lib/addons/catalog";
import { chartVersionIntent } from "@/lib/addons/chart-version";
import {
	generateAddonSecrets,
	mergeAddonSecrets,
} from "@/lib/addons/secrets";
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
	/** The pinned chart version, or null when the catalog's default version applies. */
	version: string | null;
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
 * Enables (or reconfigures) an add-on on an environment: validates the knobs against the
 * add-on's Zod schema, then upserts the project_addons row as PENDING so the next DEPLOY
 * applies it. Re-enabling an existing add-on resets it to PENDING with the new config.
 *
 * `version` pins the chart version (#5525): omitted keeps whatever pin is stored, `null` or `""`
 * clears it so the catalog default applies again, and anything else must be an exact chart version
 * (`lib/addons/chart-version.ts`) — it is rendered into the ArgoCD Application's targetRevision.
 */
export async function enableAddon(input: {
	projectId: string;
	environmentId?: string | null;
	addonId: string;
	mode?: AddonMode;
	values?: AddOnValues;
	/** Raw Helm-values YAML override (Advanced). Validated as YAML here. */
	valuesYaml?: string | null;
	/** Chart version pin: undefined keeps the stored pin, null or "" clears it. */
	version?: string | null;
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
		// Surface the PROSE, not the serialised error. `ZodError.message` is the issues array as
		// JSON, which reaches the configure form (and the CLI, which returns this same string) as a
		// wall of braces with the sentence buried inside it. Add-on schemas state their refusals in
		// words a user can act on — "AWS Route 53 authenticates ExternalDNS through workload
		// identity, not a token, so a Workload identity is required — an IAM role ARN" (#3469) — and
		// a refusal nobody can read is only marginally better than the silent install it replaced.
		const detail = parsed.error.issues
			.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
			.join("; ");
		throw new Error(`Invalid add-on configuration: ${detail}`);
	}
	// Validate the raw YAML override parses to a mapping (reject a scalar/list/garbage here).
	const valuesYaml = input.valuesYaml?.trim() ? input.valuesYaml : null;
	if (valuesYaml && !parseValuesYaml(valuesYaml)) {
		throw new Error(
			"Advanced values must be valid YAML describing a mapping (key: value).",
		);
	}
	// Refused here, before anything is written — this is the injection boundary for targetRevision.
	const versionIntent = chartVersionIntent(input.version);
	// `keep` writes nothing: a fresh row gets NULL (the catalog default), an existing one keeps its
	// pin because the column is absent from the conflict update.
	const versionWrite =
		versionIntent.kind === "keep"
			? {}
			: { version: versionIntent.kind === "set" ? versionIntent.version : null };
	const envId = await resolveActiveEnvironmentId(
		input.projectId,
		input.environmentId,
	);
	const mode: AddonMode = input.mode ?? "managed";

	await withActorScope(actor, async (tx) => {
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
		// Then mint any secret the add-on declares as auto-generated and that is STILL unset
		// (#2822, #2823). Ordered after the merge, so a value the user supplied — or one carried
		// forward from an earlier save — is already present and is never rotated by a reconfigure.
		// Without this, a chart that generates its own credential does so at RENDER time, and
		// ArgoCD re-renders on every reconcile: permanently OutOfSync, with the credential moving
		// under the running workload.
		const storedValues: AddOnValues = generateAddonSecrets(
			def,
			mergeAddonSecrets(def, asRecord(parsed.data), existing?.values ?? null),
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
				...versionWrite,
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
					...versionWrite,
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
	await withActorScope(actor, async (tx) => {
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
