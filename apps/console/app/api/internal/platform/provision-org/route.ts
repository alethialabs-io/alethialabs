// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform-internal: create an org shell + invite its owner. Called by the staff app (apps/admin)
// during Enterprise onboarding. Guarded by PLATFORM_PROVISION_SECRET — a DEDICATED secret, not the
// broadly-shared cron secret, because minting an org and inviting an owner is far higher blast
// radius than an idempotent sweep. Fails closed when unset. The org/slug/authz rules stay here so
// the staff app never reimports them.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isPlatformProvisionAuthorized } from "@/lib/auth/internal-auth";
import { ProvisionError, provisionOrg } from "@/lib/platform/provision";

const body = z.object({
	name: z.string().min(2).max(120),
	slug: z.string().min(1).max(64),
	ownerEmail: z.string().email(),
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
		const result = await provisionOrg(parsed.data);
		return NextResponse.json(result, { status: 201 });
	} catch (err) {
		if (err instanceof ProvisionError) {
			return NextResponse.json({ error: err.message }, { status: 409 });
		}
		const message = err instanceof Error ? err.message : "provisioning failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
