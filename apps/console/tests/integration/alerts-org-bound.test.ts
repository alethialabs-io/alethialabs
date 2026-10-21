// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6125): every alert write that names a row BY ID resolves that row within the
// addressed organization — channels (update, enable/disable, verify, delete) and policies (enable/
// disable, delete, and a create that binds a channel). `updatePolicy` is covered beside the other
// org-bound decisions (org-bound-decisions.test.ts).
//
// The PDP below allows everything, which is what an org-wide `manage_alerts` grant does: it is a
// decision about the ORG, and says nothing about whether the row named belongs to it. So every
// assertion here is about the org binding in the action itself: an actor of org A naming org B's id
// is told NOT_FOUND — the same answer as an id that never existed — and B's row is exactly as it
// was. Each block has a positive control on A's own row, so a refusal cannot pass by refusing
// everything. Rows are seeded on the service connection; the actions run under an injected actor.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz")>()),
	// An org-wide grant: every action on every id of the type is allowed.
	getPdp: () => ({
		can: async () => ({ allowed: true }),
		enforce: async () => {},
	}),
}));
// Verification would send a real delivery; the sender is the one thing stubbed past the binding.
const sent = vi.hoisted((): { ids: string[] } => ({ ids: [] }));
vi.mock("@/lib/alerts/channels", () => ({
	getChannelSender: () => ({
		verify: async (channel: { id: string }) => {
			sent.ids.push(channel.id);
		},
	}),
}));

import {
	createPolicy,
	deleteChannel,
	deletePolicy,
	setChannelEnabled,
	togglePolicy,
	updateChannel,
	verifyChannel,
} from "@/app/server/actions/alerts";
import { runWithActor } from "@/lib/authz/actor-context";
import type { Actor } from "@/lib/authz/types";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { getServiceDb } from "@/lib/db";
import { alertChannels, alertRuleChannels, alertRules } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG_A = randomUUID();
const ORG_B = randomUUID();

/** Org A's actor, entitled to alerting so every action reaches its write. */
const ACTOR_A: Actor = {
	userId: ORG_A,
	orgId: ORG_A,
	entitlements: { ...COMMUNITY_ENTITLEMENTS, alerting: true },
};

/** Runs `fn` as org A's actor. */
function asA<T>(fn: () => Promise<T>): Promise<T> {
	return runWithActor(ACTOR_A, fn);
}

/** A NOT_FOUND result with `message`. */
function notFound(message: string) {
	return { ok: false, error: { kind: "not-found", message } };
}

/** Seeds an email channel and a rule bound to it in `orgId`. */
async function seed(orgId: string) {
	const db = getServiceDb();
	const [channel] = await db
		.insert(alertChannels)
		.values({
			org_id: orgId,
			type: "email",
			name: "original",
			config: { recipients: ["ops@example.test"] },
			is_verified: false,
			created_by: orgId,
		})
		.returning({ id: alertChannels.id });
	const [rule] = await db
		.insert(alertRules)
		.values({ org_id: orgId, name: "original", event_patterns: ["system.job.failed"], created_by: orgId })
		.returning({ id: alertRules.id });
	await db.insert(alertRuleChannels).values({ rule_id: rule.id, channel_id: channel.id });
	return { channelId: channel.id, ruleId: rule.id };
}

/** A channel row's user-visible state, or null once it is gone. */
async function channelState(id: string) {
	const [row] = await getServiceDb().select().from(alertChannels).where(eq(alertChannels.id, id));
	return row ? { name: row.name, enabled: row.enabled, verified: row.is_verified } : null;
}

/** A rule row's user-visible state, or null once it is gone. */
async function ruleState(id: string) {
	const [row] = await getServiceDb().select().from(alertRules).where(eq(alertRules.id, id));
	return row ? { name: row.name, enabled: row.enabled } : null;
}

/** An email-channel update input for `id`. */
function channelUpdate(id: string) {
	return { id, type: "email" as const, name: "rewritten", enabled: true, recipients: ["new@example.test"] };
}

