// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The CLI's reconfigure rule for a catalog add-on (#5545): a field the caller leaves out keeps what
// is stored, and only an explicit value changes it.
//
// It lives at the CLI edge, not in `enableAddon`, because the two callers send different things.
// The console's configure card always sends the WHOLE state — every knob, the Advanced YAML box and
// the mode, each prefilled from the stored row — so for it an absent knob or an empty box is a
// deliberate reset. The CLI sends only what the operator typed, so for it an absent field means
// "unchanged". Moving this rule into the action would make the console's "I emptied this optional
// field" indistinguishable from "I did not mention it".

import { and, eq } from "drizzle-orm";
import { stripAddonSecrets } from "@/lib/addons/secrets";
import type { AddOnDef } from "@/lib/addons/types";
import { getServiceDb } from "@/lib/db";
import { type AddonMode, projectAddons, projects } from "@/lib/db/schema";
import { asRecord } from "@/lib/records";
import type { AddOnValues } from "@/types/jsonb.types";

/** What is stored for one add-on in one environment — the part a reconfigure can keep. */
export interface StoredAddon {
	mode: AddonMode;
	values: AddOnValues;
	valuesYaml: string | null;
}

/** The CLI's request, as the route's zod schema parsed it. Absent and `null` are different here. */
export interface CliAddonRequest {
	mode?: AddonMode;
	values?: Record<string, unknown>;
	values_yaml?: string | null;
}

/** The mode, knobs and Advanced YAML to hand `enableAddon`, after the keep/clear rule. */
export interface ReconfigureInput {
	mode: AddonMode | undefined;
	values: AddOnValues;
	valuesYaml: string | null;
}

/**
 * Reads the stored row for (project, environment, add-on), or null when the add-on is not enabled
 * there. Org-scoped through an explicit projects.org_id join, because the service connection
 * bypasses RLS.
 *
 * The read is not in `enableAddon`'s transaction. Two concurrent reconfigures of one add-on are
 * last-writer-wins either way; what this read decides is only what an OMITTED field carries forward.
 */
export async function loadStoredAddon(
	orgId: string,
	projectId: string,
	environmentId: string,
	addonId: string,
): Promise<StoredAddon | null> {
	const [row] = await getServiceDb()
		.select({
			mode: projectAddons.mode,
			values: projectAddons.values,
			values_yaml: projectAddons.values_yaml,
		})
		.from(projectAddons)
		.innerJoin(projects, eq(projectAddons.project_id, projects.id))
		.where(
			and(
				eq(projectAddons.project_id, projectId),
				eq(projectAddons.environment_id, environmentId),
				eq(projectAddons.addon_id, addonId),
				eq(projects.org_id, orgId),
			),
		)
		.limit(1);
	if (!row) return null;
	return { mode: row.mode, values: row.values ?? {}, valuesYaml: row.values_yaml };
}

/**
 * Applies the keep/clear rule to a CLI request against what is stored.
 *
 * - `values_yaml` — absent keeps the stored override; `null` or `""` clears it; anything else
 *   replaces it whole (the override is one document, not merged key by key). This is the same rule
 *   `version` follows.
 * - `values` — each key sent is merged over the stored knobs; a key sent as `null` is removed, so
 *   the add-on's default applies to it again; a key not sent keeps its stored value. Secret knobs
 *   are dropped from the stored side here and carried forward by `enableAddon`'s
 *   `mergeAddonSecrets`, so a reconfigure never re-encrypts or blanks one.
 * - `mode` — absent keeps the stored mode (the action's `managed` default applies only to a first
 *   install).
 *
 * With nothing stored, the request is taken as given, minus any `null` knobs.
 */
export function reconfigureInput(
	def: AddOnDef,
	stored: StoredAddon | null,
	req: CliAddonRequest,
): ReconfigureInput {
	const values: AddOnValues = stored
		? stripAddonSecrets(def, asRecord(stored.values))
		: {};
	for (const [key, value] of Object.entries(req.values ?? {})) {
		if (value === null) delete values[key];
		else values[key] = value;
	}
	const valuesYaml =
		req.values_yaml === undefined ? (stored?.valuesYaml ?? null) : req.values_yaml || null;
	return { mode: req.mode ?? stored?.mode, values, valuesYaml };
}
