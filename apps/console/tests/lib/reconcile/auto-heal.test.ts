// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// maybeAutoHeal — the service-role re-apply the job-status route fires on drift. Its SQL shape
// (the CAS + job insert in one transaction, the partial unique index) is proven by the integration
// suite (tests/integration/reconcile-b2c.test.ts, byo-iac-continuous.test.ts); this file pins the
// GUARDS at unit level: every early-out enqueues nothing, and the one path that does enqueues the
// last successful DEPLOY's frozen snapshot and wakes the scaler only after the transaction commits.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	/** Rows each awaited SELECT resolves to, consumed in call order. */
	const selects: unknown[][] = [];
	/** What the transaction body wrote. */
	const writes: { op: "update" | "insert"; table: unknown; payload: unknown }[] = [];

	/** A drizzle-shaped SELECT builder: every step returns itself; awaiting it resolves the next rows. */
	class Chain implements PromiseLike<unknown[]> {
		/** Builder step (no-op). */
		select(): this {
			return this;
		}
		/** Builder step (no-op). */
		from(): this {
			return this;
		}
		/** Builder step (no-op). */
		where(): this {
			return this;
		}
		/** Builder step (no-op). */
		orderBy(): this {
			return this;
		}
		/** Builder step (no-op). */
		limit(): this {
			return this;
		}
		/** Resolves the next scripted rows. */
		then<A = unknown[], B = never>(
			onFulfilled?: ((rows: unknown[]) => A | PromiseLike<A>) | null,
			onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
		): PromiseLike<A | B> {
			return Promise.resolve(selects.shift() ?? []).then(onFulfilled, onRejected);
		}
	}

	const tx = {
		/** Records an UPDATE's set payload. */
		update(table: unknown) {
			return {
				/** Records the payload. */
				set(payload: unknown) {
					writes.push({ op: "update", table, payload });
					return { where: (): Promise<void> => Promise.resolve() };
				},
			};
		},
		/** Records an INSERT's row. */
		insert(table: unknown) {
			return {
				/** Records the row. */
				values(payload: unknown): Promise<void> {
					writes.push({ op: "insert", table, payload });
					return Promise.resolve();
				},
			};
		},
	};

	const db = {
		/** Starts a scripted SELECT. */
		select: () => new Chain(),
		/** Runs the body against the recording tx. */
		transaction: <T>(body: (t: typeof tx) => Promise<T>): Promise<T> => body(tx),
	};
	return { db, selects, writes };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => fake.db }));
vi.mock("@/lib/db/env-status", () => ({ transitionEnv: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: <T>(values: T): T => values }));
vi.mock("@/lib/observability/trace", () => ({ newTraceparent: () => "00-trace-span-01" }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { transitionEnv } from "@/lib/db/env-status";
import { jobs, projectEnvironments } from "@/lib/db/schema";
import { maybeAutoHeal } from "@/lib/reconcile/auto-heal";
import { notifyScaler } from "@/lib/scaler";

/** An auto-heal-eligible environment row, with overrides. */
function env(over: Record<string, unknown> = {}) {
	return {
		id: "env-1",
		org_id: "org-1",
		user_id: "user-1",
		stage: "staging",
		status: "ACTIVE",
		auto_heal: true,
		auto_heal_failures: 0,
		last_auto_heal_at: null,
		...over,
	};
}

const LAST_DEPLOY = { config_snapshot: { region: "eu-west-1" }, cloud_identity_id: "ci-1" };

beforeEach(() => {
	vi.clearAllMocks();
	fake.selects.length = 0;
	fake.writes.length = 0;
	vi.mocked(transitionEnv).mockResolvedValue(true);
});

describe("maybeAutoHeal — guards that enqueue nothing", () => {
	it.each([
		["the environment does not exist", []],
		["auto-heal is off", [env({ auto_heal: false })]],
		["it is production (approval-gated)", [env({ stage: "production" })]],
		["another job holds the state", [env({ status: "PROVISIONING" })]],
		["it was torn down", [env({ status: "DESTROYED" })]],
		["the circuit breaker tripped", [env({ auto_heal_failures: 3 })]],
		["the backoff has not elapsed", [env({ auto_heal_failures: 1, last_auto_heal_at: new Date() })]],
	])("returns when %s", async (_why, rows) => {
		fake.selects.push(rows);
		await maybeAutoHeal("p1", "env-1");
		expect(transitionEnv).not.toHaveBeenCalled();
		expect(fake.writes).toEqual([]);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("returns when nothing was ever deployed", async () => {
		fake.selects.push([env()], []);
		await maybeAutoHeal("p1", "env-1");
		expect(transitionEnv).not.toHaveBeenCalled();
		expect(fake.writes).toEqual([]);
	});
});

describe("maybeAutoHeal — the enqueue", () => {
	it("re-applies the last DEPLOY's frozen snapshot once the backoff has elapsed", async () => {
		const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		fake.selects.push([env({ auto_heal_failures: 1, last_auto_heal_at: longAgo })], [LAST_DEPLOY]);
		await maybeAutoHeal("p1", "env-1");

		expect(transitionEnv).toHaveBeenCalledWith(expect.anything(), "env-1", "enqueueAutoHeal", null, {
			orgId: "org-1",
			projectId: "p1",
		});
		const update = fake.writes.find((w) => w.op === "update");
		expect(update?.table).toBe(projectEnvironments);
		expect(update?.payload).toEqual({ last_auto_heal_at: expect.any(Date) });
		const insert = fake.writes.find((w) => w.op === "insert");
		expect(insert?.table).toBe(jobs);
		expect(insert?.payload).toEqual({
			user_id: "user-1",
			org_id: "org-1",
			project_id: "p1",
			environment_id: "env-1",
			cloud_identity_id: "ci-1",
			job_type: "DEPLOY",
			config_snapshot: { region: "eu-west-1" },
			status: "QUEUED",
			traceparent: "00-trace-span-01",
		});
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("queues nothing and wakes nobody when the CAS loses the race", async () => {
		vi.mocked(transitionEnv).mockResolvedValue(false);
		fake.selects.push([env()], [LAST_DEPLOY]);
		await maybeAutoHeal("p1", "env-1");
		expect(fake.writes).toEqual([]);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("omits a null org id rather than writing it", async () => {
		fake.selects.push([env({ org_id: null })], [LAST_DEPLOY]);
		await maybeAutoHeal("p1", "env-1");
		const insert = fake.writes.find((w) => w.op === "insert");
		expect(insert?.payload).toMatchObject({ org_id: undefined });
	});
});
