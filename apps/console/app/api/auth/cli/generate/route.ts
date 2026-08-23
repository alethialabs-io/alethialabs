// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, isNull, or } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
	CLI_DEVICE_RATE_LIMIT,
	checkDeviceCodeBinding,
	cliDeviceRateLimitKey,
	deviceCodeExpiresAt,
	isValidDeviceCode,
	isValidUserCode,
} from "@/lib/auth/cli-device-code";
import { getServiceDb } from "@/lib/db";
import { cliLogins } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"];

/** JSON error helper — every failure arm answers in the same shape. */
function fail(error: string, status: number) {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Approves one CLI device code for the signed-in user. Called by /cli/login ONLY from an
 * explicit "Approve" press — never on page mount — after the user has compared the
 * `user_code` on screen with the one their terminal printed.
 */
export async function POST(req: Request) {
	const hdrs = await headers();

	const limitKey = cliDeviceRateLimitKey("generate", hdrs);
	if (
		limitKey &&
		!checkRateLimit(
			limitKey,
			CLI_DEVICE_RATE_LIMIT.limit,
			CLI_DEVICE_RATE_LIMIT.windowMs,
		).ok
	) {
		return fail("Too many requests", 429);
	}

	const session = await auth.api.getSession({ headers: hdrs });

	if (!session) {
		return fail("Unauthorized", 401);
	}

	const body = await req.json().catch(() => null);
	const device_code = body?.device_code;
	const user_code = body?.user_code;
	if (!isValidDeviceCode(device_code)) {
		return fail("Missing or malformed device_code", 400);
	}
	// RFC 8628 binding: the CLI mints a user_code, prints it, and puts it in the link.
	// A request without one cannot have been shown to the user for comparison.
	if (!isValidUserCode(user_code)) {
		return fail("Missing or malformed user_code", 400);
	}

	const db = getServiceDb();

	// Refuse a device code that already belongs to somebody else instead of silently
	// re-pointing it (see checkDeviceCodeBinding — this is the takeover gate).
	const [existing] = await db
		.select({ profile_id: cliLogins.profile_id })
		.from(cliLogins)
		.where(eq(cliLogins.device_code, device_code))
		.limit(1);

	if (!checkDeviceCodeBinding(existing, session.user.id).ok) {
		return fail("This login request belongs to another account", 409);
	}

	// Best-effort: stash the user's first linked git provider token for the CLI
	// (temporarily held in verification_code, during the device-code flow).
	let providerToken: string | null = null;
	try {
		const accounts = await auth.api.listUserAccounts({ headers: hdrs });
		const git = accounts.find((a) => GIT_PROVIDERS.includes(a.providerId));
		if (git) {
			// 1.7's selector is the LOCAL account.id. This site needs no extra lookup: the
			// listUserAccounts row already carries `id`, which is exactly that value.
			const at = await auth.api.getAccessToken({
				body: { accountId: git.id, userId: session.user.id },
				headers: hdrs,
			});
			providerToken = at.accessToken ?? null;
		}
	} catch {
		// No linked git provider / token unavailable — proceed without one.
	}

	// expires_at goes into BOTH values and the conflict update: writing it only on insert
	// would leave a returning user re-approving the same code on their original (stale)
	// deadline, and their login would fail.
	const expiresAt = deviceCodeExpiresAt();
	const values = {
		device_code,
		profile_id: session.user.id,
		verification_code: providerToken,
		expires_at: expiresAt,
	};

	try {
		await db
			.insert(cliLogins)
			.values(values)
			.onConflictDoUpdate({
				target: cliLogins.device_code,
				set: {
					profile_id: values.profile_id,
					verification_code: values.verification_code,
					expires_at: values.expires_at,
				},
				// Closes the race between the SELECT above and this write: only an unowned
				// row, or one already ours, may be re-bound.
				setWhere: or(
					isNull(cliLogins.profile_id),
					eq(cliLogins.profile_id, session.user.id),
				),
			});
	} catch (err) {
		console.error("Error saving CLI login attempt:", err);
		return fail("Failed to save login attempt", 500);
	}

	// The conflict update is a no-op when setWhere does not match, so confirm the row
	// really is ours before telling the browser the device is approved.
	const [bound] = await db
		.select({ profile_id: cliLogins.profile_id })
		.from(cliLogins)
		.where(
			and(
				eq(cliLogins.device_code, device_code),
				eq(cliLogins.profile_id, session.user.id),
			),
		)
		.limit(1);

	if (!bound) {
		return fail("This login request belongs to another account", 409);
	}

	return NextResponse.json({ success: true });
}
