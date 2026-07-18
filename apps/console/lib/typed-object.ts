// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// TypeScript types Object.keys/entries/values as string[] / [string, V][] / V[] by design —
// a value's runtime shape can carry keys beyond its static type, so the stdlib can't promise
// the narrow key type. For a record whose shape we KNOW is exact, these helpers return the
// precise key/entry/value types. The single assertion in each is the irreducible cost of that
// stdlib typing, isolated HERE so every call site stays cast-free. Use only on records you own
// (not on external/`Record<string, unknown>` bags where extra keys are genuinely possible).

/** `Object.keys` with the precise `keyof T` element type. */
export function typedKeys<T extends object>(o: T): (keyof T)[] {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Object.keys is string[] by spec; for a known-exact record these ARE keyof T (the single place this is asserted)
	return Object.keys(o) as (keyof T)[];
}

/** `Object.values` with the precise value type. */
export function typedValues<T extends object>(o: T): T[keyof T][] {
	return Object.values(o);
}

/** `Object.entries` with precise `[keyof T, value]` tuples. */
export function typedEntries<T extends object>(o: T): [keyof T, T[keyof T]][] {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Object.entries keys are string by spec; for a known-exact record these ARE keyof T (the single place this is asserted)
	return Object.entries(o) as [keyof T, T[keyof T]][];
}

/**
 * A record value by an arbitrary (possibly-untyped) key, or undefined when the key is absent.
 * Scans own entries so the value comes back at its declared type without indexing `T` by a
 * broad key — lookups against a `Record<Enum, V>` by a plain `string` stay cast-free.
 */
export function lookup<T extends object>(
	record: T,
	key: PropertyKey,
): T[keyof T] | undefined {
	for (const [k, v] of Object.entries(record)) if (k === key) return v;
	return undefined;
}
