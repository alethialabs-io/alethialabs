// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6129, ADR 0005 D3): what the SSO, classification and Activity-log change triggers in
// lib/db/programmables.sql actually NOTIFY on `alethia_change`, against real Postgres — and, through
// the pure routing rule, who each notice reaches.
//
// DETERMINISM — the sentinel discipline of realtime-notify-members.test.ts: after each operation the
// test commits a sentinel NOTIFY and waits for it on a dedicated LISTEN connection, so what arrived
// before the sentinel is exactly what the operation emitted. Notices are attributed by their ORG (a
// fresh uuid per run), never by arrival alone, because the channel is database-wide. Every zero
// below has a control in this file that emits one.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	authzActivityLog,
	classificationAssignment,
	classificationDimension,
	classificationValue,
	organization,
	ssoProvider,
	user,
} from "@/lib/db/schema";
import { type ChangeNotice, keysFor, subscriptionKeys } from "@/lib/realtime/routing";
import { isTopic } from "@/lib/realtime/topics";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const OWNER = randomUUID();
const RESOURCE = randomUUID();

interface Notice {
	t: string;
	id: string | null;
	o: string | null;
	u: string | null;
	p: string | null;
	n?: string;
}

/** The topics this file's triggers emit on. */
const TOPICS = new Set(["access", "classification", "activity"]);

const db = () => getServiceDb();
let listener: ReturnType<typeof postgres>;
const heard: Notice[] = [];

/** Waits for sentinel `n`, then returns (and forgets) every notice of this file's topics about ORG before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => TOPICS.has(x.t) && x.o === ORG);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the notices it emitted for ORG. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

/** Whether a stream of `orgId`, with the given capabilities, would receive `notice`. */
function hears(notice: Notice, orgId: string, caps: { memberView: boolean; viewActivity: boolean }): boolean {
	if (!isTopic(notice.t)) return false;
	const change: ChangeNotice = { kind: "change", t: notice.t, id: notice.id, o: notice.o, u: notice.u, p: notice.p };
	const held = subscriptionKeys(
		{ userId: OWNER, orgId },
		{ platformView: false, manageSupport: false, viewAlerts: false, ...caps },
	);
	return keysFor(change).some((route) => held.includes(route.key));
}

const NONE = { memberView: false, viewActivity: false };

