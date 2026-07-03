// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import labels from "react-phone-number-input/locale/en.json";

/**
 * Country reference data, derived once from react-phone-number-input's English
 * locale labels. This module is **data only** (no React, no flag components), so
 * it is safe to import from the shared zod schema and the server action as well
 * as client components. Flags are imported separately inside the client UI.
 */

export interface CountryOption {
	/** ISO 3166-1 alpha-2 code, e.g. "BG". */
	code: string;
	/** English display name, e.g. "Bulgaria". */
	name: string;
}

/** Locale keys that are not real countries and must be excluded. */
const NON_COUNTRY_KEYS = new Set(["ZZ", "ext", "country", "phone"]);

/** All selectable countries, sorted by display name. */
export const COUNTRY_OPTIONS: CountryOption[] = Object.entries(
	labels as Record<string, string>,
)
	.filter(([code]) => /^[A-Z]{2}$/.test(code) && !NON_COUNTRY_KEYS.has(code))
	.map(([code, name]) => ({ code, name }))
	.sort((a, b) => a.name.localeCompare(b.name));

const NAME_BY_CODE = new Map(COUNTRY_OPTIONS.map((c) => [c.code, c.name]));

/** Resolves an ISO-2 code to its English name, falling back to the code itself. */
export function countryName(code: string | undefined | null): string {
	if (!code) return "";
	return NAME_BY_CODE.get(code) ?? code;
}
