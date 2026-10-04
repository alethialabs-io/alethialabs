// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two membership reads #5472 adds to core:
//   - `lacksActiveMembership`, the rule both PDPs deny on: a member row that is not `active`, and
//     also NO member row outside the personal scope. Before it the OpenFGA engine denied only a
//     non-active row, so a user with no row (removed through a path that left their `team_member`
//     rows) was still granted their teams' access there while Postgres refused it.
//   - `inviterRefusal`, which `beforeAcceptInvitation` refuses an invitation with when its inviter
//     is no longer an active member — except the platform system user, which is never a member.
//
// The database is a stand-in answering each `select … limit` with the next queued rows; the PDP
// behaviour against real Postgres and OpenFGA is in tests/integration/pdp-parity.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	/** The rows each successive `select … limit(1)` answers with, in order. */
	const rows: unknown[][] = [];
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: vi.fn(async () => rows.shift() ?? []),
	};
	return { rows, chain };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => h.chain }));
vi.mock("@/lib/authz/tuple-sync", () => ({ getTupleSync: () => ({}) }));

import {
	INVITER_NOT_ACTIVE_MESSAGE,
	inviterRefusal,
	lacksActiveMembership,
} from "@/lib/authz/grants";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const PLATFORM_EMAIL = "platform@alethia.test";

beforeEach(() => {
	vi.clearAllMocks();
	h.rows.length = 0;
	vi.stubEnv("PLATFORM_SYSTEM_USER_EMAIL", PLATFORM_EMAIL);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("lacksActiveMembership — the rule both PDPs deny on (#5472)", () => {
	it("is true for a non-active row AND for no row; false for an active row", async () => {
		h.rows.push([{ status: "suspended" }]);
		expect(await lacksActiveMembership(ORG, USER)).toBe(true);
		h.rows.push([]);
		expect(await lacksActiveMembership(ORG, USER)).toBe(true);
		h.rows.push([{ status: "active" }]);
		expect(await lacksActiveMembership(ORG, USER)).toBe(false);
	});

	it("is false in the personal scope (org id = user id), which has no member row, without reading one", async () => {
		expect(await lacksActiveMembership(USER, USER)).toBe(false);
		expect(h.chain.limit).not.toHaveBeenCalled();
	});
});

describe("inviterRefusal — an invitation is honoured only while its inviter is active (#5472)", () => {
	it("refuses an invitation from a suspended inviter and from one with no member row", async () => {
		h.rows.push([{ status: "suspended" }], [{ email: "admin@example.test" }]);
		expect(await inviterRefusal(ORG, USER)).toBe(INVITER_NOT_ACTIVE_MESSAGE);
		h.rows.push([], [{ email: "admin@example.test" }]);
		expect(await inviterRefusal(ORG, USER)).toBe(INVITER_NOT_ACTIVE_MESSAGE);
	});

	it("honours an active inviter, and the platform system user that provisionOrg invites as", async () => {
		h.rows.push([{ status: "active" }]);
		expect(await inviterRefusal(ORG, USER)).toBeNull();
		h.rows.push([], [{ email: ` ${PLATFORM_EMAIL.toUpperCase()} ` }]);
		expect(await inviterRefusal(ORG, USER)).toBeNull();
	});

	it("refuses a non-member inviter when no platform system user is configured", async () => {
		vi.stubEnv("PLATFORM_SYSTEM_USER_EMAIL", "");
		h.rows.push([]);
		expect(await inviterRefusal(ORG, USER)).toBe(INVITER_NOT_ACTIVE_MESSAGE);
	});
});
