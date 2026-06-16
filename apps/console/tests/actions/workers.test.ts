// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "crypto";

function generateWorkerToken(): { token: string; hash: string } {
	const token = randomBytes(32).toString("hex");
	const hash = createHash("sha256").update(token).digest("hex");
	return { token, hash };
}

describe("Worker token generation", () => {
	it("generates a 64-char hex token", () => {
		const { token } = generateWorkerToken();
		expect(token).toHaveLength(64);
		expect(/^[0-9a-f]+$/.test(token)).toBe(true);
	});

	it("generates a valid SHA256 hash", () => {
		const { token, hash } = generateWorkerToken();
		const expectedHash = createHash("sha256").update(token).digest("hex");
		expect(hash).toBe(expectedHash);
		expect(hash).toHaveLength(64);
	});

	it("generates unique tokens each time", () => {
		const tokens = new Set(
			Array.from({ length: 100 }, () => generateWorkerToken().token),
		);
		expect(tokens.size).toBe(100);
	});

	it("hash matches token verification pattern", () => {
		const { token, hash } = generateWorkerToken();
		const verifyHash = createHash("sha256").update(token).digest("hex");
		expect(verifyHash === hash).toBe(true);
	});
});
