// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for a drizzle transaction's select chain, for the MCP read modules' tests: each
// `select()` answers the next queued row set once awaited, whatever `from/innerJoin/where/orderBy/limit` it is
// given, and records that it ran.

import { vi } from "vitest";

/** A select chain that resolves to `rows` when awaited. */
interface SelectChain {
	from: () => SelectChain;
	innerJoin: () => SelectChain;
	where: () => SelectChain;
	orderBy: () => SelectChain;
	limit: () => SelectChain;
	then: <R>(resolve: (rows: unknown[]) => R, reject?: (err: unknown) => R) => Promise<R>;
}

/** A chain that resolves to `rows`. */
function chainOf(rows: unknown[]): SelectChain {
	const chain: SelectChain = {
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: () => chain,
		then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
	};
	return chain;
}

/** A transaction whose successive `select()` calls answer `rowSets` in order (then empty). */
export function txAnswering(...rowSets: unknown[][]) {
	const queue = [...rowSets];
	return { select: vi.fn(() => chainOf(queue.shift() ?? [])) };
}
