// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// Linked accounts' OAuth tokens are encrypted at rest (lib/auth/oauth-token-crypto.ts).
//
// The flow tests run the REAL Better Auth (the installed version) against an in-memory adapter wrapped
// exactly as lib/auth/index.ts wraps the drizzle one, and drive `auth.api.getAccessToken` — the call
// every console caller makes (lib/auth/provider-token.ts). A mocked Better Auth could not show that its
// refresh path receives the real refresh token, or that a row written before this change still reads.
// Only the provider's token endpoint is stubbed (`refreshAccessToken`).

import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
	isSealedOAuthToken,
	openOAuthToken,
	resealOAuthToken,
	sealOAuthToken,
	SEALED_TOKEN_PREFIX,
	withEncryptedOAuthTokens,
} from "@/lib/auth/oauth-token-crypto";
import { resetKeyringCache } from "@/lib/crypto/secrets";
import { log } from "@/lib/observability/log";
import { planRow } from "@/scripts/encrypt-oauth-tokens";

const ENV_KEYS = ["ALETHIA_CRED_ENCRYPTION_KEY", "ALETHIA_CRED_ENCRYPTION_KID", "ALETHIA_CRED_ENCRYPTION_KEY_1"];
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

/** Installs a fresh active key (and optionally a kid), clearing any retired key. */
function useKey(key: string, kid?: string): void {
	process.env.ALETHIA_CRED_ENCRYPTION_KEY = key;
	if (kid === undefined) delete process.env.ALETHIA_CRED_ENCRYPTION_KID;
	else process.env.ALETHIA_CRED_ENCRYPTION_KID = kid;
	delete process.env.ALETHIA_CRED_ENCRYPTION_KEY_1;
	resetKeyringCache();
}

const newKey = (): string => randomBytes(32).toString("base64");

beforeEach(() => {
	useKey(newKey());
});

afterAll(() => {
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetKeyringCache();
});

// A GitLab-style token: 64 hex characters. A shape heuristic would mistake this for ciphertext.
const HEX_ACCESS = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
const HEX_REFRESH = "b".repeat(32) + "fedcba9876543210fedcba9876543210";
const HOUR = 3_600_000;

/** In-memory tables plus a Better Auth instance over them, wrapped as production wraps drizzle. */
function harness() {
	const db: Record<string, Record<string, unknown>[]> = {
		user: [],
		session: [],
		account: [],
		verification: [],
	};
	const refresh = vi.fn(async (_refreshToken: string) => ({
		accessToken: "gho_refreshed",
		refreshToken: "ghr_refreshed",
		accessTokenExpiresAt: new Date(Date.now() + HOUR),
	}));
	const auth = betterAuth({
		secret: "test-secret-test-secret-test-secret-0123",
		baseURL: "https://app.test",
		database: withEncryptedOAuthTokens(memoryAdapter(db)),
		socialProviders: {
			github: { clientId: "id", clientSecret: "secret", refreshAccessToken: refresh },
		},
	});
	return { db, auth, refresh };
}

/** Creates a user with one GitHub link through Better Auth's own adapter path. */
async function linkedUser(h: ReturnType<typeof harness>, tokens: { access: string; refresh: string }) {
	const ctx = await h.auth.$context;
	const user = await ctx.internalAdapter.createUser(
		{ email: "dev@example.com", name: "Dev", emailVerified: true },
		{ method: "email-otp" },
	);
	const acct = await ctx.internalAdapter.createAccount({
		userId: user.id,
		providerId: "github",
		accountId: "gh-1",
		accessToken: tokens.access,
		refreshToken: tokens.refresh,
		accessTokenExpiresAt: new Date(Date.now() + HOUR),
	});
	return { ctx, user, acct };
}

/** The stored row with the given id, read straight from the in-memory table. */
function storedRow(h: ReturnType<typeof harness>, id: string): Record<string, unknown> {
	const row = h.db.account.find((r) => r.id === id);
	if (!row) throw new Error(`no stored account ${id}`);
	return row;
}

/** A stored token field as a string (fails the test when it is not one). */
function storedString(row: Record<string, unknown>, field: string): string {
	const value = row[field];
	if (typeof value !== "string") throw new Error(`${field} is not a stored string`);
	return value;
}

