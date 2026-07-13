// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform-internal: set an org's plan (the OFF-STRIPE onboarding path). Writes the one billing
// record through the real upsertOrgBilling — keeping organization_billing single-writer in the
// console — and sends the plan-welcome email exactly once. The Stripe path does NOT use this (its
// webhook writes billing). Guarded by the dedicated PLATFORM_PROVISION_SECRET; fails closed.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isPlatformProvisionAuthorized } from "@/lib/auth/internal-auth";
import { billingPlan, billingStatus } from "@/lib/db/schema/enums";
import { ProvisionError, setOrgPlan } from "@/lib/platform/provision";

const body = z.object({
	orgId: z.string().uuid(),
	plan: z.enum(billingPlan.enumValues),
	status: z.enum(billingStatus.enumValues),
	seats: z.number().int().positive().nullable().optional(),
	/** ISO timestamp — the contract term end. */
	periodEnd: z.string().datetime().nullable().optional(),
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
		await setOrgPlan({
			orgId: parsed.data.orgId,
			plan: parsed.data.plan,
			status: parsed.data.status,
			seats: parsed.data.seats ?? null,
			periodEnd: parsed.data.periodEnd ? new Date(parsed.data.periodEnd) : null,
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
