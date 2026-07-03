// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Rewritten: the old version (plus the deleted tests/actions/runners.test.ts) re-implemented token
// hashing / verification / header extraction INLINE and never imported real code (≈0 mutation
// score). This drives the REAL lib/runners/auth.ts — hashRunnerToken, generateRunnerToken, and
// verifyRunnerToken (with the DB mocked at the boundary).

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import {
	generateRunnerToken,
	hashRunnerToken,
	verifyRunnerToken,
} from "@/lib/runners/auth";
import { getServiceDb } from "@/lib/db";

describe("hashRunnerToken", () => {
	it("is the SHA-256 hex digest of the token", () => {
		const expected = createHash("sha256").update("secret-token").digest("hex");
		expect(hashRunnerToken("secret-token")).toBe(expected);
		expect(hashRunnerToken("secret-token")).toHaveLength(64); // sha256 hex
	});

	it("is deterministic and input-sensitive", () => {
		expect(hashRunnerToken("a")).toBe(hashRunnerToken("a"));
		expect(hashRunnerToken("a")).not.toBe(hashRunnerToken("b"));
	});
});

describe("generateRunnerToken", () => {
	it("mints a 64-hex-char token whose hash matches hashRunnerToken", () => {
		const { token, hash } = generateRunnerToken();
		expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
		expect(hash).toBe(hashRunnerToken(token));
	});

	it("is non-deterministic (fresh randomness each call)", () => {
		expect(generateRunnerToken().token).not.toBe(generateRunnerToken().token);
	});
});

/** A drizzle-ish chain resolving to `rows` for the runner lookup. */
function mockDb(rows: unknown[]) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => db,
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

/** Build a Request carrying the runner auth headers. */
function reqWith(headers: Record<string, string>): Request {
	return new Request("https://x/api", { headers });
}

beforeEach(() => vi.clearAllMocks());

describe("verifyRunnerToken", () => {
	it("401s when the auth headers are missing", async () => {
		const res = await verifyRunnerToken(reqWith({}));
		expect(res.error?.status).toBe(401);
		expect(res.runnerId).toBe("");
	});

	it("401s when the stored hash doesn't match", async () => {
		mockDb([{ id: "runner-1", token_hash: hashRunnerToken("the-real-token") }]);
		const res = await verifyRunnerToken(
			reqWith({ "X-Runner-ID": "runner-1", "X-Runner-Token": "wrong-token" }),
		);
		expect(res.error?.status).toBe(401);
	});

	it("401s when the runner isn't found", async () => {
		mockDb([]);
		const res = await verifyRunnerToken(
			reqWith({ "X-Runner-ID": "ghost", "X-Runner-Token": "t" }),
		);
		expect(res.error?.status).toBe(401);
	});

	it("authorizes a matching id + token", async () => {
		const token = "the-real-token";
		mockDb([{ id: "runner-1", token_hash: hashRunnerToken(token) }]);
		const res = await verifyRunnerToken(
			reqWith({ "X-Runner-ID": "runner-1", "X-Runner-Token": token }),
		);
		expect(res.error).toBeNull();
		expect(res.runnerId).toBe("runner-1");
		expect(res.tokenHash).toBe(hashRunnerToken(token));
	});
});