describe("sealed token values", () => {
	it("round-trips a token, and the sealed value is not the token", () => {
		const sealed = sealOAuthToken("gho_secret_value");
		expect(sealed.startsWith(SEALED_TOKEN_PREFIX)).toBe(true);
		expect(sealed).not.toContain("gho_secret_value");
		expect(openOAuthToken(sealed)).toBe("gho_secret_value");
	});

	it("reads a value without the prefix as a plaintext row, including a hex token", () => {
		expect(isSealedOAuthToken(HEX_ACCESS)).toBe(false);
		expect(openOAuthToken(HEX_ACCESS)).toBe(HEX_ACCESS);
	});

	it("refuses a sealed value under a different key rather than returning ciphertext", () => {
		const sealed = sealOAuthToken("gho_secret_value");
		useKey(newKey());
		expect(() => openOAuthToken(sealed)).toThrow();
	});

	it("refuses a tampered sealed value", () => {
		const sealed = sealOAuthToken("gho_secret_value");
		expect(() => openOAuthToken(`${sealed.slice(0, -4)}AAAA`)).toThrow();
	});
});

describe("Better Auth over the encrypting adapter", () => {
	it("stores a new link's tokens sealed and hands getAccessToken the plaintext", async () => {
		const h = harness();
		const { user, acct } = await linkedUser(h, { access: "gho_live", refresh: "ghr_live" });

		const row = storedRow(h, acct.id);
		for (const field of ["accessToken", "refreshToken"]) {
			const value = storedString(row, field);
			expect(isSealedOAuthToken(value)).toBe(true);
			expect(value).not.toContain("_live");
		}
		// What Better Auth itself returned from the create is the plaintext, as before.
		expect(acct.accessToken).toBe("gho_live");

		const res = await h.auth.api.getAccessToken({ body: { accountId: acct.id, userId: user.id } });
		expect(res.accessToken).toBe("gho_live");
		expect(h.refresh).not.toHaveBeenCalled();
		// Opening a row for a reader never writes the plaintext back into storage.
		expect(isSealedOAuthToken(storedString(storedRow(h, acct.id), "accessToken"))).toBe(true);
	});

	it("refreshes an expired token with the real refresh token and stores the new pair sealed", async () => {
		const h = harness();
		const { ctx, user, acct } = await linkedUser(h, { access: "gho_old", refresh: "ghr_old" });
		await ctx.internalAdapter.updateAccount(acct.id, { accessTokenExpiresAt: new Date(Date.now() - HOUR) });

		const res = await h.auth.api.getAccessToken({ body: { accountId: acct.id, userId: user.id } });

		expect(h.refresh).toHaveBeenCalledTimes(1);
		expect(h.refresh.mock.calls[0]?.[0]).toBe("ghr_old");
		expect(res.accessToken).toBe("gho_refreshed");
		const row = storedRow(h, acct.id);
		expect(openOAuthToken(storedString(row, "accessToken"))).toBe("gho_refreshed");
		expect(openOAuthToken(storedString(row, "refreshToken"))).toBe("ghr_refreshed");
		expect(isSealedOAuthToken(storedString(row, "accessToken"))).toBe(true);
		expect(isSealedOAuthToken(storedString(row, "refreshToken"))).toBe(true);
	});

	it("keeps a link stored before encryption working, including its refresh", async () => {
		const h = harness();
		const { ctx, user } = await linkedUser(h, { access: "gho_x", refresh: "ghr_x" });
		// A row written by the previous release: plaintext hex tokens, straight into the table.
		h.db.account.push({
			id: "legacy-account",
			userId: user.id,
			providerId: "github",
			accountId: "gh-legacy",
			accessToken: HEX_ACCESS,
			refreshToken: HEX_REFRESH,
			accessTokenExpiresAt: new Date(Date.now() + HOUR),
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const fresh = await h.auth.api.getAccessToken({
			body: { accountId: "legacy-account", userId: user.id },
		});
		expect(fresh.accessToken).toBe(HEX_ACCESS);

		await ctx.internalAdapter.updateAccount("legacy-account", {
			accessTokenExpiresAt: new Date(Date.now() - HOUR),
		});
		const refreshed = await h.auth.api.getAccessToken({
			body: { accountId: "legacy-account", userId: user.id },
		});
		expect(h.refresh.mock.calls[0]?.[0]).toBe(HEX_REFRESH);
		expect(refreshed.accessToken).toBe("gho_refreshed");
		// The refresh rewrote the row, so it is sealed from here on.
		expect(isSealedOAuthToken(storedString(storedRow(h, "legacy-account"), "refreshToken"))).toBe(true);
	});

	it("opens the accounts a user lookup joins", async () => {
		const h = harness();
		const { ctx } = await linkedUser(h, { access: "gho_join", refresh: "ghr_join" });
		const found = await ctx.internalAdapter.findUserByEmail("dev@example.com", { includeAccounts: true });
		expect(found?.accounts.map((a) => a.accessToken)).toEqual(["gho_join"]);
	});

	it("opens rows read inside a transaction", async () => {
		const h = harness();
		const { ctx, user } = await linkedUser(h, { access: "gho_trx", refresh: "ghr_trx" });
		const tokens = await ctx.adapter.transaction(async (trx) => {
			const rows = await trx.findMany<{ accessToken: string | null }>({
				model: "account",
				where: [{ field: "userId", value: user.id }],
			});
			return rows.map((r) => r.accessToken);
		});
		expect(tokens).toEqual(["gho_trx"]);
	});

	it("reads an undecryptable token as absent and never logs its value", async () => {
		const h = harness();
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		const { ctx, user, acct } = await linkedUser(h, { access: "gho_lost", refresh: "ghr_lost" });
		const sealedBefore = storedString(storedRow(h, acct.id), "accessToken");
		useKey(newKey()); // the key that sealed the row is gone

		const accounts = await ctx.internalAdapter.findAccounts(user.id);
		expect(accounts.map((a) => [a.accessToken, a.refreshToken])).toEqual([[null, null]]);
		const logged = JSON.stringify(warn.mock.calls);
		const leaks = ["gho_lost", "ghr_lost", sealedBefore].filter((s) => logged.includes(s));
		expect(leaks).toEqual([]);
		warn.mockRestore();
	});
});

describe("the encryption step (scripts/encrypt-oauth-tokens.ts)", () => {
	const plainRow = {
		id: "11111111-1111-1111-1111-111111111111",
		access_token: HEX_ACCESS,
		refresh_token: HEX_REFRESH,
		id_token: null,
	};

	it("seals a plaintext row, and a second pass changes nothing", () => {
		const first = planRow(plainRow);
		if (first === null) throw new Error("a plaintext row must be planned");
		expect(first.access_token === null ? false : isSealedOAuthToken(first.access_token)).toBe(true);
		expect(first.refresh_token === null ? "" : openOAuthToken(first.refresh_token)).toBe(HEX_REFRESH);
		expect(first.id_token).toBeNull();
		expect(planRow(first)).toBeNull();
	});

	it("re-seals a row under a retired key to the active key, then settles", () => {
		const oldKey = newKey();
		useKey(oldKey, "1");
		const underOld = planRow(plainRow);
		if (underOld === null) throw new Error("a plaintext row must be planned");

		useKey(newKey(), "2");
		process.env.ALETHIA_CRED_ENCRYPTION_KEY_1 = oldKey;
		resetKeyringCache();

		const underNew = planRow(underOld);
		if (underNew === null) throw new Error("a row under a retired key must be re-sealed");
		expect(underNew.access_token === null ? "" : openOAuthToken(underNew.access_token)).toBe(HEX_ACCESS);
		expect(planRow(underNew)).toBeNull();
	});

	it("leaves an undecryptable row to the caller instead of overwriting it", () => {
		useKey(newKey(), "1");
		const row = { ...plainRow, access_token: sealOAuthToken("gho_x") };
		// The key for kid "1" is gone from the ring, so the row cannot be moved to kid "2".
		useKey(newKey(), "2");
		expect(() => planRow(row)).toThrow();
	});

	it("passes empty and null values through untouched", () => {
		expect(resealOAuthToken(null)).toEqual({ value: null, changed: false });
		expect(resealOAuthToken("")).toEqual({ value: "", changed: false });
	});
});
