// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cloud asset-change ingestion endpoint — the near-real-time path that keeps the inventory fresh
// between reconciliation sweeps (the drift foundation). The per-cloud event source (EventBridge / Cloud
// Asset Inventory feed / Event Grid), provisioned in the customer account at connector setup, normalizes
// its raw events and POSTs them here. Keeping normalization in the (in-cloud) forwarder means the
// console ingests one shape regardless of provider. Guarded by ALETHIA_CRON_SECRET (the forwarder holds
// it); the account id maps the event to a connection via its verified account id.

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
	type NormalizedCloudEvent,
	applyCloudEvent,
} from "@/lib/cloud-providers/events/ingest";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { cloudProvider } from "@/lib/db/schema/enums";

interface IngestBody {
	/** The cloud account/subscription/project id the events belong to (maps → cloud_identity). */
	account_id: string;
	events: NormalizedCloudEvent[];
}

/** Resolves the connection for a (provider, account id) via its verified account id. */
async function resolveIdentity(
	provider: (typeof cloudProvider.enumValues)[number],
	accountId: string,
): Promise<string | null> {
	const db = getServiceDb();
	const [row] = await db
		.select({ id: cloudIdentities.id })
		.from(cloudIdentities)
		.where(eq(cloudIdentities.verified_account_id, accountId))
		.limit(1);
	void provider;
	return row?.id ?? null;
}

export async function POST(
	req: Request,
	ctx: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
	const secret = process.env.ALETHIA_CRON_SECRET;
	if (!secret) {
		return NextResponse.json({ error: "ingestion not configured" }, { status: 503 });
	}
	if (req.headers.get("authorization") !== `Bearer ${secret}`) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const { provider: providerParam } = await ctx.params;
	const provider = cloudProvider.enumValues.find((p) => p === providerParam);
	if (!provider) {
		return NextResponse.json({ error: "unknown provider" }, { status: 404 });
	}

	let body: IngestBody;
	try {
		body = (await req.json()) as IngestBody;
	} catch {
		return NextResponse.json({ error: "invalid body" }, { status: 400 });
	}
	if (!body.account_id || !Array.isArray(body.events)) {
		return NextResponse.json({ error: "account_id + events required" }, { status: 400 });
	}

	const identityId = await resolveIdentity(provider, body.account_id);
	if (!identityId) {
		// Unknown account → ack (don't retry); the connection may not be set up here.
		return NextResponse.json({ applied: 0, reason: "no matching connection" });
	}

	let applied = 0;
	for (const event of body.events) {
		try {
			await applyCloudEvent(identityId, provider, event);
			applied += 1;
		} catch {
			// Skip a malformed event; the reconciliation sweep is the backstop.
		}
	}
	return NextResponse.json({ applied });
}
