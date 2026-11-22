// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// `db:reencrypt` (scripts/reencrypt-secrets.ts) walks the Better Auth `account` table's OAuth token
// columns as well as every other credential ciphertext (#7277), so a key rotation re-seals linked
// accounts' tokens instead of stranding them under a retired key. The database is an in-memory stand-in
// for `postgres` that answers the script's keyset-paginated selects and compare-and-set updates; the
// script itself runs for real, to its process.exit.

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSealedOAuthToken, openOAuthToken, sealOAuthToken } from "@/lib/auth/oauth-token-crypto";
import { resetKeyringCache } from "@/lib/crypto/secrets";
import { accountCountsAsReencrypt } from "@/scripts/reencrypt-secrets";

/** One stored `account` row, as the stand-in database holds it. */
interface AccountRow {
	id: string;
	access_token: string | null;
	refresh_token: string | null;
	id_token: string | null;
}

/** The stand-in `account` table, keyed by id. */
const accounts = new Map<string, AccountRow>();
/** Ids whose next update loses the compare-and-set, as if the app wrote the row first. */
const racing = new Set<string>();
/** Every account update the script issued, by row id. */
const accountUpdates: string[] = [];

/** Whether a query parameter is a string (keyset cursor or token value). */
function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

vi.mock("postgres", () => {
	/**
	 * A stand-in for the postgres tag. `sql(identifier)` returns the identifier; account selects page by
	 * id; account updates apply the compare-and-set; every other table is empty.
	 */
	function fakeSql(strings: TemplateStringsArray | string, ...values: unknown[]): unknown {
		if (typeof strings === "string") return strings;
		const text = strings.join("?");
		if (/from account\b/.test(text)) {
			const cursor = str(values[0]) ?? "";
			const limit = typeof values[1] === "number" ? values[1] : 500;
			const page = [...accounts.values()]
				.filter((r) => r.id > cursor && (r.access_token ?? r.refresh_token ?? r.id_token) !== null)
				.sort((a, b) => (a.id < b.id ? -1 : 1))
				.slice(0, limit)
				.map((r) => ({ ...r }));
			return Promise.resolve(page);
		}
		if (/update account\b/.test(text)) {
			const [access, refresh, idToken, id] = values;
			const rowId = str(id) ?? "";
			accountUpdates.push(rowId);
			const row = accounts.get(rowId);
			if (!row || racing.has(rowId)) return Promise.resolve(Object.assign([], { count: 0 }));
			accounts.set(rowId, {
				id: rowId,
				access_token: str(access),
				refresh_token: str(refresh),
				id_token: str(idToken),
			});
			return Promise.resolve(Object.assign([], { count: 1 }));
		}
		return Promise.resolve([]);
	}
	fakeSql.json = (value: unknown) => value;
	fakeSql.end = () => Promise.resolve();
	return { default: () => fakeSql };
});

const ENV_KEYS = [
	"ALETHIA_DATABASE_URL",
	"ALETHIA_CRED_ENCRYPTION_KEY",
	"ALETHIA_CRED_ENCRYPTION_KID",
	"ALETHIA_CRED_ENCRYPTION_KEY_1",
	"REENCRYPT_BATCH",
];
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const savedArgv = process.argv;

/** A fresh random 32-byte key, base64. */
const newKey = (): string => randomBytes(32).toString("base64");

/** Installs `key` as the active key under `kid`, with an optional retired key for kid "1". */
function useKey(key: string, kid: string, retiredKid1?: string): void {
	process.env.ALETHIA_CRED_ENCRYPTION_KEY = key;
	process.env.ALETHIA_CRED_ENCRYPTION_KID = kid;
	if (retiredKid1 === undefined) delete process.env.ALETHIA_CRED_ENCRYPTION_KEY_1;
	else process.env.ALETHIA_CRED_ENCRYPTION_KEY_1 = retiredKid1;
	resetKeyringCache();
}

/** Everything the script printed, joined, so a test can assert no token reached the output. */
let printed = "";

/** Runs `db:reencrypt` once against the stand-in database, returning the first exit code it asked for. */
async function runReencrypt(): Promise<number | undefined> {
	vi.resetModules();
	accountUpdates.length = 0;
	process.argv = ["node", ""];
	let code: number | undefined;
	// Records the FIRST exit code and returns, so the script's own try/catch never sees a throw.
	vi.spyOn(process, "exit").mockImplementation((c) => {
		code ??= typeof c === "number" ? c : 0;
		return undefined as never;
	});
	// The script runs its DB pass only when it is the entry point, so make it the entry point.
	process.argv[1] = fileURLToPath(new URL("../../scripts/reencrypt-secrets.ts", import.meta.url));
	await import("@/scripts/reencrypt-secrets");
	await vi.waitFor(() => expect(code).toBeDefined());
	return code;
}

