// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6125, ADR 0005 D3): what the alert tables' change triggers in lib/db/programmables.sql
// actually NOTIFY on `alethia_change`, against real Postgres — and, through the pure routing rule,
// who that notice reaches.
//
// DETERMINISM — the sentinel discipline of realtime-notify.test.ts: after each operation the test
// commits a sentinel NOTIFY of its own and waits for it on a dedicated LISTEN connection, so what
// arrived before the sentinel is exactly what the operation emitted. Every ZERO below has a control
// in this file that emits one.
//
// The writes are the ones app/server/actions/alerts.ts and the delivery sweeper make: a policy save
// is ONE transaction that updates the rule and deletes-and-reinserts its bindings; a retry moves
// attempts / last_error / next_attempt_at; a send moves status / sent_at.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { alertChannels, alertDeliveries, alertRuleChannels, alertRules } from "@/lib/db/schema";
import { type ChangeNotice, keysFor, subscriptionKeys } from "@/lib/realtime/routing";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const AUTHOR = randomUUID();
const MEMBER = randomUUID();

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

/**
 * Waits until the sentinel `n` has been heard, then returns (and forgets) every alerts notice before
 * it ABOUT THIS FILE'S ORG. The channel is database-wide and other suites write alert rows too, so a
 * notice is attributed by its org, never by arrival alone.
 */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.t === "alerts" && x.o === ORG);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the alerts notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

/** The notice the triggers send for row `id` of the test org: identifiers only. */
const notice = (id: string): Notice => ({ t: "alerts", id, o: ORG, u: null, p: null });

/** Seeds a channel and a rule bound to it, consuming their insert notices. */
async function seeded(): Promise<{ channel: string; rule: string }> {
	let channel = "";
	let rule = "";
	await emitted(async () => {
		[{ id: channel }] = await db()
			.insert(alertChannels)
			.values({ org_id: ORG, type: "email", name: "it-6125", config: { recipients: ["a@example.test"] }, created_by: AUTHOR })
			.returning({ id: alertChannels.id });
		[{ id: rule }] = await db()
			.insert(alertRules)
			.values({ org_id: ORG, name: "it-6125", event_patterns: ["system.job.failed"], created_by: AUTHOR })
			.returning({ id: alertRules.id });
		await db().insert(alertRuleChannels).values({ rule_id: rule, channel_id: channel });
	});
	return { channel, rule };
}

/** Whether a change stream with this identity would receive `n` (the bus matches on these keys). */
function hears(n: Notice, userId: string, orgId: string, viewAlerts: boolean): boolean {
	const change: ChangeNotice = { kind: "change", t: "alerts", id: n.id, o: n.o, u: n.u, p: n.p };
	const held = subscriptionKeys({ userId, orgId }, { fleetView: true, manageSupport: true, viewAlerts });
	return keysFor(change).some((route) => held.includes(route.key));
}

