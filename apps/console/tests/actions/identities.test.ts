// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
// 1.7 selectors take the LOCAL account.id, so the actions resolve it first. Mocked as a
// boundary like the auth api itself — the resolver has its own test.
vi.mock("@/lib/auth/accounts", () => ({ resolveAccountId: vi.fn() }));

import {
	deleteProviderToken,
	getLinkedProviders,
	getValidProviderToken,
} from "@/app/server/actions/identities";
import { auth } from "@/lib/auth";
import { currentActor } from "@/lib/authz/guard";
import { resolveAccountId } from "@/lib/auth/accounts";
import { markFailed, markHealthy } from "@/lib/connectors/health";
import { revalidatePath } from "next/cache";

const listUserAccounts = vi.mocked(auth.api.listUserAccounts);
const getAccessToken = vi.mocked(auth.api.getAccessToken);
const unlinkAccount = vi.mocked(auth.api.unlinkAccount);
const mockResolveAccountId = vi.mocked(resolveAccountId);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	// Default to "the provider IS linked" so each existing case keeps exercising the branch it
	// was written for; the no-link branch is asserted explicitly below.
	mockResolveAccountId.mockResolvedValue("acct-row-1");
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
			body: { accountId: "acct-row-1", userId: "user-1" },
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

// 1.7 removed `providerId` from the selector, so "this user has no link for this provider" is
// now a state the caller must detect BEFORE calling the api — it can no longer be inferred from
// an empty result. Assert the whole branch: no api call, a health failure recorded, null returned.
// Without this the regression is invisible — getAccessToken would throw ACCOUNT_NOT_FOUND and the
// existing catch would report it as "token refresh failed", which is a different, misleading cause.
describe("getValidProviderToken with no linked account", () => {
	it("skips the token call, records the real reason, and returns null", async () => {
		vi.mocked(currentActor).mockResolvedValue({
			userId: "user-1",
			orgId: "org-1",
		} as never);
		mockResolveAccountId.mockResolvedValue(null);

		const token = await getValidProviderToken("gitlab");

		expect(token).toBeNull();
		expect(getAccessToken).not.toHaveBeenCalled();
		expect(markFailed).toHaveBeenCalledWith(
			{ userId: "user-1", orgId: "org-1" },
			"git",
			"gitlab",
			"no linked account for this provider",
		);
		expect(markHealthy).not.toHaveBeenCalled();
	});
});

describe("deleteProviderToken", () => {
	it("unlinks the provider, revalidates the connectors page, and reports success", async () => {
		unlinkAccount.mockResolvedValue({} as never);

		const result = await deleteProviderToken("github");

		expect(unlinkAccount).toHaveBeenCalledWith({
			body: { accountId: "acct-row-1" },
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

	// Unlinking something already unlinked is the caller's intent, satisfied. Under 1.7 there is
	// no account row to name, so calling unlinkAccount at all would throw ACCOUNT_NOT_FOUND and
	// surface as a spurious error toast.
	it("is idempotent: no linked account reports success without calling unlinkAccount", async () => {
		mockResolveAccountId.mockResolvedValue(null);

		const result = await deleteProviderToken("bitbucket");

		expect(unlinkAccount).not.toHaveBeenCalled();
		expect(revalidatePath).toHaveBeenCalledWith("/dashboard/connectors");
		expect(result).toEqual({ success: true });
	});
});
