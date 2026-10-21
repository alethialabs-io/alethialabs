// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: actions that address a row BY ID resolve that row within the addressed organization.
//
// The PDP below allows everything, which is what an org-wide grant does — it matches any resource
// id of the type, whether or not the addressed org owns it. So every assertion here is about the
// ORG BINDING in the action itself, not about the PDP: an actor of org A acting on org B's id must
// be told "not found" and leave B's rows exactly as they were, while the same call on A's own row
// (the positive control in each block) goes through. Rows are seeded on the service connection and
// the actions run under an injected actor (the runWithActor seam the MCP server uses).
//
// Covered: promotion decisions and reads (approve / reject / cancel / getPromotion /
// getPromotionDetail), alert policy updates, classification assignment, and the classification
// values the promotion gate engine reads for an environment.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { ORG_A_ID } = vi.hoisted(() => ({ ORG_A_ID: crypto.randomUUID() }));
const pdpCalls = vi.hoisted((): { ids: (string | undefined)[] } => ({ ids: [] }));
vi.mock("@/lib/authz", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz")>()),
	// An org-wide grant: every action on every id of the type is allowed.
	getPdp: () => ({
		can: async (_a: unknown, _action: unknown, ref: { id?: string }) => {
			pdpCalls.ids.push(ref.id);
			return { allowed: true };
		},
		enforce: async (_a: unknown, _action: unknown, ref: { id?: string }) => {
			pdpCalls.ids.push(ref.id);
		},
	}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
// The CLI route's bearer check is stubbed to org A's session; everything after it is real.
vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz/guard")>()),
	authorizeCli: vi.fn(async () => ({
		actor: { userId: ORG_A_ID, orgId: ORG_A_ID },
		credential: "session",
		orgScope: [ORG_A_ID],
	})),
}));

import { POST as cliAssign } from "@/app/api/cli/classification/assignments/route";
import { updatePolicy } from "@/app/server/actions/alerts";
import { assignClassification } from "@/app/server/actions/classification/assignments";
import {
	approvePromotion,
	cancelPromotion,
	getPromotion,
	getPromotionDetail,
	rejectPromotion,
} from "@/app/server/actions/promotions";
import { runWithActor } from "@/lib/authz/actor-context";
import type { Actor } from "@/lib/authz/types";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { getServiceDb } from "@/lib/db";
import {
	alertChannels,
	alertRuleChannels,
	alertRules,
	classificationAssignment,
	classificationDimension,
	classificationValue,
	environmentPromotions,
	projectEnvironments,
	projects,
	promotionApprovals,
} from "@/lib/db/schema";
import { getEnforcingValuesForEnvironment } from "@/lib/queries/classification";
import { describeIfDb } from "./db";

// Two organizations. The ids are user ids too, so each is its owner's personal org — the
// org-binding under test is the same for a team org; only the org id differs.
const ORG_A = ORG_A_ID;
const ORG_B = randomUUID();

/** Org A's actor, entitled to alerting so the alert action reaches its write. */
const ACTOR_A: Actor = {
	userId: ORG_A,
	orgId: ORG_A,
	entitlements: { ...COMMUNITY_ENTITLEMENTS, alerting: true },
};

/** Runs `fn` as org A's actor. */
function asA<T>(fn: () => Promise<T>): Promise<T> {
	return runWithActor(ACTOR_A, fn);
}

const seededProjects: string[] = [];

/** Seeds a project in `orgId` with a source and a target environment. */
async function seedProject(orgId: string) {
	const db = getServiceDb();
	const [p] = await db
		.insert(projects)
		.values({
			user_id: orgId,
			org_id: orgId,
			project_name: `org-bound-${randomUUID().slice(0, 8)}`,
			region: "us-east-1",
			iac_version: "1.9.5",
		})
		.returning({ id: projects.id });
	seededProjects.push(p.id);
	const [src] = await db
		.insert(projectEnvironments)
		.values({ project_id: p.id, user_id: orgId, name: "staging", status: "ACTIVE", is_default: true })
		.returning({ id: projectEnvironments.id });
	const [tgt] = await db
		.insert(projectEnvironments)
		.values({ project_id: p.id, user_id: orgId, name: "prod", status: "ACTIVE", is_default: false })
		.returning({ id: projectEnvironments.id });
	return { projectId: p.id, sourceEnvId: src.id, targetEnvId: tgt.id };
}

