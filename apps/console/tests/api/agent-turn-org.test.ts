// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0003's O tests (§11, case 10): `resolveTurnActor`, the named-org resolver a chat turn runs and
// bills as. The REAL guard and the REAL `getActiveScope` (lib/auth/scope.ts) run; the mocked boundary
// is the enterprise seam (`getEnterprise`), the PDP, and the session readers — the last only so a
// test can prove they are NEVER read.
//
// Two editions:
//  · community — `getEnterprise()` is null, so `getActiveScope` always answers the personal org.
//  · enterprise-shaped — `resolveScope` reproduces ee/src/scope.ts's `resolveActiveScope` over an
//    in-memory `member` table: a named personal org resolves as itself, a named org with an ACTIVE
//    row resolves to it, and anything else FALLS BACK to the earliest active membership, else the
//    personal org. That fallback is what makes the suspended-member case dangerous: a resolver
//    that accepted the personal org as an answer would bill the turn there.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enterprise", () => ({ getEnterprise: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { getOwnerScope } from "@/lib/auth/owner";
import { getPdp } from "@/lib/authz";
import { getInjectedActor } from "@/lib/authz/actor-context";
import { resolveTurnActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { getEnterprise } from "@/lib/enterprise";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** One `member` row, as ee/src/scope.ts reads it. */
interface MemberRow {
	userId: string;
	orgId: string;
	status: "active" | "suspended";
}

let members: MemberRow[] = [];

/**
 * ee/src/scope.ts's `resolveActiveScope`, over `members` (rows in creation order): the personal org
 * named as itself, a named org with an ACTIVE row, else the earliest active membership, else personal.
 */
async function enterpriseResolveScope(userId: string, activeOrgId?: string): Promise<Actor> {
	if (activeOrgId === userId) return { userId, orgId: userId };
	const active = members.filter((m) => m.userId === userId && m.status === "active");
	if (activeOrgId && active.some((m) => m.orgId === activeOrgId)) {
		return { userId, orgId: activeOrgId };
	}
	return { userId, orgId: active[0]?.orgId ?? userId };
}

const can = vi.fn();
const enforce = vi.fn();

/** Selects the community edition: no enterprise module registered. */
function community(): void {
	vi.mocked(getEnterprise).mockReturnValue(null);
}

/** Selects the enterprise-shaped edition over the given membership rows. */
function enterprise(rows: MemberRow[]): void {
	members = rows;
	vi.mocked(getEnterprise).mockReturnValue({ resolveScope: enterpriseResolveScope });
}

beforeEach(() => {
	vi.clearAllMocks();
	members = [];
	can.mockResolvedValue({ allowed: true });
	enforce.mockResolvedValue(undefined);
	vi.mocked(getPdp).mockReturnValue({
		can,
		enforce,
		bulkCheck: vi.fn(),
		listAccessible: vi.fn(),
	});
	// A session and an injected actor that both name ANOTHER org: if either were read, the answer
	// would be ORG_B — which no test below expects.
	vi.mocked(getOwnerScope).mockResolvedValue({ userId: USER, activeOrgId: ORG_B });
	vi.mocked(getInjectedActor).mockReturnValue({ userId: USER, orgId: ORG_B });
});

describe("resolveTurnActor — community", () => {
	it("community: orgId = userId resolves", async () => {
		community();

		const actor = await resolveTurnActor(USER, USER);

		expect(actor).toMatchObject({ userId: USER, orgId: USER });
		expect(can).toHaveBeenCalledWith(actor, "view", { type: "org" });
	});

	it("community: a real team org id is refused, not collapsed to the personal org", async () => {
		// Strictly two-way: community's resolver answers the personal org for every argument, and
		// that is a substitution here. The client names the user id in community (§6.1 step 1).
		community();

		expect(await resolveTurnActor(USER, ORG_A)).toBeNull();
		expect(can).not.toHaveBeenCalled();
	});
});

describe("resolveTurnActor — enterprise", () => {
	it("an active member naming their org resolves to it", async () => {
		enterprise([{ userId: USER, orgId: ORG_A, status: "active" }]);

		const actor = await resolveTurnActor(USER, ORG_A);

		expect(actor).toMatchObject({ userId: USER, orgId: ORG_A });
	});

	it("the personal org named as the user id resolves to it, beside an active team membership", async () => {
		enterprise([{ userId: USER, orgId: ORG_A, status: "active" }]);

		const actor = await resolveTurnActor(USER, USER);

		expect(actor).toMatchObject({ userId: USER, orgId: USER });
	});

	it("enterprise: a suspended member naming their former org is 403 before the hold, not billed to their personal org", async () => {
		// The resolver falls back to the personal org (no other active row). Accepting that answer
		// is exactly `currentActor()`'s third arm, and it would bill the turn there.
		enterprise([{ userId: USER, orgId: ORG_A, status: "suspended" }]);

		expect(await resolveTurnActor(USER, ORG_A)).toBeNull();
		expect(can).not.toHaveBeenCalled();
		expect(enforce).not.toHaveBeenCalled();
	});

	it("a suspended member with another active org is refused, not landed on that org", async () => {
		enterprise([
			{ userId: USER, orgId: ORG_A, status: "suspended" },
			{ userId: USER, orgId: ORG_B, status: "active" },
		]);

		expect(await resolveTurnActor(USER, ORG_A)).toBeNull();
	});

	it("a caller who left the org (no row at all) is refused", async () => {
		enterprise([]);

		expect(await resolveTurnActor(USER, ORG_A)).toBeNull();
	});

	it("a resolved org whose `view` the PDP denies is refused", async () => {
		enterprise([{ userId: USER, orgId: ORG_A, status: "active" }]);
		can.mockResolvedValueOnce({ allowed: false, reason: "no_grant" });

		expect(await resolveTurnActor(USER, ORG_A)).toBeNull();
	});
});

describe("resolveTurnActor — no session fallback, and quiet", () => {
	it.each([
		["undefined", undefined],
		["empty", ""],
	])("an %s orgId is refused; neither the session nor an injected actor is read", async (_label, orgId) => {
		enterprise([{ userId: USER, orgId: ORG_B, status: "active" }]);

		expect(await resolveTurnActor(USER, orgId)).toBeNull();
		expect(getOwnerScope).not.toHaveBeenCalled();
		expect(getInjectedActor).not.toHaveBeenCalled();
	});

	it("a session pointing at B does not move a turn that names A", async () => {
		enterprise([
			{ userId: USER, orgId: ORG_A, status: "active" },
			{ userId: USER, orgId: ORG_B, status: "active" },
		]);

		const actor = await resolveTurnActor(USER, ORG_A);

		expect(actor?.orgId).toBe(ORG_A);
		expect(getOwnerScope).not.toHaveBeenCalled();
		expect(getInjectedActor).not.toHaveBeenCalled();
	});

	it("asks can(), never enforce(): no activity row, allow or deny", async () => {
		enterprise([{ userId: USER, orgId: ORG_A, status: "active" }]);

		await resolveTurnActor(USER, ORG_A);
		can.mockResolvedValueOnce({ allowed: false, reason: "no_grant" });
		await resolveTurnActor(USER, ORG_A);

		expect(can).toHaveBeenCalledTimes(2);
		expect(enforce).not.toHaveBeenCalled();
	});

	it("a failed scope lookup propagates; it is never reported as a refusal", async () => {
		vi.mocked(getEnterprise).mockReturnValue({
			resolveScope: () => Promise.reject(new Error("db down")),
		});

		await expect(resolveTurnActor(USER, ORG_A)).rejects.toThrow("db down");
	});
});
