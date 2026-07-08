// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Small, reusable type guards shared across the console.

/**
 * Membership test that narrows `value` to the array's element type on success.
 * Works around TS's `ReadonlyArray<T>.includes(x: T)` signature, which rejects a
 * wider `value` (e.g. `string`) and forces callers to cast the array to
 * `string[]`. Use `arrayIncludes(list, value)` instead of
 * `(list as string[]).includes(value)` to keep the narrowing.
 */
export function arrayIncludes<T>(
	arr: readonly T[],
	value: unknown,
): value is T {
	return arr.includes(value as T);
}
