// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/grants — the resource-KIND half of the scope (#4734).
//
// `resource_type` arrives as `z.string().min(1)` and, until this suite, nothing held it against
// the kinds the PDPs can read. Since #4584 an uninterpretable kind is not inert: a DENY row whose
// scope resolves to nothing excludes the WHOLE ORG on both engines, so `resource_type: "projects"`
// — one plural — turns "deny project:deploy on project P" into an org-wide denial, from a request
// that answers 201.
//
// BOTH DIRECTIONS ARE ASSERTED HERE ON PURPOSE. A validator that refused everything would also
// close the bug and would break every real grant the console and CLI write, so the accepted set is
// walked kind by kind and each one is required to reach the insert with its kind intact. The walk
// reads `GRANT_RESOURCE_TYPES`, which is derived from the hierarchy table — so a kind added there
// is exercised here without anyone remembering to add it.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/role-permissions", () => ({ rolePermissionKeys: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ getTupleSync: vi.fn() }));
vi.mock("@/lib/authz/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { POST } from "@/app/api/cli/grants/route";
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { INSTANCE_TYPES } from "@/lib/authz/fga-hierarchy";
import { authorizeCli } from "@/lib/authz/guard";
import { rolePermissionKeys } from "@/lib/authz/role-permissions";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import {
	GRANT_RESOURCE_TYPES,
	UNKNOWN_RESOURCE_TYPE,
} from "@/lib/validations/grants";

const PRINCIPAL = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";

/**
 * A drizzle-ish chain: every builder returns the chain, and awaiting it resolves to the row the
 * insert is told to return. `valuesSpy` records what would have been persisted, which is how a
 * refusal is told apart from an accepted write that merely answered 400 for another reason.
 */
function makeDb() {
	const valuesSpy = vi.fn();
	const insertSpy = vi.fn();
	let lastValues: Record<string, unknown> = {};
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		leftJoin: () => db,
		where: () => db,
		orderBy: () => db,
		limit: () => db,
		insert: () => {
			insertSpy();
			return db;
		},
		values: (v: Record<string, unknown>) => {
			lastValues = v;
			valuesSpy(v);
			return db;
		},
		returning: () => db,
		then: (resolve: (v: unknown) => void) =>
			resolve([
				{
					id: GRANT_ID,
					principal_type: lastValues.principal_type ?? "user",
					principal_id: lastValues.principal_id ?? PRINCIPAL,
					effect: lastValues.effect ?? "allow",
					role_id: lastValues.role_id ?? null,
					permission_key: lastValues.permission_key ?? null,
					resource_type: lastValues.resource_type ?? "org",
					resource_id: lastValues.resource_id ?? null,
				},
			]),
	});
	return { db, valuesSpy, insertSpy };
}

let mock: ReturnType<typeof makeDb>;
const syncScopedGrant = vi.fn().mockResolvedValue(undefined);

/** The request `alethia grants add` sends. */
function req(body: Record<string, unknown>): Request {
	return new Request("https://console.local/api/cli/grants", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** A grant body that differs from a good one only in the fields the case is about. */
function grantBody(over: Record<string, unknown>): Record<string, unknown> {
	return {
		principal_type: "user",
		principal_id: PRINCIPAL,
		effect: "deny",
		permission_key: "project:deploy",
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mock = makeDb();
	syncScopedGrant.mockResolvedValue(undefined);
	vi.mocked(getServiceDb).mockReturnValue(mock.db as never);
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
		credential: "session",
	} as never);
	vi.mocked(getEntitlements).mockReturnValue({ customRoles: true } as never);
	vi.mocked(getPdp).mockReturnValue({
		can: vi.fn().mockResolvedValue({ allowed: true }),
	} as never);
	vi.mocked(rolePermissionKeys).mockResolvedValue([]);
	vi.mocked(getTupleSync).mockReturnValue({ syncScopedGrant } as never);
});

describe("POST /api/cli/grants — the accepted set", () => {
	it("is the hierarchy table's scopable kinds plus the org wildcard, not a second list", () => {
		expect([...GRANT_RESOURCE_TYPES]).toEqual(["org", ...INSTANCE_TYPES]);
	});
});

describe("POST /api/cli/grants — an unrecognised resource_type is refused", () => {
	it("refuses a misspelled kind carrying a resource id, and stores nothing", async () => {
		const res = await POST(
			req(grantBody({ resource_type: "projects", resource_id: RESOURCE })),
		);
		expect(res.status).toBe(400);
		const body: unknown = await res.json();
		expect(body).toEqual({ error: UNKNOWN_RESOURCE_TYPE });
		expect(mock.insertSpy).not.toHaveBeenCalled();
		expect(syncScopedGrant).not.toHaveBeenCalled();
	});

	it("names every accepted kind in the refusal", async () => {
		const res = await POST(
			req(grantBody({ resource_type: "projects", resource_id: RESOURCE })),
		);
		const body: unknown = await res.json();
		const error =
			typeof body === "object" && body !== null && "error" in body
				? String(body.error)
				: "";
		for (const kind of GRANT_RESOURCE_TYPES) {
			expect(error).toContain(kind);
		}
	});

	// The id-less form is the one that looks harmless. `resource_type` is collapsed to `"org"`
	// when no id is given, so without this check a misspelled kind is laundered into a real
	// ORGANIZATION-WIDE grant — wider than the scope the caller was asking for, and silently.
	it("refuses a misspelled kind sent without a resource id", async () => {
		const res = await POST(req(grantBody({ resource_type: "projects" })));
		expect(res.status).toBe(400);
		// The message, not only the status: a body this route refused for some OTHER reason — a
		// malformed uuid, say — also answers 400, and asserting the status alone would pass on it.
		expect(await res.json()).toEqual({ error: UNKNOWN_RESOURCE_TYPE });
		expect(mock.insertSpy).not.toHaveBeenCalled();
	});

	it("still refuses the org kind carrying an id with the id-specific message", async () => {
		const res = await POST(
			req(grantBody({ resource_type: "org", resource_id: RESOURCE })),
		);
		expect(res.status).toBe(400);
		const body: unknown = await res.json();
		expect(JSON.stringify(body)).toContain("cannot carry a resource id");
		expect(mock.insertSpy).not.toHaveBeenCalled();
	});
});

describe("POST /api/cli/grants — every accepted resource_type still writes", () => {
	for (const kind of GRANT_RESOURCE_TYPES) {
		it(`accepts ${kind} and persists that kind`, async () => {
			const scoped = kind !== "org";
			const res = await POST(
				req(
					grantBody({
						resource_type: kind,
						...(scoped ? { resource_id: RESOURCE } : {}),
					}),
				),
			);
			expect(res.status).toBe(201);
			expect(mock.valuesSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					resource_type: kind,
					resource_id: scoped ? RESOURCE : null,
				}),
			);
		});
	}

	it("keeps the org default for a body that omits resource_type entirely", async () => {
		const res = await POST(req(grantBody({})));
		expect(res.status).toBe(201);
		expect(mock.valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({ resource_type: "org", resource_id: null }),
		);
	});
});
