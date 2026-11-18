// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `readStatusOf` is what the shell's switchers and bell render from. A read refused for want of a
// session is not a statement about what the viewer may see, so it must not come out as `forbidden`
// (CON-SM4, #6813): the session-ended dialog answers it, and the surface behind keeps waiting.

import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import { readStatusOf } from "@/lib/query/read-status";

/** A typed refusal as the read router sends it. */
function refusal(code: string, status: number) {
	return new ORPCError(code, { defined: true, status });
}

describe("readStatusOf", () => {
	it("no answer and no error is pending", () => {
		expect(readStatusOf({ data: undefined })).toBe("pending");
		expect(readStatusOf({ data: undefined, isError: false, error: null })).toBe("pending");
	});

	it("data wins, even an empty list and even beside a failed refetch", () => {
		expect(readStatusOf({ data: [] })).toBe("ready");
		expect(readStatusOf({ data: [], isError: true, error: new Error("boom") })).toBe("ready");
		expect(readStatusOf({ data: null })).toBe("ready");
	});

	it("a real failure is error", () => {
		expect(readStatusOf({ data: undefined, isError: true, error: new Error("boom") })).toBe("error");
	});

	it("an undeclared ORPC error is a failure, not a refusal", () => {
		const undeclared = new ORPCError("FORBIDDEN", { status: 403 });
		expect(readStatusOf({ data: undefined, isError: true, error: undeclared })).toBe("error");
	});

	it.each([
		["FORBIDDEN", 403],
		["NOT_FOUND", 404],
		["ENTITLEMENT_REQUIRED", 402],
	])("%s is forbidden: an answer about what the viewer may see", (code, status) => {
		expect(readStatusOf({ data: undefined, isError: true, error: refusal(code, status) })).toBe("forbidden");
	});

	it("UNAUTHORIZED is not forbidden and not error: it stays pending behind the session dialog", () => {
		const signedOut = { data: undefined, isError: true, error: refusal("UNAUTHORIZED", 401) };
		expect(readStatusOf(signedOut)).toBe("pending");
	});
});
