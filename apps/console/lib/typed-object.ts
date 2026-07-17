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
	return Object.keys(o) as (keyof T)[];
}

/** `Object.values` with the precise value type. */
export function typedValues<T extends object>(o: T): T[keyof T][] {
	return Object.values(o) as T[keyof T][];
}

/** `Object.entries` with precise `[keyof T, value]` tuples. */
export function typedEntries<T extends object>(o: T): [keyof T, T[keyof T]][] {
	return Object.entries(o) as [keyof T, T[keyof T]][];
}
