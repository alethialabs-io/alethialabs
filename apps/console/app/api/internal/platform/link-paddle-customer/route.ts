// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform-internal: store an organization's Paddle customer id, for the staff app's "Link Paddle
// customer" action (customers invoiced by hand from the Paddle dashboard). The write and its checks
// live in lib/platform/paddle-customer.ts, keeping organization_billing single-writer in the console.
// Guarded by the dedicated PLATFORM_PROVISION_SECRET; fails closed.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isPlatformProvisionAuthorized } from "@/lib/auth/internal-auth";
import { linkPaddleCustomer } from "@/lib/platform/paddle-customer";
import { ProvisionError } from "@/lib/platform/provision";

const body = z.object({
	orgId: z.string().uuid(),
	/** Shape-checked in linkPaddleCustomer, so the refusal names the expected form. */
	customerId: z.string().min(1).max(64),
	/** The stored id the operator confirmed replacing, or null. */
	replace: z.string().max(64).nullable().default(null),
});

/** Links the org to the Paddle customer; 409 names a refusal, 400 a malformed body. */
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
		const result = await linkPaddleCustomer(parsed.data);
		return NextResponse.json({ ok: true, ...result });
	} catch (err) {
		if (err instanceof ProvisionError) {
			return NextResponse.json({ error: err.message }, { status: 409 });
		}
		const message = err instanceof Error ? err.message : "link-paddle-customer failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