beforeEach(() => {
	accounts.clear();
	racing.clear();
	printed = "";
	process.env.ALETHIA_DATABASE_URL = "postgres://stand-in/db";
	delete process.env.REENCRYPT_BATCH;
	useKey(newKey(), "1");
	const record = (...args: unknown[]) => {
		printed += `${args.map(String).join(" ")}\n`;
	};
	vi.spyOn(console, "log").mockImplementation(record);
	vi.spyOn(console, "warn").mockImplementation(record);
	vi.spyOn(console, "error").mockImplementation(record);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	process.argv = savedArgv;
	for (const [k, v] of savedEnv) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetKeyringCache();
});

const ID_A = "11111111-1111-1111-1111-111111111111";
const ID_B = "22222222-2222-2222-2222-222222222222";
const ID_C = "33333333-3333-3333-3333-333333333333";

/** The token a stored value holds, or null. */
function tokenOf(stored: string | null): string | null {
	return stored === null ? null : openOAuthToken(stored);
}

describe("db:reencrypt over the account table's OAuth tokens", () => {
	it("re-seals tokens under a retired key to the active key, and a second run changes nothing", async () => {
		const oldKey = newKey();
		useKey(oldKey, "1");
		accounts.set(ID_A, {
			id: ID_A,
			access_token: sealOAuthToken("gho_access_a"),
			refresh_token: sealOAuthToken("ghr_refresh_a"),
			id_token: null,
		});
		// Rotate: kid "1" moves to the retired slot, kid "2" is active.
		useKey(newKey(), "2", oldKey);
		accounts.set(ID_B, { id: ID_B, access_token: sealOAuthToken("gho_access_b"), refresh_token: null, id_token: null });

		expect(await runReencrypt()).toBe(0);
		expect(accountUpdates).toEqual([ID_A]);
		const a = accounts.get(ID_A);
		expect([tokenOf(a?.access_token ?? null), tokenOf(a?.refresh_token ?? null), a?.id_token]).toEqual([
			"gho_access_a",
			"ghr_refresh_a",
			null,
		]);

		// With the retired key dropped from the ring, every row still opens: nothing was left behind.
		useKey(process.env.ALETHIA_CRED_ENCRYPTION_KEY ?? "", "2");
		expect(tokenOf(accounts.get(ID_A)?.access_token ?? null)).toBe("gho_access_a");
		expect(tokenOf(accounts.get(ID_B)?.access_token ?? null)).toBe("gho_access_b");

		expect(await runReencrypt()).toBe(0);
		expect(accountUpdates).toEqual([]);
	});

	it("seals a value still in the plaintext form, walking every page of a small batch", async () => {
		process.env.REENCRYPT_BATCH = "1";
		accounts.set(ID_A, { id: ID_A, access_token: "gho_plain_a", refresh_token: null, id_token: null });
		accounts.set(ID_B, { id: ID_B, access_token: null, refresh_token: null, id_token: "eyJ.plain.b" });
		accounts.set(ID_C, { id: ID_C, access_token: null, refresh_token: null, id_token: null });

		expect(await runReencrypt()).toBe(0);
		expect(accountUpdates).toEqual([ID_A, ID_B]);
		const stored = [accounts.get(ID_A)?.access_token ?? "", accounts.get(ID_B)?.id_token ?? ""];
		expect(stored.map(isSealedOAuthToken)).toEqual([true, true]);
		expect(stored.map(openOAuthToken)).toEqual(["gho_plain_a", "eyJ.plain.b"]);
		expect(printed).not.toContain("gho_plain_a");
		expect(printed).not.toContain("eyJ.plain.b");
	});

	it("leaves a row whose key is gone from the ring untouched and exits non-zero", async () => {
		useKey(newKey(), "1");
		const lost = sealOAuthToken("gho_lost");
		accounts.set(ID_A, { id: ID_A, access_token: lost, refresh_token: null, id_token: null });
		useKey(newKey(), "2");

		expect(await runReencrypt()).toBe(1);
		expect(accountUpdates).toEqual([]);
		expect(accounts.get(ID_A)?.access_token).toBe(lost);
		expect(printed).toContain(ID_A);
		expect(printed).not.toContain("gho_lost");
		expect(printed).not.toContain(lost);
	});

	it("does not overwrite a row the app rewrote mid-pass, and still exits zero", async () => {
		accounts.set(ID_A, { id: ID_A, access_token: "gho_plain_a", refresh_token: null, id_token: null });
		racing.add(ID_A);

		expect(await runReencrypt()).toBe(0);
		expect(accountUpdates).toEqual([ID_A]);
		expect(accounts.get(ID_A)?.access_token).toBe("gho_plain_a");
		expect(printed).toContain("run again");
	});
});

describe("accountCountsAsReencrypt", () => {
	it("counts a raced row as skipped and keeps failures as failures", () => {
		expect(accountCountsAsReencrypt({ scanned: 5, changed: 2, skipped: 1, raced: 1, failed: 1 })).toEqual({
			scanned: 5,
			changed: 2,
			skipped: 2,
			failed: 1,
		});
	});
});