describeIfDb("alert writes addressed by id resolve the row within the addressed organization (#6125)", () => {
	beforeEach(() => {
		sent.ids.length = 0;
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(alertRules).where(inArray(alertRules.org_id, [ORG_A, ORG_B]));
		await db.delete(alertChannels).where(inArray(alertChannels.org_id, [ORG_A, ORG_B]));
	});

	describe("channels", () => {
		it("update: another org's channel is not found and keeps its name", async () => {
			const b = await seed(ORG_B);
			expect(await asA(() => updateChannel(channelUpdate(b.channelId)))).toEqual(notFound("Channel not found."));
			expect(await channelState(b.channelId)).toEqual({ name: "original", enabled: true, verified: false });
		});

		it("update (control): the org's own channel is rewritten", async () => {
			const a = await seed(ORG_A);
			expect(await asA(() => updateChannel(channelUpdate(a.channelId)))).toEqual({ ok: true, data: { id: a.channelId } });
			expect((await channelState(a.channelId))?.name).toBe("rewritten");
		});

		it("enable/disable: another org's channel is not found and stays enabled", async () => {
			const b = await seed(ORG_B);
			expect(await asA(() => setChannelEnabled({ id: b.channelId, enabled: false }))).toEqual(
				notFound("Channel not found."),
			);
			expect((await channelState(b.channelId))?.enabled).toBe(true);
		});

		it("enable/disable (control): the org's own channel is disabled", async () => {
			const a = await seed(ORG_A);
			expect(await asA(() => setChannelEnabled({ id: a.channelId, enabled: false }))).toEqual({
				ok: true,
				data: { id: a.channelId },
			});
			expect((await channelState(a.channelId))?.enabled).toBe(false);
		});

		it("verify: another org's channel is not found, nothing is sent to it, and it stays unverified", async () => {
			const b = await seed(ORG_B);
			expect(await asA(() => verifyChannel({ id: b.channelId }))).toEqual(notFound("Channel not found."));
			expect(sent.ids).toEqual([]);
			expect((await channelState(b.channelId))?.verified).toBe(false);
		});

		it("verify (control): the org's own channel is sent to and marked verified", async () => {
			const a = await seed(ORG_A);
			expect(await asA(() => verifyChannel({ id: a.channelId }))).toEqual({ ok: true, data: { verified: true } });
			expect(sent.ids).toEqual([a.channelId]);
			expect((await channelState(a.channelId))?.verified).toBe(true);
		});

		it("delete: another org's channel is not found and still exists", async () => {
			const b = await seed(ORG_B);
			expect(await asA(() => deleteChannel({ id: b.channelId }))).toEqual(notFound("Channel not found."));
			expect(await channelState(b.channelId)).not.toBeNull();
		});

		it("delete (control): the org's own channel is deleted", async () => {
			const a = await seed(ORG_A);
			expect(await asA(() => deleteChannel({ id: a.channelId }))).toEqual({ ok: true, data: { id: a.channelId } });
			expect(await channelState(a.channelId)).toBeNull();
		});

		it("an id that names no channel at all reads the same as another org's", async () => {
			expect(await asA(() => deleteChannel({ id: randomUUID() }))).toEqual(notFound("Channel not found."));
		});
	});

	describe("policies", () => {
		it("enable/disable: another org's policy is not found and stays enabled", async () => {
			const b = await seed(ORG_B);
			expect(await asA(() => togglePolicy({ id: b.ruleId, enabled: false }))).toEqual(
				notFound("Alert policy not found."),
			);
			expect(await ruleState(b.ruleId)).toEqual({ name: "original", enabled: true });
		});

		it("enable/disable (control): the org's own policy is disabled", async () => {
			const a = await seed(ORG_A);
			expect(await asA(() => togglePolicy({ id: a.ruleId, enabled: false }))).toEqual({
				ok: true,
				data: { id: a.ruleId },
			});
			expect((await ruleState(a.ruleId))?.enabled).toBe(false);
		});

		it("delete: another org's policy is not found and still exists", async () => {
			const b = await seed(ORG_B);
			expect(await asA(() => deletePolicy({ id: b.ruleId }))).toEqual(notFound("Alert policy not found."));
			expect(await ruleState(b.ruleId)).not.toBeNull();
		});

		it("delete (control): the org's own policy is deleted", async () => {
			const a = await seed(ORG_A);
			expect(await asA(() => deletePolicy({ id: a.ruleId }))).toEqual({ ok: true, data: { id: a.ruleId } });
			expect(await ruleState(a.ruleId)).toBeNull();
		});

		it("create: binding another org's channel is refused and creates no policy", async () => {
			const b = await seed(ORG_B);
			const name = `cross-${randomUUID().slice(0, 8)}`;
			const input = { name, event_patterns: ["system.job.failed"], channels: [{ id: b.channelId }] };
			expect(await asA(() => createPolicy(input))).toEqual(notFound("One or more channels are invalid."));
			const created = await getServiceDb().select().from(alertRules).where(eq(alertRules.name, name));
			expect(created).toEqual([]);
		});

		it("create (control): binding the org's own channel creates the policy in the org", async () => {
			const a = await seed(ORG_A);
			const result = await asA(() =>
				createPolicy({ name: "mine", event_patterns: ["system.job.failed"], channels: [{ id: a.channelId }] }),
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const [row] = await getServiceDb().select().from(alertRules).where(eq(alertRules.id, result.data.id));
			expect(row.org_id).toBe(ORG_A);
		});
	});
});
