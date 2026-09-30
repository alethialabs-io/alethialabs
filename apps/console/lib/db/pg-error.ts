// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQLSTATE `update_job_status` raises when a runner posts for a job it does not (or no longer)
 * own — stale-job recovery requeued it. Project-defined in programmables.sql; nothing else raises
 * it. The status route answers 409 for it so the runner can tell a lost claim from a transient
 * failure (#5162).
 */
export const JOB_NOT_OWNED_SQLSTATE = "AL409";

/** Every error in a `cause` chain, outermost first.
 *
 * Drizzle WRAPS the driver error: what a failing `.insert()` throws is a DrizzleQueryError whose
 * message is "Failed query: insert into ..." and whose `cause` is the postgres.js error carrying
 * `code` and `constraint_name`. Inspecting only the thrown object finds neither, so a check written
 * against the driver's shape silently never fires and every unique violation falls through as an
 * unmapped 500. That is not hypothetical — it is what the integration suite caught here. The depth
 * bound is paranoia about a self-referential cause, not a real chain length. */
export function causeChain(err: unknown): unknown[] {
	const chain: unknown[] = [];
	let cur = err;
	for (let i = 0; i < 8 && cur !== null && cur !== undefined; i++) {
		chain.push(cur);
		if (typeof cur !== "object" || cur === null || !("cause" in cur)) break;
		// `in` narrows; no cast — CLAUDE.md §6 forbids `as`, and the narrowing is what makes the
		// read safe rather than asserted.
		const next: unknown = cur.cause;
		if (next === cur) break;
		cur = next;
	}
	return chain;
}

/** The Postgres error code (SQLSTATE), if this error or anything it wraps carries one. */
export function pgErrorCode(err: unknown): string | undefined {
	for (const link of causeChain(err)) {
		if (typeof link === "object" && link !== null && "code" in link) {
			const code: unknown = link.code;
			if (typeof code === "string") return code;
		}
	}
	return undefined;
}
