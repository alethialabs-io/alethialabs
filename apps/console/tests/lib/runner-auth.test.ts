// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { createHash } from "crypto";

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function verifyToken(providedToken: string, storedHash: string): boolean {
	const computedHash = hashToken(providedToken);
	return computedHash === storedHash;
}

function extractRunnerHeaders(headers: Record<string, string | undefined>): {
	runnerId: string | null;
	runnerToken: string | null;
} {
	return {
		runnerId: headers["x-runner-id"] ?? null,
		runnerToken: headers["x-runner-token"] ?? null,
	};
}

describe("Runner auth - token hashing", () => {
	it("produces consistent SHA256 hash", () => {
		const token = "abc123";
		const hash1 = hashToken(token);
		const hash2 = hashToken(token);
		expect(hash1).toBe(hash2);
		expect(hash1).toHaveLength(64);
	});

	it("different tokens produce different hashes", () => {
		expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
	});
});

describe("Runner auth - token verification", () => {
	it("verifies correct token", () => {
		const token = "my-secret-token";
		const hash = hashToken(token);
		expect(verifyToken(token, hash)).toBe(true);
	});

	it("rejects wrong token", () => {
		const hash = hashToken("correct-token");
		expect(verifyToken("wrong-token", hash)).toBe(false);
	});
});

describe("Runner auth - header extraction", () => {
	it("extracts runner ID and token", () => {
		const result = extractRunnerHeaders({
			"x-runner-id": "runner-1",
			"x-runner-token": "token-abc",
		});
		expect(result.runnerId).toBe("runner-1");
		expect(result.runnerToken).toBe("token-abc");
	});

	it("returns null for missing headers", () => {
		const result = extractRunnerHeaders({});
		expect(result.runnerId).toBeNull();
		expect(result.runnerToken).toBeNull();
	});
});
