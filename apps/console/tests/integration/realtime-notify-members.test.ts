// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6129, ADR 0005 D3): what the people & access change triggers in
// lib/db/programmables.sql actually NOTIFY on `alethia_change`, against real Postgres — and, through
// the pure routing rule, who that notice reaches.
//
// DETERMINISM — the sentinel discipline of realtime-notify-support.test.ts: after each operation the
// test commits a sentinel NOTIFY and waits for it on a dedicated LISTEN connection, so what arrived
// before the sentinel is exactly what the operation emitted. Notices are attributed by their ORG (a
// fresh uuid per run), never by arrival alone, because the channel is database-wide. Every zero
// below has a control in this file that emits one.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { getServiceDb } from "@/lib/db";
import {
	grants,
	invitation,
	member,
	organization,
	role,
	rolePermission,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import { type ChangeNotice, keysFor, subscriptionKeys } from "@/lib/realtime/routing";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const OWNER = randomUUID();
const MATE = randomUUID();
const USERS = [OWNER, MATE];

interface Notice {
	t: string;
	id: string | null;
	o: string | null;
	u: string | null;
	p: string | null;
	n?: string;
}

const db = () => getServiceDb();
let listener: ReturnType<typeof postgres>;
const heard: Notice[] = [];

/** Waits for sentinel `n`, then returns (and forgets) every members/access notice about ORG before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => (x.t === "members" || x.t === "access") && x.o === ORG);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the members/access notices it emitted for ORG. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

/** Whether a stream of `orgId`, with or without `member:view`, would receive `notice`. */
function hears(notice: Notice, orgId: string, memberView: boolean): boolean {
	if (notice.t !== "members" && notice.t !== "access") return false;
	const change: ChangeNotice = { kind: "change", t: notice.t, id: notice.id, o: notice.o, u: notice.u, p: notice.p };
	const held = subscriptionKeys({ userId: MATE, orgId }, { fleetView: false, manageSupport: false, viewAlerts: false, memberView });
	return keysFor(change).some((route) => held.includes(route.key));
}

describeIfDb("people & access change triggers — what reaches alethia_change (#6129)", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
		await db().insert(user).values(USERS.map((id) => ({ id, email: `it-6129-${id}@example.test` })));
		await db().insert(organization).values({ id: ORG, name: `it-6129-${ORG.slice(0, 8)}` });
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		await db().delete(grants).where(eq(grants.org_id, ORG));
		await db().delete(role).where(eq(role.organization_id, ORG));
		await db().delete(team).where(eq(team.organizationId, ORG));
		await db().delete(invitation).where(eq(invitation.organizationId, ORG));
		await db().delete(member).where(eq(member.organizationId, ORG));
		await db().delete(organization).where(eq(organization.id, ORG));
		await db().delete(user).where(inArray(user.id, USERS));
	});

	it("a member joining emits one `members` notice — identifiers only — heard by the org and no other org", async () => {
		let id = "";
		const notices = await emitted(async () => {
			const [row] = await db()
				.insert(member)
				.values({ organizationId: ORG, userId: MATE, role: "viewer" })
				.returning({ id: member.id });
			id = row.id;
		});
		expect(notices).toEqual([{ t: "members", id, o: ORG, u: null, p: null }]);
		expect(hears(notices[0], ORG, false), "a member without member:view still reads the member list").toBe(true);
		expect(hears(notices[0], OTHER_ORG, true), "a stream on another org").toBe(false);
	});

	it("a role change and a suspension each emit one notice; a write that changes no shown column emits none", async () => {
		const where = and(eq(member.organizationId, ORG), eq(member.userId, MATE));
		expect(await emitted(() => db().update(member).set({ role: "admin" }).where(where))).toHaveLength(1);
		expect(await emitted(() => db().update(member).set({ status: "suspended" }).where(where))).toHaveLength(1);
		expect(await emitted(() => db().update(member).set({ status: "suspended" }).where(where))).toEqual([]);
	});

	it("an invitation emits on insert and on cancel, never on an expiry bump", async () => {
		let id = "";
		const inserted = await emitted(async () => {
			const [row] = await db()
				.insert(invitation)
				.values({ organizationId: ORG, email: "new@example.test", role: "viewer", inviterId: OWNER, expiresAt: new Date(Date.now() + 86_400_000) })
				.returning({ id: invitation.id });
			id = row.id;
		});
		expect(inserted).toEqual([{ t: "members", id, o: ORG, u: null, p: null }]);
		expect(
			await emitted(() => db().update(invitation).set({ expiresAt: new Date(Date.now() + 172_800_000) }).where(eq(invitation.id, id))),
		).toEqual([]);
		expect(await emitted(() => db().update(invitation).set({ status: "canceled" }).where(eq(invitation.id, id)))).toHaveLength(1);
	});

	it("a team and its roster emit `members` notices naming the TEAM, in the team's org", async () => {
		let teamId = "";
		const created = await emitted(async () => {
			const [row] = await db().insert(team).values({ name: "it-6129", organizationId: ORG }).returning({ id: team.id });
			teamId = row.id;
		});
		expect(created).toEqual([{ t: "members", id: teamId, o: ORG, u: null, p: null }]);
		expect(await emitted(() => db().insert(teamMember).values({ teamId, userId: MATE }))).toEqual([
			{ t: "members", id: teamId, o: ORG, u: null, p: null },
		]);
		expect(await emitted(() => db().update(team).set({ updatedAt: new Date() }).where(eq(team.id, teamId)))).toEqual([]);
		expect(await emitted(() => db().update(team).set({ name: "it-6129 renamed" }).where(eq(team.id, teamId)))).toHaveLength(1);
	});

	it("a grant emits one `access` notice, which only a member:view holder of the org hears", async () => {
		let id = "";
		const notices = await emitted(async () => {
			const [row] = await db()
				.insert(grants)
				.values({ org_id: ORG, principal_type: "user", principal_id: MATE, effect: "allow", role_id: BUILTIN_ROLE_IDS.viewer, resource_type: "org" })
				.returning({ id: grants.id });
			id = row.id;
		});
		expect(notices).toEqual([{ t: "access", id, o: ORG, u: null, p: null }]);
		expect(hears(notices[0], ORG, true), "a member:view holder").toBe(true);
		expect(hears(notices[0], ORG, false), "an operator — no member:view").toBe(false);
	});

	it("a custom role and its permissions emit `access` notices naming the ROLE", async () => {
		let roleId = "";
		const created = await emitted(async () => {
			const [row] = await db()
				.insert(role)
				.values({ organization_id: ORG, name: "it-6129-role", is_builtin: false })
				.returning({ id: role.id });
			roleId = row.id;
		});
		expect(created).toEqual([{ t: "access", id: roleId, o: ORG, u: null, p: null }]);
		expect(await emitted(() => db().insert(rolePermission).values({ role_id: roleId, permission_key: "org:view" }))).toEqual([
			{ t: "access", id: roleId, o: ORG, u: null, p: null },
		]);
	});
});
