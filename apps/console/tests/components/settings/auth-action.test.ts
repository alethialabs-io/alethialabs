// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Better Auth adapter tells a dropped connection apart from a server failure (R6 E-07): a call
// that got no answer is `network` (outcome unknown), never "something went wrong on our side" with
// a reference that names no server event.

import { describe, expect, it } from "vitest";
import { authActionError, viaAuth } from "@/components/settings/members/auth-action";

describe("viaAuth", () => {
	it("answers a call that throws as network, sent", async () => {
		const result = await viaAuth(async () => {
			throw new TypeError("Failed to fetch");
		});
		expect(result).toEqual({ ok: false, error: { kind: "network", sent: true } });
	});

	it("answers a success as a success", async () => {
		expect(await viaAuth(async () => ({ error: null }))).toEqual({ ok: true, data: null });
	});
});

describe("authActionError", () => {
	it("maps status 0 (no HTTP answer) to network", () => {
		expect(authActionError({ status: 0 })).toEqual({ kind: "network", sent: true });
	});

	it("keeps a 4xx message and hides a 5xx behind a reference", () => {
		expect(authActionError({ status: 409, message: "Already a member" })).toEqual({
			kind: "conflict",
			message: "Already a member",
		});
		expect(authActionError({ status: 503 })).toEqual({ kind: "unexpected", ref: "auth-503" });
	});
});
