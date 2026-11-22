// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The slice of Cloudflare's runtime this Worker touches, declared here instead of pulling in
// @cloudflare/workers-types (the same choice apps/e2e-issuer makes). Each interface names only what
// the code calls, so the test doubles in tests/helpers/fake-bindings.ts can satisfy them
// structurally — no cast anywhere between the real binding and the fake.
//
// Rows come back as `Row`, not as a caller-chosen generic: D1 returns whatever SQLite holds, and the
// readers in worker.ts narrow each column instead of trusting a type parameter.

/** One result row, as D1 returns it: column name to SQLite value. */
export type Row = Record<string, unknown>;

/** A value D1 accepts as a bound parameter (the subset this Worker binds). */
export type BindValue = string | number | null;

/** A prepared D1 statement. */
export interface D1PreparedStatement {
	bind(...values: BindValue[]): D1PreparedStatement;
	all(): Promise<{ results: Row[] }>;
	run(): Promise<unknown>;
}

/** A D1 database binding. `batch` runs its statements in one transaction. */
export interface D1Database {
	prepare(query: string): D1PreparedStatement;
	batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

/** A Workers KV namespace binding, read as text. */
export interface KVNamespace {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
}

/** The cron event a `scheduled()` handler receives. Nothing here reads it. */
export interface ScheduledController {
	readonly scheduledTime: number;
	readonly cron: string;
}

/** Keeps an invocation alive until the promise settles. */
export interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
}
