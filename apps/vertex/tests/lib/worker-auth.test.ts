// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
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

function extractWorkerHeaders(headers: Record<string, string | undefined>): {
	workerId: string | null;
	workerToken: string | null;
} {
	return {
		workerId: headers["x-worker-id"] ?? null,
		workerToken: headers["x-worker-token"] ?? null,
	};
}

describe("Worker auth - token hashing", () => {
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

describe("Worker auth - token verification", () => {
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

describe("Worker auth - header extraction", () => {
	it("extracts worker ID and token", () => {
		const result = extractWorkerHeaders({
			"x-worker-id": "worker-1",
			"x-worker-token": "token-abc",
		});
		expect(result.workerId).toBe("worker-1");
		expect(result.workerToken).toBe("token-abc");
	});

	it("returns null for missing headers", () => {
		const result = extractWorkerHeaders({});
		expect(result.workerId).toBeNull();
		expect(result.workerToken).toBeNull();
	});
});
