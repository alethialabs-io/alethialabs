// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6122, ADR 0005 §10 R5): what the `clusters` change triggers in lib/db/programmables.sql
// actually NOTIFY, against real Postgres. A mocked database cannot answer this: the property is a
// trigger's WHEN clause meeting UPDATEs that SET columns to the values they already hold — which is
// what a deploy's writeback does on every successful run (lib/jobs/finalize-deployment.ts).
//
// DETERMINISM, as in realtime-notify.test.ts: after each operation the test commits a sentinel NOTIFY
// and waits for it on a dedicated LISTEN connection; everything before the sentinel is exactly what the
// operation emitted. So a ZERO below is a real zero, and every zero has a control that emits one.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { projectCluster, projectEnvironments, projects } from "@/lib/db/schema";
import { describeIfDb } from "./db";

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
let projectId: string;
let environmentId: string;

/** Waits until the sentinel `n` has been heard, then returns (and forgets) every clusters notice before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.t === "clusters");
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the clusters notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

describeIfDb("clusters change triggers — what reaches alethia_change", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
		const [p] = await db()
			.insert(projects)
			.values({ user_id: ORG, org_id: ORG, project_name: "it-6122-notify", region: "eu-west-1", iac_version: "1.0.0" })
			.returning({ id: projects.id });
		projectId = p.id;
		const [env] = await db()
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: ORG, name: "prod", status: "QUEUED", is_default: true })
			.returning({ id: projectEnvironments.id });
		environmentId = env.id;
	});

	afterAll(async () => {
		await db().delete(projects).where(eq(projects.id, projectId));
		await listener?.end({ timeout: 1 });
	});

	let clusterId = "";

	it("an insert emits one notice: the row's id, its org and its project — and no user", async () => {
		const out = await emitted(async () => {
			const [row] = await db()
				.insert(projectCluster)
				.values({ project_id: projectId, environment_id: environmentId })
				.returning({ id: projectCluster.id });
			clusterId = row.id;
		});
		expect(out).toEqual([{ t: "clusters", id: clusterId, o: ORG, u: null, p: projectId }]);
	});

	it("a deploy's writeback emits one notice when it changes what the card shows", async () => {
		const out = await emitted(() =>
			db()
				.update(projectCluster)
				.set({ status: "ACTIVE", cluster_name: "eks-it", cluster_endpoint: "https://k8s.example.test" })
				.where(eq(projectCluster.id, clusterId)),
		);
		expect(out).toHaveLength(1);
	});

	it("the same writeback again — every value already held — emits nothing", async () => {
		const out = await emitted(() =>
			db()
				.update(projectCluster)
				.set({ status: "ACTIVE", cluster_name: "eks-it", cluster_endpoint: "https://k8s.example.test" })
				.where(eq(projectCluster.id, clusterId)),
		);
		expect(out).toEqual([]);
	});

	it("a column the card does not show (cost, updated_at) emits nothing", async () => {
		const out = await emitted(() =>
			db()
				.update(projectCluster)
				.set({ estimated_monthly_cost: 123, updated_at: new Date() })
				.where(eq(projectCluster.id, clusterId)),
		);
		expect(out).toEqual([]);
	});

	it("a delete emits one notice carrying the old row's ids", async () => {
		const out = await emitted(() => db().delete(projectCluster).where(eq(projectCluster.id, clusterId)));
		expect(out).toEqual([{ t: "clusters", id: clusterId, o: ORG, u: null, p: projectId }]);
	});
});
