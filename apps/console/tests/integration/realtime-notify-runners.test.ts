// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6123, ADR 0005 §10 R5/R6): what the `runners` and `fleet` change triggers in
// lib/db/programmables.sql actually NOTIFY, driven through the REAL runner RPCs against real Postgres.
// A mocked database cannot answer this: the property is a trigger's WHEN clause meeting plpgsql that
// SETs columns to the values they already hold.
//
// R5 IS THE POINT. A runner heartbeats every few seconds, and every console tab on the runners page
// would refetch on every heartbeat if one emitted a hint. So: a heartbeat, a presence ping and an
// empty claim emit ZERO; a credential rotation emits zero (it is never shown); a real change the UI
// shows — OFFLINE→ONLINE, a sweep to OFFLINE, a newly reported version — emits exactly one.
//
// DETERMINISM is the jobs test's (realtime-notify.test.ts): after each operation a sentinel NOTIFY is
// committed and awaited on the LISTEN connection, so everything heard before it is exactly what the
// operation emitted, and a zero is a real zero. Every zero has a control in this file that emits one.

import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { fleetPools, runners } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const USER = randomUUID(); // the self runner's owner; its personal org is USER
const TOKEN_HASH = createHash("sha256").update(randomUUID()).digest("hex");

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
let runnerId = "";
let managedId = "";
let poolId = "";

/** Waits until the sentinel `n` has been heard, then returns (and forgets) every runners/fleet notice before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.t === "runners" || x.t === "fleet");
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the runners/fleet notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

/** The runner RPCs, as the runner calls them. */
const rpc = {
	claim: () => db().execute<{ id: string }>(sql`select id from claim_next_job(${runnerId}::uuid, ${TOKEN_HASH}, NULL)`),
	heartbeat: (version: string | null = null) =>
		db().execute(sql`select runner_heartbeat(${runnerId}::uuid, ${TOKEN_HASH}, ${version}, NULL)`),
	present: () => db().execute(sql`select runner_present(${runnerId}::uuid)`),
	sweep: () => db().execute(sql`select * from sweep_offline_runners()`),
};

/** This runner's notice, as the trigger sends it: a personal runner, so org = owner = USER. */
const selfNotice = () => ({ t: "runners", id: runnerId, o: USER, u: USER, p: null });

describeIfDb("runners and fleet change triggers — what reaches alethia_change (#6123)", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		for (const id of [runnerId, managedId].filter(Boolean)) await db().delete(runners).where(eq(runners.id, id));
		if (poolId) await db().delete(fleetPools).where(eq(fleetPools.id, poolId));
	});

	it("registering a self runner emits one notice, routed by its personal org and owner", async () => {
		const notices = await emitted(async () => {
			const [r] = await db()
				.insert(runners)
				.values({
					user_id: USER,
					org_id: USER,
					name: `it-6123-${USER.slice(0, 8)}`,
					operator: "self",
					provisioning: "registered",
					status: "ONLINE",
					token_hash: TOKEN_HASH,
				})
				.returning({ id: runners.id });
			runnerId = r.id;
		});
		expect(notices).toEqual([selfNotice()]);
	});

	it("R5: a heartbeat, a presence ping and an empty claim on an ONLINE runner emit NOTHING", async () => {
		expect(await emitted(() => rpc.heartbeat())).toEqual([]);
		expect(await emitted(() => rpc.present())).toEqual([]);
		expect(await emitted(async () => expect(await rpc.claim()).toHaveLength(0))).toEqual([]);
		// They really wrote: the heartbeat column moved — it is just not a column anyone is told about.
		const [row] = await db().select({ at: runners.last_heartbeat }).from(runners).where(eq(runners.id, runnerId));
		expect(Date.now() - (row.at?.getTime() ?? 0)).toBeLessThan(60_000);
	});

	it("rotating the credential emits nothing (never rendered); a rename — the control — emits one", async () => {
		const rotated = createHash("sha256").update(randomUUID()).digest("hex");
		expect(await emitted(() => db().update(runners).set({ token_hash: rotated }).where(eq(runners.id, runnerId)))).toEqual([]);
		await db().update(runners).set({ token_hash: TOKEN_HASH }).where(eq(runners.id, runnerId));
		expect(
			await emitted(() => db().update(runners).set({ name: `it-6123-r-${USER.slice(0, 6)}` }).where(eq(runners.id, runnerId))),
		).toEqual([selfNotice()]);
	});

	it("a heartbeat that reports a NEW version emits exactly one", async () => {
		expect(await emitted(() => rpc.heartbeat("9.9.9-it-6123"))).toEqual([selfNotice()]);
		// The same version again is not a change.
		expect(await emitted(() => rpc.heartbeat("9.9.9-it-6123"))).toEqual([]);
	});

	it("going OFFLINE (the sweep) and coming back ONLINE (the next heartbeat) each emit one", async () => {
		await db()
			.update(runners)
			.set({ last_heartbeat: sql`now() - interval '10 minutes'` })
			.where(eq(runners.id, runnerId));
		const swept = await emitted(() => rpc.sweep());
		expect(swept.filter((n) => n.id === runnerId)).toEqual([selfNotice()]);
		expect(await emitted(() => rpc.heartbeat())).toEqual([selfNotice()]);
	});

	it("a managed runner has no org and no owner — the routing's platform population", async () => {
		const notices = await emitted(async () => {
			const [m] = await db()
				.insert(runners)
				.values({ name: `it-6123-m-${USER.slice(0, 8)}`, operator: "managed", status: "OFFLINE", token_hash: TOKEN_HASH })
				.returning({ id: runners.id });
			managedId = m.id;
		});
		expect(notices).toEqual([{ t: "runners", id: managedId, o: null, u: null, p: null }]);
	});

	it("removing a runner emits one notice from the OLD row", async () => {
		const id = managedId;
		expect(await emitted(() => db().delete(runners).where(eq(runners.id, id)))).toEqual([
			{ t: "runners", id, o: null, u: null, p: null },
		]);
		managedId = "";
	});

	it("a pool's configuration emits a fleet notice; its updated_at alone does not", async () => {
		// `deleting: true` keeps the row out of the one-live-pool-per-provider index, whatever pools
		// another suite left behind; the trigger fires on every insert regardless.
		const created = await emitted(async () => {
			const [p] = await db()
				.insert(fleetPools)
				.values({ provider: "aws", name: `it-6123-${USER.slice(0, 6)}`, deleting: true })
				.returning({ id: fleetPools.id });
			poolId = p.id;
		});
		expect(created).toEqual([{ t: "fleet", id: poolId, o: null, u: null, p: null }]);
		expect(await emitted(() => db().update(fleetPools).set({ updated_at: new Date() }).where(eq(fleetPools.id, poolId)))).toEqual([]);
		expect(await emitted(() => db().update(fleetPools).set({ warm_min: 3 }).where(eq(fleetPools.id, poolId)))).toEqual([
			{ t: "fleet", id: poolId, o: null, u: null, p: null },
		]);
	});
});