describeIfDb("alert tables' change triggers — what reaches alethia_change (#6125)", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		await db().delete(alertDeliveries).where(inArray(alertDeliveries.org_id, [ORG, OTHER_ORG]));
		await db().delete(alertRules).where(inArray(alertRules.org_id, [ORG, OTHER_ORG]));
		await db().delete(alertChannels).where(inArray(alertChannels.org_id, [ORG, OTHER_ORG]));
	});

	it("a new rule, channel and binding each name their row; the binding names its RULE", async () => {
		let channel = "";
		let rule = "";
		const notices = await emitted(async () => {
			[{ id: channel }] = await db()
				.insert(alertChannels)
				.values({ org_id: ORG, type: "email", name: "it-6125 new", created_by: AUTHOR })
				.returning({ id: alertChannels.id });
		});
		expect(notices).toEqual([notice(channel)]);
		expect(
			await emitted(async () => {
				[{ id: rule }] = await db()
					.insert(alertRules)
					.values({ org_id: ORG, name: "it-6125 new", event_patterns: ["system.job.failed"], created_by: AUTHOR })
					.returning({ id: alertRules.id });
			}),
		).toEqual([notice(rule)]);
		expect(await emitted(() => db().insert(alertRuleChannels).values({ rule_id: rule, channel_id: channel }))).toEqual([
			notice(rule),
		]);
	});

	it("a policy save — rule update plus rebinding, in one transaction — is ONE notice", async () => {
		const { channel, rule } = await seeded();
		const notices = await emitted(() =>
			db().transaction(async (tx) => {
				await tx.update(alertRules).set({ name: "renamed", updated_at: new Date() }).where(eq(alertRules.id, rule));
				await tx.delete(alertRuleChannels).where(eq(alertRuleChannels.rule_id, rule));
				await tx.insert(alertRuleChannels).values({ rule_id: rule, channel_id: channel, min_severity: "critical" });
			}),
		);
		expect(notices).toEqual([notice(rule)]);
	});

	it("a save that only moves a channel's severity floor still notifies its rule", async () => {
		const { channel, rule } = await seeded();
		expect(
			await emitted(() =>
				db()
					.update(alertRuleChannels)
					.set({ min_severity: "warning" })
					.where(eq(alertRuleChannels.channel_id, channel)),
			),
		).toEqual([notice(rule)]);
	});

	it("bookkeeping writes emit NOTHING: a bare updated_at on a rule or a channel", async () => {
		const { channel, rule } = await seeded();
		expect(await emitted(() => db().update(alertRules).set({ updated_at: new Date() }).where(eq(alertRules.id, rule)))).toEqual(
			[],
		);
		expect(
			await emitted(() => db().update(alertChannels).set({ updated_at: new Date() }).where(eq(alertChannels.id, channel))),
		).toEqual([]);
		// Writing the value a column already holds changes nothing the console shows.
		expect(await emitted(() => db().update(alertRules).set({ enabled: true }).where(eq(alertRules.id, rule)))).toEqual([]);
	});

	it("a toggle and a verification emit one each (the controls for the zeros above)", async () => {
		const { channel, rule } = await seeded();
		expect(await emitted(() => db().update(alertRules).set({ enabled: false }).where(eq(alertRules.id, rule)))).toEqual([
			notice(rule),
		]);
		expect(
			await emitted(() =>
				db().update(alertChannels).set({ is_verified: true, last_verified_at: new Date() }).where(eq(alertChannels.id, channel)),
			),
		).toEqual([notice(channel)]);
	});

	it("deliveries: a new one, a retry and a send notify; the sweeper's own scheduling does not", async () => {
		let id = "";
		expect(
			await emitted(async () => {
				[{ id }] = await db()
					.insert(alertDeliveries)
					.values({ org_id: ORG, event_key: "authz.denied", context: { title: "it-6125" } })
					.returning({ id: alertDeliveries.id });
			}),
		).toEqual([notice(id)]);
		// Rescheduling alone (next_attempt_at) is invisible on the ledger.
		expect(
			await emitted(() =>
				db().update(alertDeliveries).set({ next_attempt_at: new Date(Date.now() + 60_000) }).where(eq(alertDeliveries.id, id)),
			),
		).toEqual([]);
		expect(
			await emitted(() =>
				db().update(alertDeliveries).set({ attempts: 1, last_error: "timeout" }).where(eq(alertDeliveries.id, id)),
			),
		).toEqual([notice(id)]);
		expect(
			await emitted(() =>
				db().update(alertDeliveries).set({ status: "sent", sent_at: new Date() }).where(eq(alertDeliveries.id, id)),
			),
		).toEqual([notice(id)]);
	});

	it("deleting a rule is one notice (its bindings' cascade finds no rule); deleting a channel notifies it AND its rules", async () => {
		const a = await seeded();
		expect(await emitted(() => db().delete(alertRules).where(eq(alertRules.id, a.rule)))).toEqual([notice(a.rule)]);

		const b = await seeded();
		const notices = await emitted(() => db().delete(alertChannels).where(eq(alertChannels.id, b.channel)));
		expect(notices).toEqual(expect.arrayContaining([notice(b.channel), notice(b.rule)]));
		expect(notices).toHaveLength(2);
	});

	it("a notice carries identifiers only, and reaches only members who may view alerts in its org", async () => {
		let id = "";
		const [n] = await emitted(async () => {
			[{ id }] = await db()
				.insert(alertDeliveries)
				.values({ org_id: ORG, event_key: "authz.denied", context: { title: "it-6125 secret title" } })
				.returning({ id: alertDeliveries.id });
		});
		expect(n).toEqual(notice(id));
		expect(JSON.stringify(n)).not.toContain("secret title");
		expect(hears(n, MEMBER, ORG, true), "a member with view_alerts").toBe(true);
		expect(hears(n, MEMBER, ORG, false), "a member without view_alerts").toBe(false);
		expect(hears(n, MEMBER, OTHER_ORG, true), "a member of another org").toBe(false);
	});
});
