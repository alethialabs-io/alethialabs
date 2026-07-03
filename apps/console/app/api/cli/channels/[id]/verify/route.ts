// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { getChannelSender } from "@/lib/alerts/channels";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { alertChannels } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliChannelResponse } from "@/lib/validations/cli-contract";

/** Maps a channel row to its client-safe CLI wire shape (never the secret envelope). */
function toChannelWire(row: typeof alertChannels.$inferSelect) {
	return {
		id: row.id,
		type: row.type,
		name: row.name,
		enabled: row.enabled,
		is_verified: row.is_verified,
		recipients: row.config.recipients ?? [],
		has_secret: Boolean(row.secret),
		last_verified_at: row.last_verified_at?.toISOString() ?? null,
		created_at: row.created_at.toISOString(),
	};
}

/** Sends a synthetic test event through the channel and records the result,
 * returning the (now verified) channel. Mirrors the console verifyChannel action. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "manage_alerts", { type: "alert" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const db = getServiceDb();
	const [channel] = await db
		.select()
		.from(alertChannels)
		.where(and(eq(alertChannels.id, id), eq(alertChannels.org_id, actor.orgId)))
		.limit(1);
	if (!channel) {
		return NextResponse.json({ error: "Channel not found" }, { status: 404 });
	}

	try {
		await getChannelSender(channel.type).verify(channel);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Verification failed.";
		return NextResponse.json({ error: message }, { status: 400 });
	}

	try {
		const now = new Date();
		const [row] = await db
			.update(alertChannels)
			.set({ is_verified: true, last_verified_at: now })
			.where(eq(alertChannels.id, id))
			.returning();
		return cliJson(cliChannelResponse, { channel: toChannelWire(row) });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
