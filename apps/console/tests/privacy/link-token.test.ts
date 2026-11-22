// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The secret a privacy email carries (lib/privacy/link-token.ts): only its hash is stored, two
// tokens never repeat, and the shape check accepts exactly what the minter produces.

import { describe, expect, it } from "vitest";
import { hashLinkToken, isLinkTokenShape, mintLinkToken } from "@/lib/privacy/link-token";

describe("link tokens", () => {
	it("store a hash that is not the token, and never repeat", () => {
		const a = mintLinkToken();
		const b = mintLinkToken();
		expect(a.sha256).toBe(hashLinkToken(a.token));
		expect(a.sha256).not.toBe(a.token);
		expect(a.token).not.toBe(b.token);
	});

	it("accept exactly the minted shape", () => {
		expect(isLinkTokenShape(mintLinkToken().token)).toBe(true);
		expect(isLinkTokenShape("short")).toBe(false);
		expect(isLinkTokenShape(`${"a".repeat(42)}!`)).toBe(false);
	});
});
