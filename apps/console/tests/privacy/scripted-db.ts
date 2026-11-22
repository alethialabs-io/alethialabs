// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A drizzle-shaped fake for the privacy flows' tests: every awaited query takes the next answer
// from a script, and every query is recorded with its operation, table, values / set and where SQL.
//
// The privacy modules read and write through chains like `select().from().where().limit()` and
// `update().set().where().returning()`; a fake that hand-shapes each chain would be longer than the
// code under test. This one returns one builder for every chain method and resolves it when it is
// awaited, so a test states WHAT each query answers, in order, and asserts on what was asked.

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/** One query that reached the fake. */
export interface ScriptedCall {
	op: "select" | "insert" | "update" | "delete" | "execute";
	table?: unknown;
	values?: unknown;
	set?: unknown;
	where?: SQL;
	/** True when it ran inside `transaction`. */
	inTx: boolean;
}

const dialect = new PgDialect({ casing: "snake_case" });

/** The SQL text of a recorded where clause, for asserting on what was filtered. */
export function whereSql(call: ScriptedCall | undefined): string {
	return call?.where ? dialect.sqlToQuery(call.where).sql : "";
}

/** The bound parameters of a recorded where clause. */
export function whereParams(call: ScriptedCall | undefined): unknown[] {
	return call?.where ? dialect.sqlToQuery(call.where).params : [];
}

/** The fake, and the record of what it was asked. */
export interface ScriptedDb {
	db: unknown;
	calls: ScriptedCall[];
	/** Queues the answers of the next awaited queries, in order. */
	answer: (...rows: unknown[][]) => void;
}

/** Builds a scripted fake. An awaited query with no queued answer resolves to `[]`. */
export function scriptedDb(): ScriptedDb {
	const calls: ScriptedCall[] = [];
	const queue: unknown[][] = [];

	/** A builder for one query; every chain method returns it, awaiting it resolves the query. */
	function builder(call: ScriptedCall) {
		const chain: Record<string, unknown> = {};
		const self = new Proxy(chain, {
			get(_target, prop) {
				if (prop === "then") {
					calls.push(call);
					const rows = queue.shift() ?? [];
					return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
						Promise.resolve(rows).then(resolve, reject);
				}
				return (...args: unknown[]) => {
					if (prop === "from" || prop === "innerJoin" || prop === "leftJoin") {
						if (prop === "from") call.table = args[0];
					} else if (prop === "values") call.values = args[0];
					else if (prop === "set") call.set = args[0];
					else if (prop === "where") call.where = args[0] as SQL;
					return self;
				};
			},
		});
		return self;
	}

	/** The client surface, inside or outside a transaction. */
	function client(inTx: boolean): Record<string, unknown> {
		return {
			select: () => builder({ op: "select", inTx }),
			insert: (table: unknown) => builder({ op: "insert", table, inTx }),
			update: (table: unknown) => builder({ op: "update", table, inTx }),
			delete: (table: unknown) => builder({ op: "delete", table, inTx }),
			execute: (query: SQL) => builder({ op: "execute", where: query, inTx }),
			transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(client(true)),
		};
	}

	return {
		db: client(false),
		calls,
		answer: (...rows) => {
			queue.push(...rows);
		},
	};
}
