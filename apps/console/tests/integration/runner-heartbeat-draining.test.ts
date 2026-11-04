// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6233): a heartbeat never moves a runner out of DRAINING. runner_present and
// claim_next_job already preserved DRAINING; runner_heartbeat wrote ONLINE unconditionally, so a
// draining runner flapped DRAINING → ONLINE → DRAINING, and since the `runners` change trigger
// (#6123) reports a status change, every flap reached the bus as a live-update hint.
//
// Driven through the REAL runner_heartbeat against real Postgres, with the `alethia_change`
// LISTEN discipline of realtime-notify-runners.test.ts: after each operation a sentinel NOTIFY is
// committed and awaited, so everything heard before it is exactly what the operation emitted and a
// zero is a real zero. The zero has a control in this file: a heartbeat on the same DRAINING runner
// that reports a new version emits exactly one, so the listener demonstrably hears this runner.
//
// Only the drain COMPLETING moves the runner on — the sweep takes it OFFLINE — and after that a
// heartbeat brings it back ONLINE as before.

import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
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

/** Waits until the sentinel `n` has been heard, then returns (and forgets) every `runners` notice before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.t === "runners" && x.id === runnerId);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the notices it emitted for this suite's runner. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

/** runner_heartbeat, as the heartbeat route calls it. */
const heartbeat = (version: string | null = null) =>
	db().execute(sql`select runner_heartbeat(${runnerId}::uuid, ${TOKEN_HASH}, ${version}, NULL)`);

/** The seeded runner's status and last heartbeat. */
async function current(): Promise<{ status: string | null; at: Date | null }> {
	const [row] = await db()
		.select({ status: runners.status, at: runners.last_heartbeat })
		.from(runners)
		.where(eq(runners.id, runnerId));
	return row;
}

/** This runner's notice, as the trigger sends it: a personal runner, so org = owner = USER. */
const selfNotice = () => ({ t: "runners", id: runnerId, o: USER, u: USER, p: null });

describeIfDb("runner_heartbeat on a DRAINING runner (#6233)", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
		// Seeded inside emitted() so the registration's own notice is drained here and cannot be
		// mistaken for one the first heartbeat emitted.
		await emitted(async () => {
			const [r] = await db()
				.insert(runners)
				.values({
					user_id: USER,
					org_id: USER,
					name: `it-6233-${USER.slice(0, 8)}`,
					operator: "self",
					provisioning: "registered",
					status: "DRAINING",
					token_hash: TOKEN_HASH,
					last_heartbeat: sql`now() - interval '20 seconds'`,
				})
				.returning({ id: runners.id });
			runnerId = r.id;
		});
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		if (runnerId) await db().delete(runners).where(eq(runners.id, runnerId));
	});

	it("a heartbeat leaves a DRAINING runner DRAINING, refreshes its lease, and emits no hint", async () => {
		const before = await current();
		expect(before.status).toBe("DRAINING");
		expect(await emitted(() => heartbeat())).toEqual([]);
		expect(await emitted(() => heartbeat())).toEqual([]);
		const after = await current();
		expect(after.status).toBe("DRAINING");
		// It really wrote: the lease moved forward — only the status was left alone.
		expect(after.at?.getTime() ?? 0).toBeGreaterThan(before.at?.getTime() ?? 0);
	});

	it("control: a heartbeat reporting a NEW version emits exactly one, and the runner is still DRAINING", async () => {
		expect(await emitted(() => heartbeat("9.9.9-it-6233"))).toEqual([selfNotice()]);
		expect((await current()).status).toBe("DRAINING");
	});

	it("once the drain completes (swept OFFLINE), the next heartbeat brings the runner ONLINE", async () => {
		await db()
			.update(runners)
			.set({ last_heartbeat: sql`now() - interval '10 minutes'` })
			.where(eq(runners.id, runnerId));
		expect(await emitted(() => db().execute(sql`select * from sweep_offline_runners()`))).toEqual([selfNotice()]);
		expect((await current()).status).toBe("OFFLINE");
		expect(await emitted(() => heartbeat())).toEqual([selfNotice()]);
		expect((await current()).status).toBe("ONLINE");
	});
});