describeIfDb("settings change triggers — SSO, classification and the Activity log (#6129)", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
		await db().insert(user).values({ id: OWNER, email: `it-6129-settings-${OWNER}@example.test` });
		await db().insert(organization).values({ id: ORG, name: `it-6129-s-${ORG.slice(0, 8)}` });
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		await db().delete(classificationDimension).where(eq(classificationDimension.org_id, ORG));
		await db().delete(ssoProvider).where(eq(ssoProvider.organizationId, ORG));
		await purgeAuthzActivityLog(eq(authzActivityLog.org_id, ORG));
		await db().delete(organization).where(eq(organization.id, ORG));
		await db().delete(user).where(inArray(user.id, [OWNER]));
	});

	it("an SSO provider emits `access` notices — on register, on verify, on remove — heard only by member:view holders of the org", async () => {
		let id = "";
		const registered = await emitted(async () => {
			const [row] = await db()
				.insert(ssoProvider)
				.values({
					issuer: "https://idp.example.test",
					domain: "it-6129.example.test",
					providerId: `it-6129-${ORG.slice(0, 8)}`,
					oidcConfig: JSON.stringify({ clientId: "c" }),
					userId: OWNER,
					organizationId: ORG,
				})
				.returning({ id: ssoProvider.id });
			id = row.id;
		});
		expect(registered).toEqual([{ t: "access", id, o: ORG, u: null, p: null }]);
		expect(hears(registered[0], ORG, { memberView: true, viewActivity: false }), "a member:view holder").toBe(true);
		expect(hears(registered[0], ORG, NONE), "a member without member:view").toBe(false);
		expect(hears(registered[0], OTHER_ORG, { memberView: true, viewActivity: true }), "another org").toBe(false);

		expect(
			await emitted(() => db().update(ssoProvider).set({ domainVerified: true }).where(eq(ssoProvider.id, id))),
		).toEqual([{ t: "access", id, o: ORG, u: null, p: null }]);
		// Writing the same value changes nothing the page shows.
		expect(await emitted(() => db().update(ssoProvider).set({ domainVerified: true }).where(eq(ssoProvider.id, id)))).toEqual([]);
		expect(await emitted(() => db().delete(ssoProvider).where(eq(ssoProvider.id, id)))).toEqual([
			{ t: "access", id, o: ORG, u: null, p: null },
		]);
	});

	it("the taxonomy emits `classification` notices naming the DIMENSION, heard by every member of the org", async () => {
		let dimensionId = "";
		const created = await emitted(async () => {
			const [row] = await db()
				.insert(classificationDimension)
				.values({ org_id: ORG, created_by: OWNER, key: "it-6129", label: "It 6129" })
				.returning({ id: classificationDimension.id });
			dimensionId = row.id;
		});
		expect(created).toEqual([{ t: "classification", id: dimensionId, o: ORG, u: null, p: null }]);
		expect(hears(created[0], ORG, NONE), "any member reads the taxonomy").toBe(true);
		expect(hears(created[0], OTHER_ORG, { memberView: true, viewActivity: true }), "another org").toBe(false);

		let valueId = "";
		const value = await emitted(async () => {
			const [row] = await db()
				.insert(classificationValue)
				.values({ org_id: ORG, dimension_id: dimensionId, value: "prod", label: "Production" })
				.returning({ id: classificationValue.id });
			valueId = row.id;
		});
		expect(value).toEqual([{ t: "classification", id: dimensionId, o: ORG, u: null, p: null }]);

		// An assignment's notice names its dimension — never the resource it pins.
		const pinned = await emitted(() =>
			db().insert(classificationAssignment).values({
				org_id: ORG,
				dimension_id: dimensionId,
				value_id: valueId,
				resource_kind: "project",
				resource_id: RESOURCE,
				assigned_by: OWNER,
			}),
		);
		expect(pinned).toEqual([{ t: "classification", id: dimensionId, o: ORG, u: null, p: null }]);
		expect(JSON.stringify(pinned)).not.toContain(RESOURCE);

		// A write that changes no rendered column emits nothing; a relabel does.
		expect(
			await emitted(() => db().update(classificationValue).set({ label: "Production" }).where(eq(classificationValue.id, valueId))),
		).toEqual([]);
		expect(
			await emitted(() => db().update(classificationValue).set({ label: "Prod" }).where(eq(classificationValue.id, valueId))),
		).toEqual([{ t: "classification", id: dimensionId, o: ORG, u: null, p: null }]);
		expect(
			await emitted(() =>
				db().update(classificationDimension).set({ label: "It 6129" }).where(eq(classificationDimension.id, dimensionId)),
			),
		).toEqual([]);
	});

	it("a recorded Activity-log entry emits one `activity` notice with no row id, heard only by view_activity holders", async () => {
		const notices = await emitted(() =>
			db().insert(authzActivityLog).values({
				org_id: ORG,
				actor_id: OWNER,
				action: "edit",
				resource_type: "project",
				resource_id: RESOURCE,
				decision: true,
			}),
		);
		expect(notices).toEqual([{ t: "activity", id: null, o: ORG, u: null, p: null }]);
		expect(hears(notices[0], ORG, { memberView: false, viewActivity: true }), "a view_activity holder").toBe(true);
		expect(hears(notices[0], ORG, { memberView: true, viewActivity: false }), "a member without view_activity").toBe(false);
		expect(hears(notices[0], OTHER_ORG, { memberView: true, viewActivity: true }), "another org").toBe(false);
	});
});
