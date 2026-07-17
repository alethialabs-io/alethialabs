// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reading dynamic (runtime-only) string keys off an `unknown` value — parsed JSON, a config bag,
// an external payload. TypeScript can't index `object` by an arbitrary string without an index
// signature, and `Object.keys`-style narrowing doesn't apply to a bag whose keys we don't know
// statically, so this ONE assertion (isolated here) is the irreducible cost of that pattern. Every
// caller stays cast-free: a non-object yields an empty record, so property reads degrade to
// `undefined` rather than crashing.

/** An unknown value as a readable string-keyed record ({} when it isn't a non-null object). */
export function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null
		? (v as Record<string, unknown>)
		: {};
}

/** An unknown value as an array of string-keyed records (each element coerced via asRecord). */
export function toRecordArray(v: unknown): Record<string, unknown>[] {
	return Array.isArray(v) ? v.map(asRecord) : [];
}
