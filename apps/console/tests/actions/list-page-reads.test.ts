// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The seven `get*Page` server actions #2899 adds — the server half of the console filter
// standard. Each is a thin wrapper, and the thinness is the point: a page read that takes a
// client-supplied query is exactly the shape where a tenancy bug hides, because the query
// object arrives from the browser and the org must NOT.
//
// So these tests assert two things per action and nothing else:
//
//   1. the org (and, for members, the user) handed to the query builder comes from the
//      resolved ACTOR — never from the query object, even when the caller tries to put one
//      there;
//   2. the permission asked for is the same one the surface's unfiltered read asks for, so
//      the parameterized sibling cannot become a way around a gate.
//
// The builders themselves are mocked here; their behaviour is covered in tests/lib/queries.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/crypto/secrets", () => ({
	encryptSecret: vi.fn(),
	isCredEncryptionConfigured: vi.fn(),
}));
vi.mock("@/lib/alerts/channels", () => ({ getChannelSender: vi.fn() }));
vi.mock("@/lib/alerts/rule-cache", () => ({ invalidateOrgRules: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/queries/alerts-lists", () => ({
	queryAlertChannelsPage: vi.fn(),
	queryAlertPoliciesPage: vi.fn(),
	queryAlertDeliveriesPage: vi.fn(),
}));
vi.mock("@/lib/queries/access-grants", () => ({ queryAccessGrantsPage: vi.fn() }));
vi.mock("@/lib/queries/members", () => ({ queryMembersPage: vi.fn() }));
vi.mock("@/lib/queries/teams", () => ({ queryTeamsPage: vi.fn() }));

import {
	getAlertChannelsPage,
	getAlertDeliveriesPage,
	getAlertPoliciesPage,
} from "@/app/server/actions/alerts";
import { getAccessGrantsPage } from "@/app/server/actions/grants";
import { getMembersPage } from "@/app/server/actions/members";
import { getTeamsPage } from "@/app/server/actions/teams";
import { authorize, currentActor } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { queryAccessGrantsPage } from "@/lib/queries/access-grants";
import {
	queryAlertChannelsPage,
	queryAlertDeliveriesPage,
	queryAlertPoliciesPage,
} from "@/lib/queries/alerts-lists";
import { queryMembersPage } from "@/lib/queries/members";
import { queryTeamsPage } from "@/lib/queries/teams";

const ACTOR = { orgId: "org-real", userId: "user-real" };

/**
 * A query object carrying the fields a hostile client would try to smuggle a tenancy in.
 *
 * Declared as a variable rather than passed inline on purpose: TypeScript's excess-property
 * check only fires on a fresh object literal, so this reaches the actions with its extra keys
 * intact — which is the whole point. An inline literal would be rejected at compile time and
 * the runtime assertion would never get to run.
 */
const HOSTILE = {
	search: "x",
	orgId: "org-someone-elses",
	org_id: "org-someone-elses",
	userId: "user-someone-elses",
	actor: { orgId: "org-someone-elses" },
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue(ACTOR as never);
	vi.mocked(currentActor).mockResolvedValue(ACTOR as never);
});

describe("the alerts hub's three page reads", () => {
	const cases = [
		["channels", getAlertChannelsPage, queryAlertChannelsPage],
		["policies", getAlertPoliciesPage, queryAlertPoliciesPage],
		["deliveries", getAlertDeliveriesPage, queryAlertDeliveriesPage],
	] as const;

	for (const [name, action, builder] of cases) {
		it(`${name}: asks for view_alerts on an alert, and scopes to the ACTOR's org`, async () => {
			vi.mocked(builder).mockResolvedValue({ rows: [] } as never);

			await action(HOSTILE as never);

			expect(authorize).toHaveBeenCalledWith("view_alerts", { type: "alert" });
			expect(builder).toHaveBeenCalledWith("org-real", HOSTILE);
			// Not the org the query claimed.
			expect(vi.mocked(builder).mock.calls[0][0]).not.toBe("org-someone-elses");
		});

		it(`${name}: does not read anything when the gate denies`, async () => {
			vi.mocked(authorize).mockRejectedValue(
				new ForbiddenError("view_alerts", { type: "alert" }),
			);
			await expect(action({})).rejects.toBeInstanceOf(ForbiddenError);
			expect(builder).not.toHaveBeenCalled();
		});

		it(`${name}: defaults to an empty query when called with no arguments`, async () => {
			vi.mocked(builder).mockResolvedValue({ rows: [] } as never);
			await action();
			expect(builder).toHaveBeenCalledWith("org-real", {});
		});
	}
});

