// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A keyed repository scan (app/server/actions/scanner.ts, used by the MCP `scan_repo` tool): a repeat
// with the same key by the same person returns the first scan's job, queues nothing and books no
// usage, and the key is stored hashed with the organisation and the person. A scan with no key queues
// exactly as before.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));
vi.mock("@/lib/billing/ai-guard", () => ({
	assertAiAllowed: vi.fn(),
	AiBudgetError: class AiBudgetError extends Error {},
}));
vi.mock("@/lib/billing/ai-quota", () => ({ recordAiUsage: vi.fn(), meteringFailed: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/scanner/infer", () => ({ inferStack: vi.fn() }));
vi.mock("@/app/server/actions/aws/identities", () => ({ getVerifiedCloudIdentities: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: (values: unknown) => values }));

import { scanRepo } from "@/app/server/actions/scanner";
import { currentActor } from "@/lib/authz/guard";
import { assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { withActorScope } from "@/lib/db";

/** A transaction whose selects answer `existing` in order and whose insert records its values. */
function txWith(existing: unknown[][]) {
	const inserted: Record<string, unknown>[] = [];
	const queue = [...existing];
	const chain = (rows: unknown[]) => {
		const c = {
			from: () => c,
			where: () => c,
			limit: () => Promise.resolve(rows),
		};
		return c;
	};
	const tx = {
		select: vi.fn(() => chain(queue.shift() ?? [])),
		execute: vi.fn(async () => []),
		insert: vi.fn(() => ({
			values: (v: Record<string, unknown>) => {
				inserted.push(v);
				return { returning: async () => [{ id: "job-new" }] };
			},
		})),
	};
	vi.mocked(withActorScope).mockImplementation(((_actor: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never);
	return { tx, inserted };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(assertAiAllowed).mockResolvedValue({ settle: false, credits: 1, source: "included" } as never);
});

describe("scanRepo with an idempotency key", () => {
	it("queues once, storing the key hashed with the organisation and the person", async () => {
		const { tx, inserted } = txWith([[], []]);
		expect(await scanRepo("https://github.com/acme/api", { idempotencyKey: "mcp:key-1" })).toEqual({ jobId: "job-new" });
		expect(tx.execute).toHaveBeenCalledTimes(1);
		expect(inserted[0].idempotency_key).toMatch(/^[0-9a-f]{64}$/);
		expect(inserted[0].idempotency_key).not.toContain("key-1");
		expect(recordAiUsage).toHaveBeenCalledTimes(1);
	});

	it("returns the first scan for a repeated key before any budget check, queuing and booking nothing", async () => {
		const { tx } = txWith([[{ id: "job-first" }]]);
		expect(await scanRepo("https://github.com/acme/api", { idempotencyKey: "mcp:key-1" })).toEqual({ jobId: "job-first" });
		expect(assertAiAllowed).not.toHaveBeenCalled();
		expect(tx.insert).not.toHaveBeenCalled();
		expect(recordAiUsage).not.toHaveBeenCalled();
	});

	it("returns the scan a concurrent call queued while this one waited on the key's lock", async () => {
		const { tx } = txWith([[], [{ id: "job-raced" }]]);
		expect(await scanRepo("https://github.com/acme/api", { idempotencyKey: "mcp:key-1" })).toEqual({ jobId: "job-raced" });
		expect(tx.insert).not.toHaveBeenCalled();
		expect(recordAiUsage).not.toHaveBeenCalled();
	});

	it("queues a scan with no key exactly as before: no lookup, no lock, no stored key", async () => {
		const { tx, inserted } = txWith([]);
		expect(await scanRepo("https://github.com/acme/api")).toEqual({ jobId: "job-new" });
		expect(tx.select).not.toHaveBeenCalled();
		expect(tx.execute).not.toHaveBeenCalled();
		expect(inserted[0].idempotency_key).toBeNull();
	});
});
