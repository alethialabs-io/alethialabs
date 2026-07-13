// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared LIKE/ILIKE helpers. A user-supplied search term must have its LIKE
// metacharacters (`%`, `_`, `\`) escaped so they match literally instead of acting as
// wildcards — otherwise a search for "a_b" or "50%" silently behaves as a wildcard query.
// Drizzle parameterizes the value (no SQL injection), but the wildcard semantics are the
// caller's to control.

/** Escapes the LIKE wildcards in a user-supplied search term. */
export function escapeLike(term: string): string {
	return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** A contains-match pattern for `ilike`/`like`: the escaped term wrapped in `%…%`. */
export function likeTerm(term: string): string {
	return `%${escapeLike(term)}%`;
}
