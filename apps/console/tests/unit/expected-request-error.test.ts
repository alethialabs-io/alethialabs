// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit: isExpectedRequestError partitions normal control flow (auth redirect / notFound / no-session)
// from real bugs, so onRequestError doesn't flood error tracking with non-actionable noise.

import { describe, expect, it } from "vitest";
import { isExpectedRequestError } from "@/lib/errors";

describe("isExpectedRequestError", () => {
	it("treats the auth no-session sentinel as expected", () => {
		expect(isExpectedRequestError(new Error("Unauthorized"))).toBe(true);
	});

	it("treats Next redirect()/notFound() digests as expected", () => {
		expect(isExpectedRequestError({ digest: "NEXT_REDIRECT;replace;/login;307;" })).toBe(true);
		expect(isExpectedRequestError({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" })).toBe(true);
		expect(isExpectedRequestError({ digest: "NEXT_NOT_FOUND" })).toBe(true);
	});

	it("does NOT swallow real bugs (still reported)", () => {
		expect(isExpectedRequestError(new Error("cannot change return type of existing function"))).toBe(false);
		expect(isExpectedRequestError(new Error("Project not found"))).toBe(false);
		expect(isExpectedRequestError(new Error("boom"))).toBe(false);
		expect(isExpectedRequestError(null)).toBe(false);
		expect(isExpectedRequestError("Unauthorized-ish but not exact")).toBe(false);
	});
});
