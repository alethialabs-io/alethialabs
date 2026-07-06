// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getChannelSender } from "@/lib/alerts/channels";
import { authorizeCli } from "@/lib/authz/guard";
import { getEntitlements } from "@/lib/authz/entitlements";
import { encryptSecret, isCredEncryptionConfigured } from "@/lib/crypto/secrets";
import { getServiceDb } from "@/lib/db";
import { alertChannels } from "@/lib/db/schema";
import { alertChannelType } from "@/lib/db/schema/enums";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliChannelResponse,
	cliChannelsResponse,
} from "@/lib/validations/cli-contract";

/** Body of POST /api/cli/channels — `config` carries email recipients and/or the
 * transport's destination (URL / signing secret / PagerDuty routing key). */
const createChannelBody = z.object({
	name: z.string().min(1).max(120),
	type: z.enum(alertChannelType.enumValues),
	config: z
		.object({
			recipients: z.array(z.string().email()).optional(),
			url: z.string().url().optional(),
			signing_secret: z.string().min(1).optional(),
			routing_key: z.string().min(1).optional(),
		})
		.default({}),
});

type CreateChannelBody = z.infer<typeof createChannelBody>;

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

/** True if the input carries a usable destination for its transport. */
function destinationPresent(body: CreateChannelBody): boolean {
	if (body.type === "email") return (body.config.recipients?.length ?? 0) > 0;
	if (body.type === "pagerduty") return Boolean(body.config.routing_key);
	return Boolean(body.config.url);
}

/** Builds the encrypted secret envelope from the supplied plaintext fields, or null. */
function buildSecret(body: CreateChannelBody) {
	const fields: Record<string, string> = {};
	if (body.config.url) fields.url = body.config.url;
	if (body.config.signing_secret) fields.signingSecret = body.config.signing_secret;
	if (body.config.routing_key) fields.routingKey = body.config.routing_key;
	return Object.keys(fields).length > 0 ? encryptSecret(fields) : null;
}

/** Lists the active org's notification channels, newest first. */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view_alerts", { type: "alert" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const rows = await getServiceDb()
			.select()
			.from(alertChannels)
			.where(eq(alertChannels.org_id, actor.orgId))
			.orderBy(desc(alertChannels.created_at));

		return cliJson(cliChannelsResponse, { channels: rows.map(toChannelWire) });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Creates a notification channel after verifying its endpoint (a channel never
 * exists unverified). Mirrors the console addChannel server action. */
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

	const parsed = createChannelBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const body = parsed.data;

	if (body.type !== "email" && !isCredEncryptionConfigured()) {
		return NextResponse.json(
			{
				error:
					"Encryption is not configured, so webhook/Slack/RocketChat URLs can't be stored. " +
					"Set ALETHIA_CRED_ENCRYPTION_KEY and restart. Email channels work without it.",
			},
			{ status: 400 },
		);
	}
	if (!destinationPresent(body)) {
		return NextResponse.json(
			{ error: "Add a recipient (email) or a destination URL/routing key." },
			{ status: 400 },
		);
	}

	const secret = buildSecret(body);
	const now = new Date();
	const recipients = body.config.recipients ?? [];

	// Verify the endpoint BEFORE persisting, against a transient (unsaved) channel.
	const preview: typeof alertChannels.$inferSelect = {
		id: "preview",
		org_id: actor.orgId,
		type: body.type,
		name: body.name,
		config: { recipients },
		secret,
		enabled: true,
		is_verified: false,
		last_verified_at: null,
		created_by: actor.userId,
		created_at: now,
		updated_at: now,
	};
	try {
		await getChannelSender(body.type).verify(preview);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Verification failed.";
		return NextResponse.json({ error: message }, { status: 400 });
	}

	try {
		const [row] = await getServiceDb()
			.insert(alertChannels)
			.values({
				org_id: actor.orgId,
				type: body.type,
				name: body.name,
				enabled: true,
				config: { recipients },
				secret,
				is_verified: true,
				last_verified_at: now,
				created_by: actor.userId,
			})
			.returning();

		return cliJson(cliChannelResponse, { channel: toChannelWire(row) }, { status: 201 });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
