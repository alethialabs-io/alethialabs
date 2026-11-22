// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// providerTokenForUser answers a token or null — never an empty string, which is what Better Auth
// returns for a link whose stored token is absent or could not be decrypted.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getAccessToken: vi.fn<(args: { body: { accountId: string; userId: string } }) => Promise<{ accessToken?: string }>>(),
	resolveAccountId: vi.fn<(userId: string, provider: string) => Promise<string | null>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getAccessToken: h.getAccessToken } } }));
vi.mock("@/lib/auth/accounts", () => ({ resolveAccountId: h.resolveAccountId }));

import { providerTokenForUser } from "@/lib/auth/provider-token";

beforeEach(() => {
	h.getAccessToken.mockReset();
	h.resolveAccountId.mockReset();
	h.resolveAccountId.mockResolvedValue("acct-1");
});

describe("providerTokenForUser", () => {
	it("returns the token for the user's own linked account", async () => {
		h.getAccessToken.mockResolvedValue({ accessToken: "gho_token" });
		expect(await providerTokenForUser("user-1", "github")).toBe("gho_token");
		expect(h.getAccessToken).toHaveBeenCalledWith({ body: { accountId: "acct-1", userId: "user-1" } });
	});

	it("returns null for an empty token", async () => {
		h.getAccessToken.mockResolvedValue({ accessToken: "" });
		expect(await providerTokenForUser("user-1", "github")).toBeNull();
	});

	it("returns null when the user has no link", async () => {
		h.resolveAccountId.mockResolvedValue(null);
		expect(await providerTokenForUser("user-1", "gitlab")).toBeNull();
		expect(h.getAccessToken).not.toHaveBeenCalled();
	});

	it("returns null when the token cannot be fetched or refreshed", async () => {
		h.getAccessToken.mockRejectedValue(new Error("FAILED_TO_GET_ACCESS_TOKEN"));
		expect(await providerTokenForUser("user-1", "bitbucket")).toBeNull();
	});
});
