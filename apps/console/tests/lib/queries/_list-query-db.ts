// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A recording drizzle-ish `db` for the `query*Page` builders in lib/queries.
//
// It differs from the single-object thenable used by support.test.ts in one way that matters
// here: every `db.select()` returns its OWN chain object, so a builder that issues a filtered
// ROWS pass and an unfiltered FACET pass can be interrogated pass-by-pass. That is the point —
// the filter standard's invariant is precisely that the second pass was NOT handed the first
// pass's predicates, and a shared recorder cannot tell the two apart.
//
// Two orders exist and they are not the same order, which is the subtlety worth stating:
//
//   * `chains` is CREATION order — every `db.select()`, including the ones built inside
//     `exists(...)` subqueries, which are composed into a WHERE and never awaited.
//   * result sets are handed out in AWAIT order, from a shared queue. `Promise.all` calls
//     `.then` on its array in order, so this is deterministic; a subquery that is never
//     awaited never takes a result set, and so never shifts the ones behind it.
//
// Mixing them up is how a test of a five-pass builder ends up asserting against the wrong
// row set while still passing, so each test says which chain index it means and why.

/** One recorded `db.select()` chain. */
export interface RecordedChain {
	/** Creation order, counting `exists(...)` subqueries. */
	index: number;
	/** The projection passed to `.select(...)`, if any. */
	selectArgs: unknown[];
	/** Every builder method called on this chain, in order. */
	calls: { method: string; args: unknown[] }[];
	/** Args of the first `method` call, or undefined if it was never called. */
	argsOf(method: string): unknown[] | undefined;
	/** Whether `method` was called at all — `having`/`limit` absence is a real assertion. */
	called(method: string): boolean;
	/** Whether this chain was awaited (and therefore took a result set). */
	awaited: boolean;
}

const CHAIN_METHODS = [
	"from",
	"leftJoin",
	"innerJoin",
	"rightJoin",
	"fullJoin",
	"where",
	"groupBy",
	"having",
	"orderBy",
	"limit",
	"offset",
	"for",
] as const;

/**
 * A `db` whose `select()` chains record what they were given and resolve, in await order, to
 * `resultSets`. A chain awaited past the end of the queue resolves to `[]` rather than
 * throwing: a builder legitimately issues fewer reads on some paths (no rows → no follow-up
 * hydration pass), and the test for that path should read as a seeded empty, not a crash.
 */
export function mockChainDb(resultSets: unknown[][]) {
	const chains: RecordedChain[] = [];
	let cursor = 0;

	const db = {
		select(...selectArgs: unknown[]) {
			const calls: { method: string; args: unknown[] }[] = [];
			const rec: RecordedChain = {
				index: chains.length,
				selectArgs,
				calls,
				argsOf: (method) => calls.find((c) => c.method === method)?.args,
				called: (method) => calls.some((c) => c.method === method),
				awaited: false,
			};
			chains.push(rec);

			const chain: Record<string, unknown> = {};
			for (const method of CHAIN_METHODS) {
				chain[method] = (...args: unknown[]) => {
					calls.push({ method, args });
					return chain;
				};
			}
			chain.then = (resolve: (value: unknown) => void) => {
				rec.awaited = true;
				const rows = resultSets[cursor] ?? [];
				cursor += 1;
				return resolve(rows);
			};
			return chain;
		},
	};

	return { db: db as never, chains, awaitedCount: () => cursor };
}

/** A `Date` that round-trips to a stable ISO string, so `toISOString()` assertions are literal. */
export function at(iso: string): Date {
	return new Date(iso);
}
