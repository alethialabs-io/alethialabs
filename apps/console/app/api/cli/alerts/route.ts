// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { invalidateOrgRules } from "@/lib/alerts/rule-cache";
import { authorizeCli } from "@/lib/authz/guard";
import { getEntitlements } from "@/lib/authz/entitlements";
import { getServiceDb } from "@/lib/db";
import { alertChannels, alertRuleChannels, alertRules } from "@/lib/db/schema";
import { alertSeverity } from "@/lib/db/schema/enums";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliAlertRuleResponse,
	cliAlertRulesResponse,
} from "@/lib/validations/cli-contract";

/** Body of POST /api/cli/alerts — bind a set of event-key patterns to channels. */
const createAlertBody = z.object({
	name: z.string().min(1).max(120),
	event_patterns: z.array(z.string().min(1)).min(1),
	channel_ids: z.array(z.uuid()).min(1),
	severity: z.enum(alertSeverity.enumValues).default("warning"),
});

/** Shape of an alert rule on the CLI wire (the rule row + its channel bindings). */
function toAlertRuleWire(
	row: typeof alertRules.$inferSelect,
	channelIds: string[],
) {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		event_patterns: row.event_patterns,
		severity: row.severity,
		throttle_seconds: row.throttle_seconds,
		enabled: row.enabled,
		channel_ids: channelIds,
		created_at: row.created_at.toISOString(),
	};
}

/** Lists the active org's alert rules with their bound channel ids, newest first. */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view_alerts", { type: "alert" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();
		const [ruleRows, bindingRows] = await Promise.all([
			db
				.select()
				.from(alertRules)
				.where(eq(alertRules.org_id, actor.orgId))
				.orderBy(desc(alertRules.created_at)),
			db
				.select({
					rule_id: alertRuleChannels.rule_id,
					channel_id: alertRuleChannels.channel_id,
				})
				.from(alertRuleChannels)
				.innerJoin(alertRules, eq(alertRules.id, alertRuleChannels.rule_id))
				.where(eq(alertRules.org_id, actor.orgId)),
		]);

		const byRule = new Map<string, string[]>();
		for (const b of bindingRows) {
			const list = byRule.get(b.rule_id) ?? [];
			list.push(b.channel_id);
			byRule.set(b.rule_id, list);
		}

		const alert_rules = ruleRows.map((r) => toAlertRuleWire(r, byRule.get(r.id) ?? []));
		return cliJson(cliAlertRulesResponse, { alert_rules });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Creates an alert rule and binds its channels (all must belong to the org). */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "manage_alerts", { type: "alert" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	if (!getEntitlements(actor).alerting) {
		return NextResponse.json(
			{ error: "Alerts require a Pro plan or higher." },
			{ status: 402 },
		);
	}

	const parsed = createAlertBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const body = parsed.data;

	try {
		const db = getServiceDb();

		// No cross-org binding: every channel must belong to the caller's org.
		const owned = await db
			.select({ id: alertChannels.id })
			.from(alertChannels)
			.where(
				and(
					eq(alertChannels.org_id, actor.orgId),
					inArray(alertChannels.id, body.channel_ids),
				),
			);
		if (owned.length !== body.channel_ids.length) {
			return NextResponse.json(
				{ error: "One or more channels are invalid." },
				{ status: 400 },
			);
		}

		const [rule] = await db
			.insert(alertRules)
			.values({
				org_id: actor.orgId,
				name: body.name,
				event_patterns: body.event_patterns,
				severity: body.severity,
				enabled: true,
				created_by: actor.userId,
			})
			.returning();

		await db
			.insert(alertRuleChannels)
			.values(body.channel_ids.map((channel_id) => ({ rule_id: rule.id, channel_id })));

		invalidateOrgRules(actor.orgId);
		return cliJson(
			cliAlertRuleResponse,
			{ alert_rule: toAlertRuleWire(rule, body.channel_ids) },
			{ status: 201 },
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