/** Seeds a promotion awaiting approval in `orgId`, with one pending slot and no approver spec. */
async function seedPendingPromotion(orgId: string) {
	const { projectId, sourceEnvId, targetEnvId } = await seedProject(orgId);
	const db = getServiceDb();
	const [promo] = await db
		.insert(environmentPromotions)
		.values({
			project_id: projectId,
			user_id: orgId,
			org_id: orgId,
			source_environment_id: sourceEnvId,
			target_environment_id: targetEnvId,
			status: "PENDING_APPROVAL",
		})
		.returning({ id: environmentPromotions.id });
	await db.insert(promotionApprovals).values({ promotion_id: promo.id, project_id: projectId, org_id: orgId });
	return { projectId, targetEnvId, promotionId: promo.id };
}

/** The promotion row and its approval slots, freshly read. */
async function stateOf(promotionId: string) {
	const db = getServiceDb();
	const [promotion] = await db
		.select()
		.from(environmentPromotions)
		.where(eq(environmentPromotions.id, promotionId));
	const approvals = await db
		.select()
		.from(promotionApprovals)
		.where(eq(promotionApprovals.promotion_id, promotionId));
	return {
		status: promotion.status,
		error: promotion.error_message,
		slots: approvals.map((a) => ({ status: a.status, by: a.decided_by })),
	};
}

