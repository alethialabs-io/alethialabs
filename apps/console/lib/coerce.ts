// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cast-free coercions for `unknown` config/JSONB values into the primitive a control expects.
// A canvas node's config is an open bag (`Record<string, unknown>`), so reading a field yields
// `unknown`; these narrow with `typeof` / `Array.isArray` + a type predicate instead of asserting
// with `as`, so a wrong runtime shape degrades to the empty value rather than lying to the compiler.

/** An unknown value as a string, or "" when it is absent / not a string. */
export function toStr(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** An unknown value as a number, or "" — the empty form a numeric <input> wants when unset. */
export function toNum(v: unknown): number | "" {
	return typeof v === "number" ? v : "";
}

/** An unknown value as a string[], dropping any non-string members (never null/undefined). */
export function toStrArray(v: unknown): string[] {
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string")
		: [];
}

/** An unknown value as a number, or `fallback` when it isn't one. */
export function numOr(v: unknown, fallback: number): number {
	return typeof v === "number" ? v : fallback;
}

/** An unknown value as a boolean, or `fallback` when it isn't one. */
export function boolOr(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

/** An unknown value as an array of unknowns (empty when it isn't an array). */
export function toArray(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}