describe("getAccessGrantsPage", () => {
	it("gates on member:view — the same permission the unfiltered list asks for", async () => {
		vi.mocked(queryAccessGrantsPage).mockResolvedValue({ rows: [] } as never);
		await getAccessGrantsPage({ scopes: ["org"] });
		expect(authorize).toHaveBeenCalledWith("view", { type: "member" });
		expect(queryAccessGrantsPage).toHaveBeenCalledWith("org-real", { scopes: ["org"] });
	});

	it("passes projectId through as the universe selector, still under the actor's org", async () => {
		vi.mocked(queryAccessGrantsPage).mockResolvedValue({ rows: [] } as never);
		const hostileWithProject = { ...HOSTILE, projectId: "p1" };
		await getAccessGrantsPage(hostileWithProject);
		const [orgId, query] = vi.mocked(queryAccessGrantsPage).mock.calls[0];
		expect(orgId).toBe("org-real");
		expect(query).toMatchObject({ projectId: "p1" });
	});

	it("reads nothing when the gate denies", async () => {
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("view", { type: "member" }));
		await expect(getAccessGrantsPage()).rejects.toBeInstanceOf(ForbiddenError);
		expect(queryAccessGrantsPage).not.toHaveBeenCalled();
	});
});

describe("getMembersPage", () => {
	it("takes BOTH the org and the viewer from the actor", async () => {
		// The viewer id is what synthesizes a personal workspace's sole owner, so a
		// client-supplied one would let a caller render someone else's account as the owner.
		vi.mocked(queryMembersPage).mockResolvedValue({ members: [] } as never);
		await getMembersPage(HOSTILE);
		expect(currentActor).toHaveBeenCalled();
		expect(queryMembersPage).toHaveBeenCalledWith("org-real", "user-real", HOSTILE);
	});

	it("defaults to an empty query", async () => {
		vi.mocked(queryMembersPage).mockResolvedValue({ members: [] } as never);
		await getMembersPage();
		expect(queryMembersPage).toHaveBeenCalledWith("org-real", "user-real", {});
	});

	it("reads nothing when there is no active tenancy", async () => {
		vi.mocked(currentActor).mockRejectedValue(new ForbiddenError("view", { type: "member" }));
		await expect(getMembersPage()).rejects.toBeInstanceOf(ForbiddenError);
		expect(queryMembersPage).not.toHaveBeenCalled();
	});
});

describe("getTeamsPage", () => {
	it("scopes to the actor's org and forwards the query untouched", async () => {
		vi.mocked(queryTeamsPage).mockResolvedValue({ rows: [] } as never);
		await getTeamsPage({ search: "plat", sizes: ["large"] });
		expect(currentActor).toHaveBeenCalled();
		expect(queryTeamsPage).toHaveBeenCalledWith("org-real", {
			search: "plat",
			sizes: ["large"],
		});
	});

	it("reads nothing when there is no active tenancy", async () => {
		vi.mocked(currentActor).mockRejectedValue(new ForbiddenError("view", { type: "member" }));
		await expect(getTeamsPage()).rejects.toBeInstanceOf(ForbiddenError);
		expect(queryTeamsPage).not.toHaveBeenCalled();
	});
});
