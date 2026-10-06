// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the CLI needs to know about the add-on catalog to check and diff an `alethia.yaml` (#5528).
//
// Two readers, one source. `GET /api/cli/schema/addons` publishes the catalog document — which ids
// exist, which of their settings are secret, what each setting defaults to, and the one rule a
// chart-version pin must meet — so `alethia plan` can refuse what the server would certainly refuse
// without holding a second copy of any of it. `GET /api/cli/projects/:id/addons` uses
// `storedAddonSettings` to return a row's stored settings with every secret REMOVED (not masked), so
// `plan` can diff a declared setting against the stored one and a secret's value never leaves the
// server on this path.

import {
	CHART_VERSION_MAX_LENGTH,
	CHART_VERSION_PATTERN,
	CHART_VERSION_REFUSAL,
} from "@/lib/addons/chart-version";
import { ADDON_CATALOG, getAddOn } from "@/lib/addons/catalog";
import { secretFieldKeys, stripAddonSecrets } from "@/lib/addons/secrets";
import type { AddOnDef, AddOnField } from "@/lib/addons/types";
import { asRecord } from "@/lib/records";

/** One catalog add-on as the CLI sees it. */
export interface AddonCatalogEntry {
	id: string;
	/** The catalog's default chart version — what applies when an environment holds no pin. */
	version: string;
	/** Names of the settings that are secret. Values never appear in this document. */
	secret_keys: string[];
	/** What each NON-secret setting is when nothing is stored for it — the value a reset lands on. */
	defaults: Record<string, unknown>;
}

/** The catalog document `GET /api/cli/schema/addons` serves. */
export interface AddonCatalogDocument {
	addons: AddonCatalogEntry[];
	/** The chart-version rule, published so the CLI asks the same question the server does. */
	chart_version: { pattern: string; max_length: number; refusal: string };
}

/**
 * The value each non-secret setting takes when nothing is stored for it.
 *
 * The add-on's own `configSchema` decides, because it is what `enableAddon` runs: a stored row is
 * `configSchema.parse(values)`, so a setting reset with `key: null` is stored as exactly this. A
 * schema that refuses `{}` (a required setting with no default) falls back to the field
 * descriptors' declared defaults, which describe the same knobs for the configure form.
 */
export function addonSettingDefaults(def: AddOnDef): Record<string, unknown> {
	const parsed = def.configSchema.safeParse({});
	const raw = parsed.success ? asRecord(parsed.data) : descriptorDefaults(def.fields);
	return stripAddonSecrets(def, raw);
}

/** The declared defaults of a list of field descriptors, one nested level deep. */
function descriptorDefaults(fields: AddOnField[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		if (f.type === "nested" && f.fields) {
			const nested = descriptorDefaults(f.fields);
			if (Object.keys(nested).length > 0) out[f.key] = nested;
		} else if (f.default !== undefined) {
			out[f.key] = f.default;
		}
	}
	return out;
}

/** Builds the catalog document from the committed catalog. Holds no tenant data. */
export function addonCatalogDocument(): AddonCatalogDocument {
	return {
		addons: ADDON_CATALOG.map((def) => ({
			id: def.id,
			version: def.version,
			secret_keys: secretFieldKeys(def),
			defaults: addonSettingDefaults(def),
		})),
		chart_version: {
			pattern: CHART_VERSION_PATTERN.source,
			max_length: CHART_VERSION_MAX_LENGTH,
			refusal: CHART_VERSION_REFUSAL,
		},
	};
}

/**
 * A stored row's settings for the CLI read: every secret key REMOVED, plus the secret key names.
 *
 * Removed rather than masked, so no envelope, ciphertext or marker reaches the CLI. An add-on id the
 * catalog no longer knows has no way to say which keys are secret, so it returns NO settings at all
 * rather than guessing — failing closed is the only safe answer for a read that might carry one.
 */
export function storedAddonSettings(
	addonId: string,
	values: unknown,
): { settings: Record<string, unknown>; secret_keys: string[] } {
	const def = getAddOn(addonId);
	if (!def) return { settings: {}, secret_keys: [] };
	return {
		settings: stripAddonSecrets(def, asRecord(values)),
		secret_keys: secretFieldKeys(def),
	};
}
