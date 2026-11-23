// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform-internal: set an org's plan and/or its standalone AI tier (the OFF-STRIPE onboarding path,
// and the complimentary Early Access grant, EA-3 #7325). Writes the one billing
// record through the real upsertOrgBilling — keeping organization_billing single-writer in the
// console — and sends the plan-welcome email exactly once. The Stripe path does NOT use this (its
// webhook writes billing). Guarded by the dedicated PLATFORM_PROVISION_SECRET; fails closed.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isPlatformProvisionAuthorized } from "@/lib/auth/internal-auth";
import type { AiTier } from "@/lib/billing/ai-plan";
import { EARLY_ACCESS_PLANS } from "@/lib/db/schema/early-access";
import { billingPlan, billingStatus } from "@/lib/db/schema/enums";
import { ProvisionError, setOrgPlan } from "@/lib/platform/provision";

/** The AI tiers, from the one place the ladder is declared (ai-plan.ts). */
const AI_TIERS = ["ai_free", "ai_plus", "ai_max"] as const satisfies readonly AiTier[];

const body = z
	.object({
		orgId: z.string().uuid(),
		/** The org plan and its status, together. Omitted for an AI-tier-only grant. */
		plan: z.enum(billingPlan.enumValues).optional(),
		status: z.enum(billingStatus.enumValues).optional(),
		seats: z.number().int().positive().nullable().optional(),
		/** ISO timestamp — the term end. Off-Stripe grants (plan and AI tier) lapse past it. */
		periodEnd: z.string().datetime().nullable().optional(),
		/** A standalone AI tier and its status, together (EA-3, #7325: AI plans can be granted). */
		aiTier: z.enum(AI_TIERS).optional(),
		aiStatus: z.enum(billingStatus.enumValues).optional(),
		/**
		 * Marks a complimentary Early Access grant, naming the plan granted: the customer gets the
		 * complimentary-terms email instead of the plan-welcome email.
		 */
		earlyAccessGrant: z.enum(EARLY_ACCESS_PLANS).optional(),
	})
	.refine((b) => (b.plan === undefined) === (b.status === undefined), {
		message: "plan and status are given together",
	})
	.refine((b) => (b.aiTier === undefined) === (b.aiStatus === undefined), {
		message: "aiTier and aiStatus are given together",
	})
	.refine((b) => b.plan !== undefined || b.aiTier !== undefined, {
		message: "give a plan, an AI tier, or both",
	});

export async function POST(req: Request): Promise<NextResponse> {
	if (!process.env.PLATFORM_PROVISION_SECRET) {
		return NextResponse.json(
			{ error: "platform provisioning not configured (PLATFORM_PROVISION_SECRET unset)" },
			{ status: 503 },
		);
	}
	if (!isPlatformProvisionAuthorized(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const parsed = body.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "invalid request body" }, { status: 400 });
	}

	try {
		const { aiTier, aiStatus } = parsed.data;
		await setOrgPlan({
			orgId: parsed.data.orgId,
			plan: parsed.data.plan,
			status: parsed.data.status,
			seats: parsed.data.seats ?? null,
			periodEnd: parsed.data.periodEnd ? new Date(parsed.data.periodEnd) : null,
			ai: aiTier && aiStatus ? { tier: aiTier, status: aiStatus } : undefined,
			earlyAccessGrant: parsed.data.earlyAccessGrant,
		});
		return NextResponse.json({ ok: true });
	} catch (err) {
		if (err instanceof ProvisionError) {
			return NextResponse.json({ error: err.message }, { status: 409 });
		}
		const message = err instanceof Error ? err.message : "set-plan failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
