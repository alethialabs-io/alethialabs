// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6124): what the credential triggers in lib/db/programmables.sql NOTIFY for
// cloud_identities and connector_credentials, against real Postgres, and where the routing sends it.
//
// Same determinism as realtime-notify.test.ts: after each operation a sentinel NOTIFY is committed
// and awaited, so every notice before it is exactly what the operation emitted and a ZERO is a real
// zero. Each zero below sits next to a control that emits.
//
// What is pinned:
//   · an ORG row emits `o` only, and routes to the org key;
//   · a PERSONAL row emits `u` (with its org), and routes to its author alone — never the org key;
//   · the health sweep's own columns (last_tested_at, cached_*, updated_at) and a re-probe that finds
//     the same health emit NOTHING;
//   · a share (personal → org) tells BOTH audiences: the author's board drops it, the org's gains it.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, connectorCredentials, connectors } from "@/lib/db/schema";
import { type ChangeNotice, keysFor } from "@/lib/realtime/routing";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const AUTHOR = randomUUID();

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
const identities: string[] = [];
const credentials: string[] = [];

/** Waits for the sentinel `n`, then returns (and forgets) every connectors notice before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.t === "connectors");
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the connectors notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

/** The routing keys of a heard notice. */
function routed(n: Notice): string[] {
	const notice: ChangeNotice = { kind: "change", t: "connectors", id: n.id, o: n.o, u: n.u, p: n.p };
	return keysFor(notice).map((r) => r.key);
}

/** Inserts a configured cloud identity; returns its id. */
async function insertIdentity(scope: "org" | "personal"): Promise<string> {
	const [row] = await db()
		.insert(cloudIdentities)
		.values({
			user_id: AUTHOR,
			org_id: ORG,
			scope,
			provider: "aws",
			name: `it-6124-${scope}`,
			credentials: { role_arn: "arn:aws:iam::123456789012:role/it-6124" },
			status: "connected",
			is_verified: true,
		})
		.returning({ id: cloudIdentities.id });
	identities.push(row.id);
	return row.id;
}

describeIfDb("connectors change triggers — what reaches alethia_change", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		for (const id of credentials) await db().delete(connectorCredentials).where(eq(connectorCredentials.id, id));
		for (const id of identities) await db().delete(cloudIdentities).where(eq(cloudIdentities.id, id));
	});

	it("an org identity emits the org arm only, and routes to the org", async () => {
		let id = "";
		const notices = await emitted(async () => {
			id = await insertIdentity("org");
		});
		expect(notices).toEqual([{ t: "connectors", id, o: ORG, u: null, p: null }]);
		expect(routed(notices[0])).toEqual([`o:${ORG}`]);
	});

	it("a personal identity reaches its author alone — never the org key", async () => {
		let id = "";
		const notices = await emitted(async () => {
			id = await insertIdentity("personal");
		});
		expect(notices).toEqual([{ t: "connectors", id, o: ORG, u: AUTHOR, p: null }]);
		expect(routed(notices[0])).toEqual([`ou:${ORG}:${AUTHOR}`]);
	});

	it("the health sweep's bookkeeping and a same-health re-probe emit nothing; a health change emits one", async () => {
		const id = await insertIdentity("org");
		await emitted(async () => {});
		const sweep = () =>
			db()
				.update(cloudIdentities)
				.set({ last_tested_at: new Date(), cached_at: new Date(), updated_at: new Date(), status: "connected" })
				.where(eq(cloudIdentities.id, id));
		expect(await emitted(sweep)).toEqual([]);
		// The control: the health actually moved.
		expect(
			await emitted(() =>
				db()
					.update(cloudIdentities)
					.set({ status: "degraded", missing_permissions: ["ec2:RunInstances"] })
					.where(eq(cloudIdentities.id, id)),
			),
		).toEqual([{ t: "connectors", id, o: ORG, u: null, p: null }]);
	});

	it("sharing a personal identity with the org tells both audiences", async () => {
		const id = await insertIdentity("personal");
		await emitted(async () => {});
		const notices = await emitted(() =>
			db().update(cloudIdentities).set({ scope: "org" }).where(eq(cloudIdentities.id, id)),
		);
		expect(notices).toEqual([
			{ t: "connectors", id, o: ORG, u: null, p: null },
			{ t: "connectors", id, o: ORG, u: AUTHOR, p: null },
		]);
	});

	it("an api_key credential: insert and a verdict change emit; a same-verdict re-save does not", async () => {
		const [catalog] = await db().select({ id: connectors.id }).from(connectors).limit(1);
		expect(catalog, "the connectors catalog is seeded by migrate").toBeDefined();
		let id = "";
		const inserted = await emitted(async () => {
			const [row] = await db()
				.insert(connectorCredentials)
				.values({
					user_id: AUTHOR,
					org_id: ORG,
					connector_id: catalog.id,
					scope: "org",
					credentials: { fields: {}, secret: null },
					is_verified: true,
				})
				.returning({ id: connectorCredentials.id });
			id = row.id;
			credentials.push(id);
		});
		expect(inserted).toEqual([{ t: "connectors", id, o: ORG, u: null, p: null }]);
		expect(
			await emitted(() =>
				db()
					.update(connectorCredentials)
					.set({ credentials: { fields: { rotated: "yes" }, secret: null }, updated_at: new Date() })
					.where(eq(connectorCredentials.id, id)),
			),
		).toEqual([]);
		expect(
			await emitted(() =>
				db().update(connectorCredentials).set({ is_verified: false }).where(eq(connectorCredentials.id, id)),
			),
		).toHaveLength(1);
	});
});
