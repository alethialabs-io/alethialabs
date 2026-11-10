// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6120): what the Environments page's change triggers in lib/db/programmables.sql
// actually NOTIFY — environment_promotions, promotion_approvals and environment_protection_rules, all
// on the `environments` topic — against real Postgres. A mocked database cannot answer this: the
// property is a trigger's WHEN clause meeting real UPDATEs, and an org resolved from the project when
// the row carries none.
//
// DETERMINISM, as in realtime-notify-board.test.ts: after each operation the test commits a sentinel
// NOTIFY and waits for it on a dedicated LISTEN connection; everything before the sentinel is exactly
// what the operation emitted. So a ZERO below is a real zero, and every zero has a control that emits.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	environmentPromotions,
	environmentProtectionRules,
	organization,
	projectEnvironments,
	projects,
	promotionApprovals,
} from "@/lib/db/schema";
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
let projectId = "";
let devId = "";
let prodId = "";
let promotionId = "";

/** Waits until the sentinel `n` has been heard, then returns (and forgets) every `environments` notice before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.t === "environments");
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the `environments` notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

describeIfDb("the Environments page's change triggers (#6120) — what reaches alethia_change", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));

		await db().insert(organization).values({ id: ORG, name: `it-6120-${ORG.slice(0, 8)}` });
		const [p] = await db()
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG,
				project_name: `it-6120-${ORG.slice(0, 8)}`,
				region: "eu-central-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
		const envs = await db()
			.insert(projectEnvironments)
			.values([
				{ project_id: projectId, user_id: USER, org_id: ORG, name: "dev", stage: "development", status: "DRAFT", is_default: true },
				{ project_id: projectId, user_id: USER, org_id: ORG, name: "prod", stage: "production", status: "DRAFT", is_default: false },
			])
			.returning({ id: projectEnvironments.id, name: projectEnvironments.name });
		devId = envs.find((e) => e.name === "dev")?.id ?? "";
		prodId = envs.find((e) => e.name === "prod")?.id ?? "";
		// Drain the setup's own notices (the environment inserts), so each case hears only itself.
		await emitted(async () => {});
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		if (projectId) await db().delete(projects).where(eq(projects.id, projectId)); // cascades
		await db().delete(organization).where(eq(organization.id, ORG));
	});

	it("a promotion is one notice on insert and on a status change, routed by its org and project — and silent on updated_at", async () => {
		const inserted = await emitted(async () => {
			const [row] = await db()
				.insert(environmentPromotions)
				.values({
					project_id: projectId,
					user_id: USER,
					org_id: ORG,
					source_environment_id: devId,
					target_environment_id: prodId,
					status: "PENDING_PLAN",
				})
				.returning({ id: environmentPromotions.id });
			promotionId = row.id;
		});
		expect(inserted).toEqual([{ t: "environments", id: promotionId, o: ORG, u: null, p: projectId }]);

		expect(
			await emitted(() =>
				db()
					.update(environmentPromotions)
					.set({ status: "PENDING_APPROVAL" })
					.where(eq(environmentPromotions.id, promotionId)),
			),
		).toEqual([{ t: "environments", id: promotionId, o: ORG, u: null, p: projectId }]);

		expect(
			await emitted(() =>
				db()
					.update(environmentPromotions)
					.set({ updated_at: new Date() })
					.where(eq(environmentPromotions.id, promotionId)),
			),
		).toEqual([]);
	});

	it("an approval slot with no org of its own routes by its PROJECT's org, on insert and when decided", async () => {
		let slotId = "";
		const opened = await emitted(async () => {
			const [row] = await db()
				.insert(promotionApprovals)
				.values({ promotion_id: promotionId, project_id: projectId, status: "pending" })
				.returning({ id: promotionApprovals.id });
			slotId = row.id;
		});
		expect(opened).toEqual([{ t: "environments", id: slotId, o: ORG, u: null, p: projectId }]);

		expect(
			await emitted(() =>
				db()
					.update(promotionApprovals)
					.set({ status: "approved", decided_by: USER, decided_at: new Date() })
					.where(eq(promotionApprovals.id, slotId)),
			),
		).toEqual([{ t: "environments", id: slotId, o: ORG, u: null, p: projectId }]);
	});

	it("a protection rule is a notice when a gate changes — and silent when only updated_at is stamped", async () => {
		let ruleId = "";
		const created = await emitted(async () => {
			const [row] = await db()
				.insert(environmentProtectionRules)
				.values({ project_id: projectId, environment_id: prodId, user_id: USER, org_id: ORG })
				.returning({ id: environmentProtectionRules.id });
			ruleId = row.id;
		});
		expect(created).toEqual([{ t: "environments", id: ruleId, o: ORG, u: null, p: projectId }]);

		expect(
			await emitted(() =>
				db()
					.update(environmentProtectionRules)
					.set({ require_approval: true })
					.where(eq(environmentProtectionRules.id, ruleId)),
			),
		).toEqual([{ t: "environments", id: ruleId, o: ORG, u: null, p: projectId }]);

		// A save that changes no gate (what the drawer sends when nothing was edited): the page's
		// chips do not move, so nothing is refetched.
		expect(
			await emitted(() =>
				db()
					.update(environmentProtectionRules)
					.set({ require_approval: true, updated_at: new Date() })
					.where(eq(environmentProtectionRules.id, ruleId)),
			),
		).toEqual([]);
	});
});