describeIfDb("actions addressed by id resolve the row within the addressed organization", () => {
	beforeEach(() => {
		pdpCalls.ids.length = 0;
	});

	afterAll(async () => {
		const db = getServiceDb();
		if (seededProjects.length > 0) await db.delete(projects).where(inArray(projects.id, seededProjects));
		await db.delete(alertRules).where(inArray(alertRules.org_id, [ORG_A, ORG_B]));
		await db.delete(alertChannels).where(inArray(alertChannels.org_id, [ORG_A, ORG_B]));
		await db
			.delete(classificationAssignment)
			.where(inArray(classificationAssignment.org_id, [ORG_A, ORG_B]));
		await db
			.delete(classificationDimension)
			.where(inArray(classificationDimension.org_id, [ORG_A, ORG_B]));
	});

	describe("promotions", () => {
		it("approve: another organization's promotion is not found, its slot stays pending", async () => {
			const b = await seedPendingPromotion(ORG_B);
			await expect(asA(() => approvePromotion(b.promotionId))).rejects.toThrow("Promotion not found");
			expect(await stateOf(b.promotionId)).toEqual({
				status: "PENDING_APPROVAL",
				error: null,
				slots: [{ status: "pending", by: null }],
			});
			// The PDP was never asked about B's project.
			expect(pdpCalls.ids).not.toContain(b.projectId);
		});

		it("approve (control): the org's own promotion reaches the approval write", async () => {
			const a = await seedPendingPromotion(ORG_A);
			// No plan job is seeded, so the gate re-evaluation after the claim stops here — which is
			// past the slot write this control is about.
			await expect(asA(() => approvePromotion(a.promotionId))).rejects.toThrow(
				"Promotion plan job not found",
			);
			expect((await stateOf(a.promotionId)).slots).toEqual([{ status: "approved", by: ORG_A }]);
		});

		it("reject: another organization's promotion is not found and stays pending", async () => {
			const b = await seedPendingPromotion(ORG_B);
			await expect(asA(() => rejectPromotion(b.promotionId, "no"))).rejects.toThrow(
				"Promotion not found",
			);
			expect(await stateOf(b.promotionId)).toEqual({
				status: "PENDING_APPROVAL",
				error: null,
				slots: [{ status: "pending", by: null }],
			});
		});

		it("reject (control): the org's own promotion is rejected", async () => {
			const a = await seedPendingPromotion(ORG_A);
			await asA(() => rejectPromotion(a.promotionId, "no"));
			expect(await stateOf(a.promotionId)).toEqual({
				status: "CANCELLED",
				error: "Rejected: no",
				slots: [{ status: "rejected", by: ORG_A }],
			});
		});

		it("cancel: another organization's promotion is not found and stays in flight", async () => {
			const b = await seedPendingPromotion(ORG_B);
			await expect(asA(() => cancelPromotion(b.promotionId))).rejects.toThrow("Promotion not found");
			expect((await stateOf(b.promotionId)).status).toBe("PENDING_APPROVAL");
		});

		it("cancel (control): the org's own promotion is cancelled", async () => {
			const a = await seedPendingPromotion(ORG_A);
			await asA(() => cancelPromotion(a.promotionId));
			expect((await stateOf(a.promotionId)).status).toBe("CANCELLED");
		});

		it("reads: another organization's promotion is not found, exactly like an unknown id", async () => {
			const b = await seedPendingPromotion(ORG_B);
			await expect(asA(() => getPromotion(b.promotionId))).rejects.toThrow("Promotion not found");
			await expect(asA(() => getPromotionDetail(b.promotionId))).rejects.toThrow(
				"Promotion not found",
			);
			await expect(asA(() => getPromotion(randomUUID()))).rejects.toThrow("Promotion not found");
			expect(pdpCalls.ids).not.toContain(b.projectId);
		});

		it("reads (control): the org's own promotion is returned", async () => {
			const a = await seedPendingPromotion(ORG_A);
			const { promotion, approvals } = await asA(() => getPromotion(a.promotionId));
			expect(promotion.id).toBe(a.promotionId);
			expect(approvals).toHaveLength(1);
			const detail = await asA(() => getPromotionDetail(a.promotionId));
			expect(detail).toMatchObject({ id: a.promotionId, targetName: "prod", required: 1 });
		});
	});

	describe("alert policy updates", () => {
		/** Seeds a channel + a rule bound to it in `orgId`. */
		async function seedRule(orgId: string) {
			const db = getServiceDb();
			const [channel] = await db
				.insert(alertChannels)
				.values({ org_id: orgId, type: "webhook", name: `ch-${orgId.slice(0, 6)}`, created_by: orgId })
				.returning({ id: alertChannels.id });
			const [rule] = await db
				.insert(alertRules)
				.values({
					org_id: orgId,
					name: "original",
					event_patterns: ["system.job.failed"],
					created_by: orgId,
				})
				.returning({ id: alertRules.id });
			await db.insert(alertRuleChannels).values({ rule_id: rule.id, channel_id: channel.id });
			return { channelId: channel.id, ruleId: rule.id };
		}

		/** A rule's name and its bound channel ids, freshly read. */
		async function ruleState(ruleId: string) {
			const db = getServiceDb();
			const [rule] = await db.select().from(alertRules).where(eq(alertRules.id, ruleId));
			const bindings = await db
				.select({ channel: alertRuleChannels.channel_id })
				.from(alertRuleChannels)
				.where(eq(alertRuleChannels.rule_id, ruleId));
			return { name: rule.name, channels: bindings.map((b) => b.channel) };
		}

		/** A policy input binding `channelId`. */
		function input(channelId: string) {
			return {
				name: "rewritten",
				event_patterns: ["system.job.failed"],
				match: {},
				severity: "warning" as const,
				throttle_seconds: 0,
				escalate: false,
				enabled: true,
				channels: [{ id: channelId }],
			};
		}

		it("another organization's policy is not found and keeps its own bindings", async () => {
			const a = await seedRule(ORG_A);
			const b = await seedRule(ORG_B);
			await expect(asA(() => updatePolicy(b.ruleId, input(a.channelId)))).rejects.toThrow(
				"Alert policy not found.",
			);
			expect(await ruleState(b.ruleId)).toEqual({ name: "original", channels: [b.channelId] });
		});

		it("a channel of another organization cannot be attached", async () => {
			const a = await seedRule(ORG_A);
			const b = await seedRule(ORG_B);
			await expect(asA(() => updatePolicy(a.ruleId, input(b.channelId)))).rejects.toThrow(
				"One or more channels are invalid.",
			);
			expect(await ruleState(a.ruleId)).toEqual({ name: "original", channels: [a.channelId] });
		});

		it("(control) the org's own policy is rewritten and rebound", async () => {
			const a = await seedRule(ORG_A);
			const db = getServiceDb();
			const [second] = await db
				.insert(alertChannels)
				.values({ org_id: ORG_A, type: "webhook", name: "second", created_by: ORG_A })
				.returning({ id: alertChannels.id });
			await asA(() => updatePolicy(a.ruleId, input(second.id)));
			expect(await ruleState(a.ruleId)).toEqual({ name: "rewritten", channels: [second.id] });
		});
	});

	describe("classification", () => {
		/** Seeds an enforcing value in `orgId` (min_approvals `n`). */
		async function seedEnforcingValue(orgId: string, n: number) {
			const db = getServiceDb();
			const [dim] = await db
				.insert(classificationDimension)
				.values({
					org_id: orgId,
					created_by: orgId,
					key: `tier-${randomUUID().slice(0, 8)}`,
					label: `Tier ${orgId.slice(0, 6)}`,
				})
				.returning({ id: classificationDimension.id, key: classificationDimension.key });
			const [value] = await db
				.insert(classificationValue)
				.values({
					org_id: orgId,
					dimension_id: dim.id,
					value: "critical",
					label: `Critical ${orgId.slice(0, 6)}`,
					enforcement: { require_approval: true, require_verify_pass: false, min_approvals: n },
				})
				.returning({ id: classificationValue.id });
			return { dimensionId: dim.id, dimensionKey: dim.key, valueId: value.id };
		}

		it("assigning to another organization's environment is refused and writes nothing", async () => {
			const b = await seedProject(ORG_B);
			const v = await seedEnforcingValue(ORG_A, 5);
			await expect(
				asA(() =>
					assignClassification({
						value_id: v.valueId,
						resource_kind: "project_environment",
						resource_id: b.targetEnvId,
					}),
				),
			).rejects.toThrow("Resource not found");
			const rows = await getServiceDb()
				.select()
				.from(classificationAssignment)
				.where(eq(classificationAssignment.resource_id, b.targetEnvId));
			expect(rows).toEqual([]);
		});

		it("(control) assigning to the org's own environment is recorded", async () => {
			const a = await seedProject(ORG_A);
			const v = await seedEnforcingValue(ORG_A, 2);
			await asA(() =>
				assignClassification({
					value_id: v.valueId,
					resource_kind: "project_environment",
					resource_id: a.targetEnvId,
				}),
			);
			const rows = await getServiceDb()
				.select({ org: classificationAssignment.org_id })
				.from(classificationAssignment)
				.where(eq(classificationAssignment.resource_id, a.targetEnvId));
			expect(rows).toEqual([{ org: ORG_A }]);
		});

		/** A CLI assign request for `envId`, naming `dimensionKey`'s `critical` value. */
		function cliRequest(envId: string, dimensionKey: string): Request {
			return new Request("http://localhost/api/cli/classification/assignments", {
				method: "POST",
				body: JSON.stringify({
					kind: "project_environment",
					id: envId,
					dimension_key: dimensionKey,
					value_slug: "critical",
				}),
			});
		}

		it("CLI: assigning to another organization's environment is 404 and writes nothing", async () => {
			const b = await seedProject(ORG_B);
			const v = await seedEnforcingValue(ORG_A, 5);
			const res = await cliAssign(cliRequest(b.targetEnvId, v.dimensionKey));
			expect(res.status).toBe(404);
			const rows = await getServiceDb()
				.select()
				.from(classificationAssignment)
				.where(eq(classificationAssignment.resource_id, b.targetEnvId));
			expect(rows).toEqual([]);
		});

		it("CLI (control): assigning to the org's own environment is recorded", async () => {
			const a = await seedProject(ORG_A);
			const v = await seedEnforcingValue(ORG_A, 2);
			const res = await cliAssign(cliRequest(a.targetEnvId, v.dimensionKey));
			expect(res.status).toBe(200);
			const rows = await getServiceDb()
				.select({ org: classificationAssignment.org_id })
				.from(classificationAssignment)
				.where(eq(classificationAssignment.resource_id, a.targetEnvId));
			expect(rows).toEqual([{ org: ORG_A }]);
		});

		it("an environment's gate values count only its own organization's assignments", async () => {
			const b = await seedProject(ORG_B);
			const own = await seedEnforcingValue(ORG_B, 2);
			const foreign = await seedEnforcingValue(ORG_A, 5);
			const db = getServiceDb();
			// B's own label, and a row naming B's environment under org A — the shape a write that
			// skipped the resource check would have left behind.
			await db.insert(classificationAssignment).values([
				{
					org_id: ORG_B,
					dimension_id: own.dimensionId,
					value_id: own.valueId,
					resource_kind: "project_environment",
					resource_id: b.targetEnvId,
					assigned_by: ORG_B,
				},
				{
					org_id: ORG_A,
					dimension_id: foreign.dimensionId,
					value_id: foreign.valueId,
					resource_kind: "project_environment",
					resource_id: b.targetEnvId,
					assigned_by: ORG_A,
				},
			]);
			const values = await getEnforcingValuesForEnvironment(db, b.targetEnvId);
			expect(values).toEqual([
				{
					value_label: `Critical ${ORG_B.slice(0, 6)}`,
					dimension_label: `Tier ${ORG_B.slice(0, 6)}`,
					enforcement: { require_approval: true, require_verify_pass: false, min_approvals: 2 },
				},
			]);
		});
	});
});
