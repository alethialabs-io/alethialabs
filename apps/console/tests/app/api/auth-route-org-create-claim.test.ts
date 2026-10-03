// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The auth route's `/organization/create` (#5445): a create that FAILS gives back the paid-setup claim
// its before-hook took. Before this, a create whose org insert failed after the hook (the slug taken
// between better-auth's check and its insert, a database error) left `creating_at` set, and every
// retry for the next minute was refused with "already being set up" by a request no longer running.
//
// better-auth is replaced by a handler that does what its create does with the hook — run
// `stampNewOrgMetadata` (the real one, over a queued database) — and then answers as the case needs.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks: { status: number; post: ReturnType<typeof vi.fn>; db: unknown } = vi.hoisted(() => ({
	status: 500,
	post: vi.fn(),
	db: null,
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedIpFailure: vi.fn(() => null) }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: vi.fn(() => ({ organizations: true })) }));
vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn(async () => ({ orgId: "org-1" })) }));
vi.mock("@/lib/authz/grants", () => ({ ensureMemberGrant: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: () => mocks.db }));
vi.mock("better-auth/next-js", () => ({
	toNextJsHandler: vi.fn(() => ({ GET: vi.fn(), POST: mocks.post })),
}));

import { POST } from "@/app/api/auth/[...all]/route";
import { stampNewOrgMetadata } from "@/lib/billing/pending-org-setup";

/** A thenable drizzle-ish chain whose terminal `await` pops the next queued result; `set` is recorded. */
function makeDb() {
	const queue: unknown[][] = [];
	const chain: Record<string, unknown> = {};
	const set = vi.fn((_values: unknown) => chain);
	for (const m of ["from", "where", "limit", "orderBy", "values", "returning"]) {
		chain[m] = () => chain;
	}
	chain.set = set;
	chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
		Promise.resolve(queue.shift() ?? []).then(resolve, reject);
	const db = { select: vi.fn(() => chain), update: vi.fn(() => chain) };
	return { db, queue, set };
}

let db: ReturnType<typeof makeDb>;

/** The caller's setup record for sub_1, nothing created for it yet. */
const record = {
	id: "row-1",
	user_id: "user-1",
	subscription_id: "sub_1",
	customer_id: "cus_1",
	intended_name: "Acme Cloud",
	intended_slug: "acme",
	billing: null,
	created_org_id: null,
	creating_at: null,
	linked_at: null,
	declared_at: null,
	created_at: new Date("2026-10-03T12:00:00Z"),
	updated_at: new Date("2026-10-03T12:00:00Z"),
};

/** A browser's `/organization/create` for the paid setup of sub_1. */
function createRequest(): Request {
	return new Request("https://app.test/api/auth/organization/create", {
		method: "POST",
		body: JSON.stringify({ name: "Acme Cloud", slug: "acme", metadata: { newOrgSubscriptionId: "sub_1" } }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	db = makeDb();
	mocks.db = db.db;
	mocks.post.mockImplementation(async () => {
		await stampNewOrgMetadata({ newOrgSubscriptionId: "sub_1" }, "user-1");
		return new Response(null, { status: mocks.status });
	});
});

describe("/organization/create — the paid-setup claim", () => {
	it("a create that fails after its hook took the claim gives the claim back", async () => {
		mocks.status = 500;
		db.queue.push([record]); // the caller's record
		db.queue.push([{ id: "row-1" }]); // the claim: taken
		db.queue.push([]); // no org marked for sub_1

		const response = await POST(createRequest());

		expect(response.status).toBe(500);
		expect(db.db.update).toHaveBeenCalledTimes(2);
		const [claim] = db.set.mock.calls[0] ?? [];
		const [release] = db.set.mock.calls[1] ?? [];
		expect(claim).toMatchObject({ creating_at: expect.any(Date) });
		expect(release).toMatchObject({ creating_at: null });
	});

	it("a create that succeeds keeps its claim — the organization it made is recorded by the after-hook", async () => {
		mocks.status = 200;
		db.queue.push([record]);
		db.queue.push([{ id: "row-1" }]);
		db.queue.push([]);

		await POST(createRequest());

		expect(db.db.update).toHaveBeenCalledTimes(1);
	});

	it("a create refused because ANOTHER create holds the claim releases nothing — the claim is not its own", async () => {
		mocks.status = 400;
		db.queue.push([record]);
		db.queue.push([]); // the claim: not taken
		db.queue.push([record]); // re-read: still no org

		await POST(createRequest());

		expect(db.db.update).toHaveBeenCalledTimes(1);
	});
});
