// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/runners/deploy re-implements the enqueue that `deployRunner()` does — it does NOT
// call the server action — so the "we only hold runner templates for AWS" gate has to be proven
// here separately. Without it, `alethia runner deploy` on a GCP identity queues a job that dies in
// the runner with "no templates for provider gcp", long after the runner row exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/authz/runner-org", () => ({ assertRunnerInOrg: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { POST } from "@/app/api/cli/runners/deploy/route";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { notifyScaler } from "@/lib/scaler";

/**
 * A drizzle-ish chain whose builders return the chain and whose every `await` resolves to the
 * next seeded result-set (FIFO), so the route's sequential queries each get their own rows.
 */
function makeDb() {
	const queue: unknown[][] = [];
	const valuesSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		orderBy: () => db,
		limit: () => db,
		insert: () => db,
		values: (...a: unknown[]) => {
			valuesSpy(...a);
			return db;
		},
		returning: () => db,
		then: (resolve: (v: unknown) => void) =>
			resolve(queue.length ? queue.shift() : []),
	});
	return { db, queue, valuesSpy };
}

let mock: ReturnType<typeof makeDb>;

/** Builds the POST request the CLI sends for `alethia runner deploy`. */
function req(body: Record<string, unknown>): Request {
	return new Request("https://console.local/api/cli/runners/deploy", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const DEPLOY = { name: "Cloud", cloud_identity_id: "ci-1", region: "us-east-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mock = makeDb();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
	} as never);
	vi.mocked(getServiceDb).mockReturnValue(mock.db as never);
});

describe("POST /api/cli/runners/deploy", () => {
	it("queues the deploy for an AWS identity", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }], // identity lookup
			[{ version: "1.4.0" }], // latest release
			[{ id: "r-dep", name: "Cloud" }], // runner insert
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }], // job insert
		);
		const res = await POST(req(DEPLOY));
		expect(res.status).toBe(201);

		const jobValues = mock.valuesSpy.mock.calls[1][0];
		expect(jobValues.config_snapshot).toMatchObject({
			cloud_provider: "aws",
			region: "us-east-1",
		});
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("400s a cloud with no runner template, before inserting anything", async () => {
		mock.queue.push([{ id: "ci-1", provider: "gcp", org_id: "org-1" }]);
		const res = await POST(req({ ...DEPLOY, region: "europe-west1" }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/deployed runners are AWS only/i);
		// No orphan runners row, no job, no scaler wake.
		expect(mock.valuesSpy).not.toHaveBeenCalled();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("404s a missing identity rather than deploying to a default cloud", async () => {
		mock.queue.push([]);
		const res = await POST(req(DEPLOY));
		expect(res.status).toBe(404);
		expect(mock.valuesSpy).not.toHaveBeenCalled();
	});
});
