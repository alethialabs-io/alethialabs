// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The decision layer behind #3889 (what the consent screen is allowed to say, and which
// user_code may act on a request) and #3887 (a refusal that survives being polled).
//
// These predicates live in lib/** rather than in the route handlers because lib/** is
// inside the Vitest coverage scope and app/api/** is not. The routes stay thin transports
// over them; the route suite next door pins the transport.

import { describe, expect, it } from "vitest";
import {
	CLI_DEVICE_RATE_LIMIT,
	CLI_DEVICE_START_RATE_LIMIT,
	CLI_GIT_PROVIDERS,
	CLIENT_METADATA_MAX_LENGTH,
	DEVICE_ACCESS_DENIED,
	DEVICE_CODE_TTL_MS,
	PENDING_DEVICE_CODE_TTL_MS,
	checkUserCodeBinding,
	clientMetadataField,
	deviceApprovalScopes,
	deviceCodeExpiresAt,
	deviceCodeFail,
	deviceRequestStatus,
	isCliGitProvider,
	isPendingRequestExpired,
	pendingDeviceCodeExpiresAt,
} from "@/lib/auth/cli-device-code";

const CONSENT_USER_CODE = "BCDF-GHJK";
const CONSENT_OTHER_USER_CODE = "MNPQ-RSTV";

describe("checkUserCodeBinding", () => {
	// The whole point of #3889's binding half. Before it, `generate` validated the
	// user_code's SHAPE and never compared it against anything, so ANY well-formed code
	// approved any device code — the string on the consent screen was simply whatever the
	// link said.
	it("refuses a user_code that disagrees with the registered one", () => {
		expect(
			checkUserCodeBinding({ user_code: CONSENT_USER_CODE }, CONSENT_OTHER_USER_CODE),
		).toEqual({ ok: false, reason: "user_code_mismatch" });
	});

	it("accepts the registered user_code and reports it as bound", () => {
		expect(
			checkUserCodeBinding({ user_code: CONSENT_USER_CODE }, CONSENT_USER_CODE),
		).toEqual({ ok: true, bound: true });
	});

	// Compared exactly. The validators upstream pin the shape to upper-case AAAA-BBBB, so
	// a case-folding compare could only ever widen what counts as a match.
	it("does not case-fold a code into a match", () => {
		expect(
			checkUserCodeBinding({ user_code: CONSENT_USER_CODE }, "bcdf-ghjk"),
		).toEqual({ ok: false, reason: "user_code_mismatch" });
	});

	// The two permissive arms, and they are permissive DELIBERATELY: an already-shipped
	// `alethia login` never calls /api/auth/cli/start, so refusing them would sign every
	// released binary's users out the day this deploys. What they must NOT do is claim a
	// binding that does not exist — hence `bound: false`, which is what tells a caller the
	// code in front of the user was checked against nothing.
	it("permits a request with no row, and reports it as unbound", () => {
		expect(checkUserCodeBinding(undefined, CONSENT_USER_CODE)).toEqual({
			ok: true,
			bound: false,
		});
	});

	it("permits a row that stored no user_code, and reports it as unbound", () => {
		expect(checkUserCodeBinding({ user_code: null }, CONSENT_USER_CODE)).toEqual({
			ok: true,
			bound: false,
		});
	});
});

describe("deviceRequestStatus", () => {
	it("reads an unowned, unrefused row as pending", () => {
		expect(deviceRequestStatus({ profile_id: null, denied_at: null })).toBe("pending");
	});

	it("reads an owned row as approved", () => {
		expect(deviceRequestStatus({ profile_id: "user-1", denied_at: null })).toBe(
			"approved",
		);
	});

	// A refusal that lands after an approval must win, or the answer would depend on which
	// column the reader happened to look at first.
	it("lets a refusal win over an approval on the same row", () => {
		expect(
			deviceRequestStatus({ profile_id: "user-1", denied_at: new Date() }),
		).toBe("denied");
	});
});

describe("the pending window", () => {
	// #3889 says this in so many words: DEVICE_CODE_TTL_MS is the POST-approval redemption
	// window and displaying it as the countdown would be wrong. Two constants, and if they
	// ever collapse into one the consent screen starts showing a clock for a period that
	// has not begun.
	it("is a different clock from the post-approval redemption window", () => {
		const now = 1_700_000_000_000;
		expect(pendingDeviceCodeExpiresAt(now).getTime()).toBe(
			now + PENDING_DEVICE_CODE_TTL_MS,
		);
		expect(deviceCodeExpiresAt(now).getTime()).toBe(now + DEVICE_CODE_TTL_MS);
		expect(pendingDeviceCodeExpiresAt(now).getTime()).not.toBe(
			deviceCodeExpiresAt(now).getTime() - DEVICE_CODE_TTL_MS,
		);
	});

	it("closes once the deadline is reached", () => {
		const at = new Date(1_700_000_000_000);
		expect(isPendingRequestExpired({ pending_expires_at: at }, at.getTime() - 1)).toBe(
			false,
		);
		expect(isPendingRequestExpired({ pending_expires_at: at }, at.getTime())).toBe(true);
	});

	// The ONE place in this module that fails open, and only because it is a display aid:
	// the redemption boundary is isDeviceCodeExpired, which fails closed. A row with no
	// pending deadline is one an older CLI created, and refusing it would break every
	// in-flight login the moment this deploys.
	it("treats a row with no pending deadline as still open", () => {
		expect(isPendingRequestExpired({ pending_expires_at: null })).toBe(false);
	});
});

