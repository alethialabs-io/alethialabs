// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the identities actions. We drive the REAL actions and mock only the
// auth boundary (Better Auth api), the PDP actor guard, connector-health emitters, next/cache and
// next/headers. Asserts: dedup/fail-closed for getLinkedProviders; token success→markHealthy,
// empty-token→markFailed, throw→markFailed for getValidProviderToken (and the actor-fail null
// branch with no token call); and the unlink success/revalidate vs error branches.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
	auth: {
		api: {
			listUserAccounts: vi.fn(),
			getAccessToken: vi.fn(),
			unlinkAccount: vi.fn(),
		},
	},
}));
vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/connectors/health", () => ({ markHealthy: vi.fn(), markFailed: vi.fn() }));

import {
	deleteProviderToken,
	getLinkedProviders,
	getValidProviderToken,
} from "@/app/server/actions/identities";
import { auth } from "@/lib/auth";
import { currentActor } from "@/lib/authz/guard";
import { markFailed, markHealthy } from "@/lib/connectors/health";
import { revalidatePath } from "next/cache";

const listUserAccounts = vi.mocked(auth.api.listUserAccounts);
const getAccessToken = vi.mocked(auth.api.getAccessToken);
const unlinkAccount = vi.mocked(auth.api.unlinkAccount);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getLinkedProviders", () => {
	it("returns only git providers, deduplicated", async () => {
		listUserAccounts.mockResolvedValue([
			{ providerId: "github" },
			{ providerId: "github" }, // dup
			{ providerId: "gitlab" },
			{ providerId: "google" }, // not a git provider → excluded
			{ providerId: "credential" },
		] as never);
		const result = await getLinkedProviders();
		expect([...result].sort()).toEqual(["github", "gitlab"]);
	});

	it("returns an empty list when nothing is linked", async () => {
		listUserAccounts.mockResolvedValue([] as never);
		expect(await getLinkedProviders()).toEqual([]);
	});

	it("fails closed (empty) when the auth API throws", async () => {
		listUserAccounts.mockRejectedValue(new Error("auth down"));
		expect(await getLinkedProviders()).toEqual([]);
	});
});

describe("getValidProviderToken", () => {
	const scope = { userId: "user-1", orgId: "org-1" };

	beforeEach(() => {
		vi.mocked(currentActor).mockResolvedValue(scope as never);
	});

	it("returns the access token and emits health-OK on success", async () => {
		getAccessToken.mockResolvedValue({ accessToken: "ghp_abc" } as never);

		const token = await getValidProviderToken("github");

		// Token is requested for the scoped user, scoped to the linked provider.
		expect(getAccessToken).toHaveBeenCalledWith({
			body: { providerId: "github", userId: "user-1" },
			headers: expect.any(Headers),
		});
		expect(token).toBe("ghp_abc");
		expect(markHealthy).toHaveBeenCalledWith(scope, "git", "github");
		expect(markFailed).not.toHaveBeenCalled();
	});

	it("returns null and emits health-FAIL when no token is returned", async () => {
		getAccessToken.mockResolvedValue({ accessToken: undefined } as never);

		const token = await getValidProviderToken("gitlab");

		expect(token).toBeNull();
		expect(markFailed).toHaveBeenCalledWith(
			scope,
			"git",
			"gitlab",
			"no access token returned",
		);
		expect(markHealthy).not.toHaveBeenCalled();
	});

	it("returns null and emits health-FAIL with the error message when refresh throws", async () => {
		getAccessToken.mockRejectedValue(new Error("token refresh exploded"));

		const token = await getValidProviderToken("bitbucket");

		expect(token).toBeNull();
		expect(markFailed).toHaveBeenCalledWith(
			scope,
			"git",
			"bitbucket",
			"token refresh exploded",
		);
		expect(markHealthy).not.toHaveBeenCalled();
	});

	it("falls back to a generic message when the thrown value is not an Error", async () => {
		getAccessToken.mockRejectedValue("string failure");

		const token = await getValidProviderToken("github");

		expect(token).toBeNull();
		expect(markFailed).toHaveBeenCalledWith(
			scope,
			"git",
			"github",
			"token refresh failed",
		);
	});

	it("returns null without contacting the auth API when the actor guard rejects", async () => {
		vi.mocked(currentActor).mockRejectedValueOnce(new Error("unauthenticated"));

		const token = await getValidProviderToken("github");

		expect(token).toBeNull();
		expect(getAccessToken).not.toHaveBeenCalled();
		expect(markHealthy).not.toHaveBeenCalled();
		expect(markFailed).not.toHaveBeenCalled();
	});
});

describe("deleteProviderToken", () => {
	it("unlinks the provider, revalidates the connectors page, and reports success", async () => {
		unlinkAccount.mockResolvedValue({} as never);

		const result = await deleteProviderToken("github");

		expect(unlinkAccount).toHaveBeenCalledWith({
			body: { providerId: "github" },
			headers: expect.any(Headers),
		});
		expect(revalidatePath).toHaveBeenCalledWith("/dashboard/connectors");
		expect(result).toEqual({ success: true });
	});

	it("returns an error shape and skips revalidation when unlink throws", async () => {
		unlinkAccount.mockRejectedValue(new Error("unlink failed"));

		const result = await deleteProviderToken("gitlab");

		expect(result).toEqual({ error: "Unexpected error occurred" });
		expect(revalidatePath).not.toHaveBeenCalled();
	});
});
