// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6119): what the board's change triggers in lib/db/programmables.sql actually NOTIFY —
// the `environments` topic (project_environments, the component family) and the `addons` topic
// (project_addons) — against real Postgres. A mocked database cannot answer this: the property is a
// trigger's WHEN clause meeting real UPDATEs, and a per-table column list DERIVED at migrate time.
//
// DETERMINISM, as in realtime-notify.test.ts: after each operation the test commits a sentinel NOTIFY
// and waits for it on a dedicated LISTEN connection; everything before the sentinel is exactly what
// the operation emitted. So a ZERO below is a real zero, and every zero has a control that emits one.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	organization,
	projectAddons,
	projectDatabases,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const USER = randomUUID(); // the project's (and the environment's) author
const ORG = randomUUID();

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
let projectId = "";
let envId = "";

/** Waits until the sentinel `n` has been heard, then returns (and forgets) every board notice before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.t === "environments" || x.t === "addons");
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the board notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

describeIfDb("the board's change triggers (#6119) — what reaches alethia_change", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));

		await db().insert(organization).values({ id: ORG, name: `it-6119-${ORG.slice(0, 8)}` });
		const [p] = await db()
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG,
				project_name: `it-6119-${ORG.slice(0, 8)}`,
				region: "eu-central-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
		const [e] = await db()
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: USER, org_id: ORG, name: "prod", status: "DRAFT", is_default: true })
			.returning({ id: projectEnvironments.id });
		envId = e.id;
		// Drain the setup's own notices (the environment insert), so each case hears only itself.
		await emitted(async () => {});
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		if (projectId) await db().delete(projects).where(eq(projects.id, projectId)); // cascades
		await db().delete(organization).where(eq(organization.id, ORG));
	});

	it("an environment's lifecycle change emits one `environments` notice, routed by its org and project", async () => {
		const notices = await emitted(() =>
			db().update(projectEnvironments).set({ status: "PROVISIONING" }).where(eq(projectEnvironments.id, envId)),
		);
		expect(notices).toEqual([{ t: "environments", id: envId, o: ORG, u: USER, p: projectId }]);
	});

	it("an environment write the board does not show (updated_at, the reap/heal counters) emits nothing", async () => {
		expect(
			await emitted(() =>
				db()
					.update(projectEnvironments)
					.set({ updated_at: new Date(), reap_attempts: 3, auto_heal_failures: 2 })
					.where(eq(projectEnvironments.id, envId)),
			),
		).toEqual([]);
	});

	it("a component row is an `environments` notice on insert and on a status change — and silent otherwise", async () => {
		let dbId = "";
		const inserted = await emitted(async () => {
			const [row] = await db()
				.insert(projectDatabases)
				.values({ project_id: projectId, environment_id: envId, name: "orders" })
				.returning({ id: projectDatabases.id });
			dbId = row.id;
		});
		// The component family has no user_id: the org arm is its only route.
		expect(inserted).toEqual([{ t: "environments", id: dbId, o: ORG, u: null, p: projectId }]);

		expect(
			await emitted(() =>
				db().update(projectDatabases).set({ status: "ACTIVE" }).where(eq(projectDatabases.id, dbId)),
			),
		).toEqual([{ t: "environments", id: dbId, o: ORG, u: null, p: projectId }]);

		// A design edit to a column that is not a lifecycle: the board's status does not move.
		expect(
			await emitted(() =>
				db().update(projectDatabases).set({ port: 5433 }).where(eq(projectDatabases.id, dbId)),
			),
		).toEqual([]);
	});

	it("an add-on is an `addons` notice — never an `environments` one — on install and on a health flip", async () => {
		let addonRow = "";
		const installed = await emitted(async () => {
			const [row] = await db()
				.insert(projectAddons)
				.values({ project_id: projectId, environment_id: envId, addon_id: "grafana" })
				.returning({ id: projectAddons.id });
			addonRow = row.id;
		});
		expect(installed).toEqual([{ t: "addons", id: addonRow, o: ORG, u: null, p: projectId }]);

		expect(
			await emitted(() =>
				db().update(projectAddons).set({ health: "Healthy" }).where(eq(projectAddons.id, addonRow)),
			),
		).toEqual([{ t: "addons", id: addonRow, o: ORG, u: null, p: projectId }]);

		// The reconcile loop stamps last_synced_at on every pass, change or not: silent.
		expect(
			await emitted(() =>
				db().update(projectAddons).set({ last_synced_at: new Date() }).where(eq(projectAddons.id, addonRow)),
			),
		).toEqual([]);
	});
});
