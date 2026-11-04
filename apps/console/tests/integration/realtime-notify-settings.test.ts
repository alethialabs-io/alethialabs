// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6128): what the `organization` and `projects` change triggers in
// lib/db/programmables.sql actually NOTIFY, against real Postgres. The property is each trigger's
// WHEN clause: a write of a column the console renders emits exactly one notice; a write of one it
// does not (updatedAt, iac_version) and a write that changes nothing emit none.
//
// DETERMINISM, as in realtime-notify.test.ts: after each operation the test commits a sentinel
// NOTIFY of its own and waits for it on a dedicated LISTEN connection; everything heard before the
// sentinel is exactly what the operation emitted. So a ZERO below is a real zero, and every zero
// case sits beside a control that emits one.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { organization, projects } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const USER = randomUUID();
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
const createdProjects: string[] = [];

/** Waits for sentinel `n`, then returns (and forgets) the settings notices heard before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			// Only THIS suite's rows: other suites may write organizations and projects concurrently.
			return before.filter(
				(x) => (x.t === "organization" || x.t === "projects") && (x.o === ORG || x.o === USER),
			);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the settings notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

/** A project in `orgId`, created by USER. Returns its id. */
async function insertProject(orgId: string, name: string): Promise<string> {
	const [row] = await db()
		.insert(projects)
		.values({
			user_id: USER,
			org_id: orgId,
			project_name: name,
			slug: name,
			region: "eu-central-1",
			iac_version: "1.9.5",
		})
		.returning({ id: projects.id });
	createdProjects.push(row.id);
	return row.id;
}

describeIfDb("general-settings change triggers — what reaches alethia_change (#6128)", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
		await db()
			.insert(organization)
			.values({ id: ORG, name: `it-6128-${ORG.slice(0, 8)}`, slug: `it-6128-${ORG.slice(0, 8)}` });
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		for (const id of createdProjects) await db().delete(projects).where(eq(projects.id, id));
		await db().delete(organization).where(eq(organization.id, ORG));
	});

	it("a rename of the org emits one notice, carrying the org's id and nothing else", async () => {
		const notices = await emitted(() =>
			db().update(organization).set({ name: "Renamed" }).where(eq(organization.id, ORG)),
		);
		expect(notices).toEqual([{ t: "organization", id: ORG, o: ORG, u: null, p: null }]);
	});

	it("each column the console renders emits: slug, logo, metadata", async () => {
		for (const set of [
			{ slug: `it-6128-b-${ORG.slice(0, 8)}` },
			{ logo: "https://cdn.example.test/logo.png" },
			{ metadata: JSON.stringify({ description: "Platform team" }) },
		]) {
			expect(
				await emitted(() => db().update(organization).set(set).where(eq(organization.id, ORG))),
			).toHaveLength(1);
		}
	});

	it("an unrendered column (updatedAt) and a no-op write emit nothing", async () => {
		expect(
			await emitted(() =>
				db().update(organization).set({ updatedAt: new Date() }).where(eq(organization.id, ORG)),
			),
		).toEqual([]);
		expect(
			await emitted(() =>
				db().update(organization).set({ name: "Renamed" }).where(eq(organization.id, ORG)),
			),
		).toEqual([]);
		// The control: a real change, through the same statement shape, emits one.
		expect(
			await emitted(() =>
				db().update(organization).set({ name: "Renamed again" }).where(eq(organization.id, ORG)),
			),
		).toHaveLength(1);
	});

	it("a project's create, rename and delete each emit one notice, filtered on the project itself", async () => {
		let id = "";
		const created = await emitted(async () => {
			id = await insertProject(ORG, `it-6128-${randomUUID().slice(0, 8)}`);
		});
		expect(created).toEqual([{ t: "projects", id, o: ORG, u: USER, p: id }]);

		expect(
			await emitted(() => db().update(projects).set({ project_name: "Shop" }).where(eq(projects.id, id))),
		).toEqual([{ t: "projects", id, o: ORG, u: USER, p: id }]);

		expect(await emitted(() => db().delete(projects).where(eq(projects.id, id)))).toEqual([
			{ t: "projects", id, o: ORG, u: USER, p: id },
		]);
	});

	it("a project write of an unrendered column (iac_version, updated_at) emits nothing", async () => {
		const id = await insertProject(ORG, `it-6128-${randomUUID().slice(0, 8)}`);
		await emitted(async () => {}); // drain the insert's notice
		expect(
			await emitted(() => db().update(projects).set({ iac_version: "1.10.0" }).where(eq(projects.id, id))),
		).toEqual([]);
		expect(
			await emitted(() => db().update(projects).set({ updated_at: new Date() }).where(eq(projects.id, id))),
		).toEqual([]);
		// The control.
		expect(
			await emitted(() => db().update(projects).set({ region: "eu-west-1" }).where(eq(projects.id, id))),
		).toHaveLength(1);
	});

	it("a personal-scope project carries its owner as its org (the personal stream's key)", async () => {
		let id = "";
		const notices = await emitted(async () => {
			id = await insertProject(USER, `it-6128-${randomUUID().slice(0, 8)}`);
		});
		expect(notices).toEqual([{ t: "projects", id, o: USER, u: USER, p: id }]);
	});
});