describe("clientMetadataField", () => {
	it("keeps an ordinary value", () => {
		expect(clientMetadataField(" alethia-cli ")).toBe("alethia-cli");
	});

	it("reports a missing, blank or non-string value as null rather than an empty answer", () => {
		expect(clientMetadataField(undefined)).toBeNull();
		expect(clientMetadataField("")).toBeNull();
		expect(clientMetadataField("   ")).toBeNull();
		expect(clientMetadataField(42)).toBeNull();
		expect(clientMetadataField({ toString: () => "x" })).toBeNull();
	});

	// These strings are rendered on a consent screen from an UNAUTHENTICATED request. An
	// unbounded one pushes the Approve/refuse buttons off the page, which is a denial of
	// the decision itself.
	it("cuts an oversized value to the display bound", () => {
		const flood = "A".repeat(CLIENT_METADATA_MAX_LENGTH * 10);
		expect(clientMetadataField(flood)).toHaveLength(CLIENT_METADATA_MAX_LENGTH);
	});
});

describe("deviceApprovalScopes", () => {
	// The screen said "A device is asking to sign in to your account" while approval also
	// returns a 90-day refresh token. Both have to be named.
	it("names the access token and the 90-day refresh token", () => {
		const ids = deviceApprovalScopes(null).map((s) => s.id);
		expect(ids).toEqual(["cli_access_token", "cli_refresh_token"]);
		expect(
			deviceApprovalScopes(null).find((s) => s.id === "cli_refresh_token")?.detail,
		).toMatch(/90 days/);
	});

	it("names the git-provider token, and which provider it is", () => {
		const git = deviceApprovalScopes("github").find(
			(s) => s.id === "git_provider_token",
		);
		expect(git?.label).toContain("GitHub");
		expect(git?.detail).toContain("GitHub");
	});

	// A screen that lists a token which will not be handed over teaches the reader to
	// discount the whole list.
	it("omits the git line when no provider will contribute a token", () => {
		expect(
			deviceApprovalScopes(null).some((s) => s.id === "git_provider_token"),
		).toBe(false);
	});

	// The summary and the route that actually stashes the token read ONE list. Two copies
	// is how a consent screen ends up under-reporting: add a provider to the stash alone
	// and approval starts handing over a token the screen never named.
	it("can describe every provider whose token approval hands over", () => {
		for (const provider of CLI_GIT_PROVIDERS) {
			expect(isCliGitProvider(provider)).toBe(true);
			const git = deviceApprovalScopes(provider).find(
				(s) => s.id === "git_provider_token",
			);
			expect(git).toBeDefined();
			// No provider may fall through to an "undefined" label.
			expect(git?.label).not.toMatch(/undefined/i);
		}
		expect(isCliGitProvider("google")).toBe(false);
	});
});

describe("the wire contract", () => {
	// A WIRE value: the exchange route writes it and pollForToken in apps/cli/cmd/login.go
	// compares against it. Spelt differently on either side the CLI falls through to its
	// generic "authentication failed (HTTP 403)" arm and the user learns nothing.
	it("uses RFC 8628's access_denied code verbatim", () => {
		expect(DEVICE_ACCESS_DENIED).toBe("access_denied");
	});

	it("answers in one JSON error shape, with an optional description", () => {
		return Promise.all([
			deviceCodeFail("Unauthorized", 401).json(),
			deviceCodeFail(DEVICE_ACCESS_DENIED, 403, "Refused in the browser.").json(),
		]).then(([plain, described]) => {
			expect(plain).toEqual({ error: "Unauthorized" });
			expect(described).toEqual({
				error: "access_denied",
				error_description: "Refused in the browser.",
			});
		});
	});

	// The one UNAUTHENTICATED route here that WRITES must not share the poll's budget: an
	// honest `alethia login` registers once and polls ~30 times a minute, so one bucket
	// would let ordinary polling authorise a flood of row inserts.
	it("gives the unauthenticated write route a tighter budget than the poll", () => {
		expect(CLI_DEVICE_START_RATE_LIMIT.limit).toBeLessThan(CLI_DEVICE_RATE_LIMIT.limit);
	});
});
