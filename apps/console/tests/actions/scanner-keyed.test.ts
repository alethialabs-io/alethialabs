// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Queuing a repository scan (app/server/actions/scanner.ts, used by the console's import panel, the
// assistant and the MCP `scan_repo` tool): the caller must hold `create` on projects and the URL must
// pass the repository URL check, both before anything is read or queued. A repeat with the same key by
// the same person returns the first scan's job, queues nothing and books no usage, and the key is
// stored hashed with the organisation and the person. A scan with no key queues as before.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn(), currentActor: vi.fn() }));
vi.mock("@/lib/scanner/repo-url", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/scanner/repo-url")>();
	return { ...actual, assertScannableRepoUrl: vi.fn() };
});
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

import { scanRepo, startRepoScan } from "@/app/server/actions/scanner";
import { authorize } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { assertScannableRepoUrl, RepoUrlRefusedError } from "@/lib/scanner/repo-url";
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
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(assertScannableRepoUrl).mockImplementation(async (url: string) => url.trim());
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

describe("scan authorization and the repository URL", () => {
	it("asks for create on projects before anything else", async () => {
		txWith([]);
		await scanRepo("https://github.com/acme/api");
		expect(authorize).toHaveBeenCalledWith("create", { type: "project" });
	});

	it("queues nothing for a caller without the verb", async () => {
		const { tx } = txWith([]);
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("create", { type: "project" }));
		await expect(scanRepo("https://github.com/acme/api")).rejects.toBeInstanceOf(ForbiddenError);
		expect(assertScannableRepoUrl).not.toHaveBeenCalled();
		expect(tx.insert).not.toHaveBeenCalled();
		expect(assertAiAllowed).not.toHaveBeenCalled();
	});

	it("queues nothing for a URL the check refuses, and the panel shows the sentence under the field", async () => {
		const { tx } = txWith([]);
		vi.mocked(assertScannableRepoUrl).mockRejectedValue(new RepoUrlRefusedError("Only https:// repository URLs can be scanned."));
		await expect(scanRepo("ssh://git@github.com/acme/api.git")).rejects.toThrow("Only https://");
		expect(tx.insert).not.toHaveBeenCalled();
		expect(assertAiAllowed).not.toHaveBeenCalled();

		const result = await startRepoScan({ repoUrl: "ssh://git@github.com/acme/api.git" });
		expect(result).toMatchObject({ ok: false, error: { kind: "validation" } });
	});

	it("queues the URL the check returns", async () => {
		const { inserted } = txWith([]);
		vi.mocked(assertScannableRepoUrl).mockResolvedValue("https://github.com/acme/api");
		await scanRepo(" https://github.com/acme/api ");
		expect(inserted[0].config_snapshot).toEqual({ repo_url: "https://github.com/acme/api" });
	});
});
