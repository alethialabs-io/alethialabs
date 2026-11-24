// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for the drizzle executor the approval engine reads and writes through. SELECTs are
// answered per table, in the order the engine asks (a queue of row lists per table; an exhausted queue
// answers no rows). UPDATEs and INSERTs are recorded; an UPDATE … RETURNING answers from a queue per
// table too. It implements only the chain shapes lib/approvals uses, and fails the test on any other.

import type { Tx } from "@/lib/db";

/** One recorded write. */
export interface Write {
	kind: "update" | "insert";
	table: unknown;
	values: unknown;
}

/** The fake, and what it saw. */
export interface FakeExecutor {
	db: Tx;
	writes: Write[];
	/** How many SELECTs each table was asked. */
	selects: Map<unknown, number>;
	/** Every SELECT, in order, by table. */
	selectOrder: unknown[];
}

/**
 * A fake executor. `reads` maps a drizzle table to the row lists its successive SELECTs answer;
 * `returning` maps a table to the row lists its successive UPDATE/INSERT … RETURNING answer.
 */
export function fakeExecutor(
	reads: Map<unknown, unknown[][]> = new Map(),
	returning: Map<unknown, unknown[][]> = new Map(),
): FakeExecutor {
	const writes: Write[] = [];
	const selects = new Map<unknown, number>();
	const selectOrder: unknown[] = [];

	/** The next answer queued for `table` in `queues`, or no rows. */
	const next = (queues: Map<unknown, unknown[][]>, table: unknown): unknown[] => queues.get(table)?.shift() ?? [];

	/** A result that is awaitable and also offers `.for("update")`. */
	const rowsResult = (rows: unknown[]) => Object.assign(Promise.resolve(rows), { for: () => Promise.resolve(rows) });

	const select = () => {
		let table: unknown;
		const chain = {
			from(t: unknown) {
				table = t;
				selects.set(t, (selects.get(t) ?? 0) + 1);
				selectOrder.push(t);
				return chain;
			},
			where: () => chain,
			orderBy: () => chain,
			limit: () => rowsResult(next(reads, table)),
		};
		return chain;
	};

	const write = (kind: Write["kind"]) => (table: unknown) => {
		const record: Write = { kind, table, values: undefined };
		writes.push(record);
		const done = Object.assign(Promise.resolve(undefined), {
			returning: () => Promise.resolve(next(returning, table)),
			onConflictDoNothing: () => done,
		});
		const after = {
			where: () => done,
			returning: () => Promise.resolve(next(returning, table)),
			onConflictDoNothing: () => done,
		};
		return {
			set(values: unknown) {
				record.values = values;
				return after;
			},
			values(values: unknown) {
				record.values = values;
				return after;
			},
		};
	};

	const impl = { select, update: write("update"), insert: write("insert") };
	// The fake implements only the chains lib/approvals uses; it stands in for the full executor.
	const db = impl as never as Tx;
	return { db, writes, selects, selectOrder };
}

/** A transaction that fails the test if it is touched. */
export function untouchableTx(): Tx {
	const refuse = (): never => {
		throw new Error("the approval engine used the transaction");
	};
	return new Proxy<Tx>(Object.create(null), { get: refuse, apply: refuse });
}
