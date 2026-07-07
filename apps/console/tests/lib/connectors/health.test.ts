// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for lib/connectors/health.ts. Stub getServiceDb (a thenable
// drizzle chain) + emitAlertEventSafe; keep drizzle helpers + schema real. Assert the
// upsert payload, the atomic alert claim (emit ONCE only when the conditional UPDATE
// returns a row), markHealthy's recovery write, and that both swallow errors.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));

import { markFailed, markHealthy } from "@/lib/connectors/health";
import { getServiceDb } from "@/lib/db";
import { emitAlertEventSafe } from "@/lib/alerts/emit";

/**
 * Builds a thenable drizzle-ish chain: every builder returns the chain, and awaiting
 * any terminal (`.onConflictDoUpdate` / `.returning` / `.where`) resolves to `rows`.
 * Records the `.values()` and `.set()` payloads for assertions.
 */
function makeDb(rows: unknown[] = []) {
	const calls = {
		values: [] as unknown[],
		set: [] as unknown[],
		onConflictDoUpdate: [] as unknown[],
	};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		insert: () => chain,
		values: (v: unknown) => {
			calls.values.push(v);
			return chain;
		},
		onConflictDoUpdate: (v: unknown) => {
			calls.onConflictDoUpdate.push(v);
			return chain;
		},
		update: () => chain,
		set: (v: unknown) => {
			calls.set.push(v);
			return chain;
		},
		where: () => chain,
		returning: () => chain,
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(chain as never);
	return { chain, calls };
}

const scope = { userId: "user-1", orgId: "org-1" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("markFailed", () => {
	it("upserts the failure row with the error and emits when the claim wins", async () => {
		// claim UPDATE returns a row → this caller owns the alert edge.
		const { calls } = makeDb([{ id: "h-1" }]);

		await markFailed(scope, "cloud_credential" as never, "aws", "token expired");

		// Upsert payload captured on .values()
		expect(calls.values[0]).toMatchObject({
			org_id: "org-1",
			user_id: "user-1",
			kind: "cloud_credential",
			provider: "aws",
			status: "failed",
			last_error: "token expired",
		});
		// onConflictDoUpdate set carries the failed status + error
		expect(
			(calls.onConflictDoUpdate[0] as { set: Record<string, unknown> }).set,
		).toMatchObject({
			status: "failed",
			last_error: "token expired",
			org_id: "org-1",
		});
		// the atomic claim writes alerted_at via .set()
		expect(calls.set[0]).toMatchObject({ alerted_at: expect.any(Date) });

		expect(emitAlertEventSafe).toHaveBeenCalledTimes(1);
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"system.connector.token_failed",
			{
				title: "Connector credential failed: aws",
				summary: "token expired",
				severity: "warning",
				actor_id: "user-1",
				connector_slug: "aws",
			},
		);
	});

	it("does NOT emit when the claim UPDATE returns no row (already alerted)", async () => {
		makeDb([]); // conditional UPDATE matched nothing

		await markFailed(scope, "cloud_credential" as never, "gcp", "bad creds");

		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("coalesces a missing error to null in the insert payload", async () => {
		const { calls } = makeDb([{ id: "h-2" }]);

		await markFailed(scope, "git_token" as never, "github");

		expect((calls.values[0] as Record<string, unknown>).last_error).toBeNull();
		// summary forwarded as the (undefined) error
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"system.connector.token_failed",
			expect.objectContaining({ summary: undefined, connector_slug: "github" }),
		);
	});

	it("swallows DB errors and never emits (best-effort)", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(getServiceDb).mockImplementation(() => {
			throw new Error("db down");
		});

		await expect(
			markFailed(scope, "cloud_credential" as never, "azure", "boom"),
		).resolves.toBeUndefined();

		expect(emitAlertEventSafe).not.toHaveBeenCalled();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe("markHealthy", () => {
	it("clears the failed row back to healthy and never emits", async () => {
		const { calls } = makeDb([]);

		await markHealthy(scope, "cloud_credential" as never, "aws");

		expect(calls.set[0]).toMatchObject({
			status: "healthy",
			last_error: null,
			alerted_at: null,
		});
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("swallows DB errors (best-effort)", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(getServiceDb).mockImplementation(() => {
			throw new Error("db down");
		});

		await expect(
			markHealthy(scope, "cloud_credential" as never, "aws"),
		).resolves.toBeUndefined();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
