// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { describe, expect, it } from "vitest";
import { MAX_PERSISTED_ERROR_CHARS, persistableErrorText } from "@/lib/errors";

describe("persistableErrorText", () => {
	it("passes null and ordinary messages through unchanged", () => {
		expect(persistableErrorText(null)).toBeNull();
		expect(persistableErrorText("AssumeRole denied\n\tretry later")).toBe(
			"AssumeRole denied\n\tretry later",
		);
	});

	it("escapes NUL and every other control character Postgres or a terminal would choke on", () => {
		// The exact shape grid run 36611808450 persisted: V8's JSON.parse message quoting a brotli body.
		const raw = `Unexpected token '\u001b', "\u001b�\u0004\u0000d~M�Ow"... is not valid JSON\u007f\u0085`;
		const safe = persistableErrorText(raw) ?? "";
		expect(safe).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
		expect(safe).toContain("\\x00");
		expect(safe).toContain("\\x1b");
		expect(safe).toContain("\\x7f");
		expect(safe).toContain("\\x85");
	});

	it("replaces a lone surrogate, which has no UTF-8 encoding", () => {
		expect(persistableErrorText("a\ud800b\udc00c")).toBe("a�b�c");
		expect(persistableErrorText("pair 😀 kept")).toBe("pair 😀 kept");
	});

	it("caps the length without splitting a surrogate pair", () => {
		const long = `${"x".repeat(MAX_PERSISTED_ERROR_CHARS - 2)}😀${"y".repeat(50)}`;
		const safe = persistableErrorText(long) ?? "";
		expect(safe.length).toBeLessThanOrEqual(MAX_PERSISTED_ERROR_CHARS);
		expect(safe.endsWith("…")).toBe(true);
		expect(safe).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
	});
});
