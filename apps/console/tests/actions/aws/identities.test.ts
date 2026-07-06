// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the AWS cloud-identity selection actions: stub currentActor
// and a thenable drizzle chain passed through withScope. drizzle's eq/and stay REAL but are
// wrapped so we can assert the provider="aws" + is_verified=true filter; the toOption mapper
// stays real, so we assert the displayId account_id/project_id/subscription_id fallback chain,
// the scope derivation (ownerId/orgId from the actor), and the empty-on-no-session branch.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ withScope: vi.fn() }));
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		eq: vi.fn((...a: unknown[]) => (actual.eq as (...x: unknown[]) => unknown)(...a)),
		and: vi.fn((...a: unknown[]) => (actual.and as (...x: unknown[]) => unknown)(...a)),
	};
});

import {
	getVerifiedCloudIdentities,
	getVerifiedCloudIdentitiesByProvider,
} from "@/app/server/actions/aws/identities";
import { currentActor } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Builds a thenable drizzle-ish tx whose builders return the chain and whose terminal
 * `.where()` resolves to `rows`; records the selected columns and the where predicate,
 * and wires the chain through `withScope` recording the scope it was invoked with.
 */
function mockTx(rows: unknown[]) {
	const selectSpy = vi.fn<(...a: unknown[]) => void>();
	const whereSpy = vi.fn<(...a: unknown[]) => void>();
	const tx: Record<string, unknown> = {};
	Object.assign(tx, {
		select: (...a: unknown[]) => {
			selectSpy(...a);
			return tx;
		},
		from: () => tx,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return tx;
		},
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	const scopeSpy = vi.fn<(...a: unknown[]) => void>();
	vi.mocked(withScope).mockImplementation(
		((scope: unknown, cb: (tx: unknown) => unknown) => {
			scopeSpy(scope);
			return cb(tx);
		}) as never,
	);
	return { tx, selectSpy, whereSpy, scopeSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
	} as never);
});

describe("getVerifiedCloudIdentities", () => {
	it("derives the scope from the actor and maps rows to options with account_id displayId", async () => {
		const { selectSpy, whereSpy, scopeSpy } = mockTx([
			{
				id: "ci-1",
				name: "prod-aws",
				provider: "aws",
				credentials: { account_id: "111122223333" },
			},
		]);

		const r = await getVerifiedCloudIdentities();

		expect(scopeSpy).toHaveBeenCalledWith({
			ownerId: "user-1",
			orgId: "org-1",
		});
		// selects exactly the four identity columns (real column refs)
		expect(selectSpy).toHaveBeenCalledWith({
			id: cloudIdentities.id,
			name: cloudIdentities.name,
			provider: cloudIdentities.provider,
			credentials: cloudIdentities.credentials,
		});
		// filters only on is_verified (no provider filter on the all-providers query)
		expect(whereSpy).toHaveBeenCalledTimes(1);
		expect(eq).toHaveBeenCalledWith(cloudIdentities.is_verified, true);
		expect(and).not.toHaveBeenCalled();
		expect(r).toEqual([
			{
				id: "ci-1",
				name: "prod-aws",
				displayId: "111122223333",
				provider: "aws",
			},
		]);
	});

	it("falls back across project_id then subscription_id then empty for displayId", async () => {
		mockTx([
			{
				id: "gcp-1",
				name: "g",
				provider: "gcp",
				credentials: { project_id: "my-proj" },
			},
			{
				id: "az-1",
				name: "a",
				provider: "azure",
				credentials: { subscription_id: "sub-xyz" },
			},
			{ id: "none-1", name: "n", provider: "aws", credentials: null },
		]);

		const r = await getVerifiedCloudIdentities();

		expect(r).toEqual([
			{ id: "gcp-1", name: "g", displayId: "my-proj", provider: "gcp" },
			{ id: "az-1", name: "a", displayId: "sub-xyz", provider: "azure" },
			{ id: "none-1", name: "n", displayId: "", provider: "aws" },
		]);
	});

	it("returns [] and never touches the db when there is no session", async () => {
		vi.mocked(currentActor).mockRejectedValueOnce(new Error("no session"));
		mockTx([{ id: "x", name: "x", provider: "aws", credentials: {} }]);

		const r = await getVerifiedCloudIdentities();

		expect(r).toEqual([]);
		expect(withScope).not.toHaveBeenCalled();
	});
});

describe("getVerifiedCloudIdentitiesByProvider", () => {
	it("applies an AND(provider='aws', is_verified=true) filter and maps the rows", async () => {
		const { whereSpy } = mockTx([
			{
				id: "ci-aws",
				name: "aws-acct",
				provider: "aws",
				credentials: { account_id: "999988887777" },
			},
		]);

		const r = await getVerifiedCloudIdentitiesByProvider("aws");

		expect(eq).toHaveBeenCalledWith(cloudIdentities.provider, "aws");
		expect(eq).toHaveBeenCalledWith(cloudIdentities.is_verified, true);
		expect(and).toHaveBeenCalledTimes(1);
		expect(whereSpy).toHaveBeenCalledTimes(1);
		expect(r).toEqual([
			{
				id: "ci-aws",
				name: "aws-acct",
				displayId: "999988887777",
				provider: "aws",
			},
		]);
	});

	it("passes the requested provider through to the eq predicate (gcp)", async () => {
		mockTx([]);
		const r = await getVerifiedCloudIdentitiesByProvider("gcp");
		expect(eq).toHaveBeenCalledWith(cloudIdentities.provider, "gcp");
		expect(r).toEqual([]);
	});

	it("returns [] without querying when there is no session", async () => {
		vi.mocked(currentActor).mockRejectedValueOnce(new Error("no session"));
		mockTx([]);
		const r = await getVerifiedCloudIdentitiesByProvider("aws");
		expect(r).toEqual([]);
		expect(withScope).not.toHaveBeenCalled();
	});
});
