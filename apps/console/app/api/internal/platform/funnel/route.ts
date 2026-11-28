// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform-internal: the Postgres-derived funnel (REL-L12, #6913) for the staff app's `/funnel`
// page. The staff app reaches console data through these routes rather than importing console
// internals (alethialabs-io/web:apps/admin/lib/platform/console-client.ts), and the console owns the schema the query
// reads. The answer is aggregate counts only — see lib/queries/funnel.ts. Guarded by the dedicated
// PLATFORM_PROVISION_SECRET; fails closed (unset → 503, wrong bearer → 401).

import { NextResponse } from "next/server";
import { z } from "zod";
import { isPlatformProvisionAuthorized } from "@/lib/auth/internal-auth";
import { getServiceDb } from "@/lib/db";
import { FUNNEL_DEFAULT_DAYS, FUNNEL_MAX_DAYS, queryFunnel } from "@/lib/queries/funnel";

export const dynamic = "force-dynamic";

const query = z.object({
	days: z.coerce.number().int().min(1).max(FUNNEL_MAX_DAYS).default(FUNNEL_DEFAULT_DAYS),
});

/** Answers the funnel report for the last `?days=` UTC days (1..90, default 30). */
export async function GET(req: Request): Promise<NextResponse> {
	if (!process.env.PLATFORM_PROVISION_SECRET) {
		return NextResponse.json(
			{ error: "platform provisioning not configured (PLATFORM_PROVISION_SECRET unset)" },
			{ status: 503 },
		);
	}
	if (!isPlatformProvisionAuthorized(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const raw = new URL(req.url).searchParams.get("days");
	const parsed = query.safeParse({ days: raw ?? undefined });
	if (!parsed.success) {
		return NextResponse.json(
			{ error: `days must be a whole number from 1 to ${FUNNEL_MAX_DAYS}` },
			{ status: 400 },
		);
	}

	const report = await queryFunnel(getServiceDb(), { days: parsed.data.days });
	return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}
