// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { DatabaseSync } from "node:sqlite";
import type { BindValue, D1Database, D1PreparedStatement, KVNamespace, Row } from "../../src/bindings";

/**
 * A D1 and a KV that behave enough like Cloudflare's for `runCycle` to run.
 *
 * D1 IS SQLite, so the SQL is not simulated — it executes against the real engine. The database
 * starts EMPTY: the Worker applies its own schema (src/schema.ts), so every test also proves that
 * the self-applied schema is enough for every statement worker.ts issues. A bind-arity mismatch, a
 * column that does not exist, a JOIN that quietly returns nothing all type-check perfectly and would
 * otherwise first appear as the cron throwing a minute after the first deploy.
 *
 * What this deliberately does NOT model: D1's network errors, its row limits, KV's eventual
 * consistency. Those need the real thing.
 */
class FakeStatement implements D1PreparedStatement {
	/** A statement over `db`; `args` are the bound parameters. */
	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		private readonly args: BindValue[] = [],
	) {}

	/** Bind parameters, returning a new statement as D1 does. */
	bind(...values: BindValue[]): FakeStatement {
		return new FakeStatement(this.db, this.sql, values);
	}

	/** Every result row. */
	async all(): Promise<{ results: Row[] }> {
		return { results: this.db.prepare(this.sql).all(...this.args) };
	}

	/** Execute without reading rows. */
	async run(): Promise<void> {
		this.db.prepare(this.sql).run(...this.args);
	}
}

/** An in-memory D1 on node:sqlite. */
export class FakeD1 implements D1Database {
	readonly db = new DatabaseSync(":memory:");

	/** Prepare a statement. */
	prepare(sql: string): FakeStatement {
		return new FakeStatement(this.db, sql);
	}

	/**
	 * D1's `batch` is one transaction. Modelling that matters: `runCycle` inserts the checks and
	 * prunes the old ones in one batch, and a half-applied batch would leave the incident state machine
	 * reading a window that never existed.
	 */
	async batch(statements: D1PreparedStatement[]): Promise<void> {
		this.db.exec("BEGIN");
		try {
			for (const s of statements) await s.run();
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	/** Every row of a table, for assertions. */
	rows(table: string): Row[] {
		return this.db.prepare(`select * from ${table}`).all();
	}
}

/** An in-memory KV that counts writes — the free-tier gate is why the code is shaped as it is. */
export class FakeKV implements KVNamespace {
	private readonly store = new Map<string, string>();
	puts = 0;

	/** Read a key as text. */
	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	/** Write a key. */
	async put(key: string, value: string): Promise<void> {
		this.puts++;
		this.store.set(key, value);
	}
}
