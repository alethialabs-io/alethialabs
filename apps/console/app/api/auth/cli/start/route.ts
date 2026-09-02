// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, isNull, lt } from "drizzle-orm";
import {
	CLI_DEVICE_START_RATE_LIMIT,
	clientMetadataField,
	deviceCodeFail,
	isValidDeviceCode,
	isValidUserCode,
	PENDING_DEVICE_CODE_TTL_MS,
	pendingDeviceCodeExpiresAt,
} from "@/lib/auth/cli-device-code";
import { cliDeviceRateLimitKey, trustedClientIp } from "@/lib/auth/trusted-ip";
import { getServiceDb } from "@/lib/db";
import { cliLogins } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextResponse } from "next/server";
import type { CliDeviceClientMetadata } from "@/types/jsonb.types";

/**
 * Registers a pending CLI device request — the server half of `alethia login`'s first
 * moment, before any browser is involved.
 *
 * Two things did not exist before this route. The `user_code` was client-minted, put in the
 * link, shape-checked by `/generate` and never compared against anything, so the code on the
 * consent screen carried no server-verified meaning. And nothing at all was known about the
 * requester, so `/cli/login` could say only "A device is asking to sign in to your account"
 * while approval hands over an access token, a 90-day refresh token and the raw OAuth token
 * of the first linked git provider. Registering here is what gives the consent screen
 * something to consent to.
 *
 * It is deliberately UNAUTHENTICATED: the process calling it is a terminal that has, by
 * definition, no session yet. It therefore gets the tightest rate-limit budget of the five
 * routes and it is INSERT-ONLY — see the conflict handling below.
 */
export async function POST(req: Request) {
	const limitKey = cliDeviceRateLimitKey("start", req.headers);
	if (
		limitKey &&
		!checkRateLimit(
			limitKey,
			CLI_DEVICE_START_RATE_LIMIT.limit,
			CLI_DEVICE_START_RATE_LIMIT.windowMs,
		).ok
	) {
		return deviceCodeFail("Too many requests", 429);
	}

	const body = await req.json().catch(() => null);
	const device_code = body?.device_code;
	const user_code = body?.user_code;

	if (!isValidDeviceCode(device_code)) {
		return deviceCodeFail("Missing or malformed device_code", 400);
	}
	if (!isValidUserCode(user_code)) {
		return deviceCodeFail("Missing or malformed user_code", 400);
	}

	// Everything the client says about itself is untrusted — it arrives here from a process
	// nobody has authenticated. Normalised and length-bounded so it can be RENDERED on a
	// consent screen without pushing the buttons off the page.
	const client_metadata: CliDeviceClientMetadata = {
		client_name: clientMetadataField(body?.client_name),
		client_version: clientMetadataField(body?.client_version),
		user_agent: clientMetadataField(req.headers.get("user-agent")),
	};

	const db = getServiceDb();
	const pendingExpiresAt = pendingDeviceCodeExpiresAt();

	// Sweep the undecided and refused rows this route is the sole source of, before adding
	// another. They carry `request_ip` — personal data — and, unlike an approved row, no
	// profile_id, so the subject-erasure plan (lib/privacy/erasure-plan.ts, which matches
	// cli_logins rows by subject) cannot reach them and nothing else deletes them either:
	// before this table only ever held approved rows, and the exchange's claiming DELETE
	// removed each one as it was redeemed. Bounded by `created_at` rather than
	// `pending_expires_at` so it also collects a denial marker, whose window is over by
	// definition. `profile_id IS NULL` keeps it away from every approved row.
	//
	// Opportunistic and best-effort: a failure here must not stop somebody logging in.
	try {
		await db
			.delete(cliLogins)
			.where(
				and(
					isNull(cliLogins.profile_id),
					lt(
						cliLogins.created_at,
						new Date(Date.now() - PENDING_DEVICE_CODE_TTL_MS),
					),
				),
			);
	} catch (err) {
		console.error("Error sweeping stale CLI login requests:", err);
	}

	try {
		// INSERT-ONLY. `onConflictDoNothing` is the whole safety property of this route: an
		// unauthenticated caller must never be able to overwrite a device_code that already
		// exists, because that row may already be approved (its profile_id names a real
		// account) or denied (its denied_at is a refusal somebody made). An upsert here
		// would let anyone who learns a device_code reset a refusal, or repoint an approved
		// request's displayed metadata after the fact.
		await db
			.insert(cliLogins)
			.values({
				device_code,
				user_code,
				client_metadata,
				request_ip: trustedClientIp(req.headers),
				pending_expires_at: pendingExpiresAt,
			})
			.onConflictDoNothing({ target: cliLogins.device_code });
	} catch (err) {
		console.error("Error registering CLI login request:", err);
		return deviceCodeFail("Failed to register login request", 500);
	}

	// The insert is silent about whether it did anything, so read the row back and confirm
	// the registration that is actually stored is OURS. A retried registration (same device
	// code, same user code) is idempotent and answers 200; a device_code already carrying a
	// DIFFERENT user_code is refused rather than reported as registered, because the caller
	// would otherwise print a code the server will never accept.
	const [stored] = await db
		.select({ user_code: cliLogins.user_code })
		.from(cliLogins)
		.where(eq(cliLogins.device_code, device_code))
		.limit(1);

	// Compared here directly rather than through `checkUserCodeBinding`, and the difference
	// matters: that predicate is deliberately PERMISSIVE about a missing row and a NULL
	// stored code, because approve/deny/read must keep working for CLIs too old to register.
	// This route is the one place where the requirement is the strict one — it has just
	// claimed to have stored a binding, so "no row" and "a row with no code" are both
	// failures to have done the thing it is about to report as done, not shrugs.
	if (!stored) {
		console.error("CLI login registration wrote no row for a device code");
		return deviceCodeFail("Failed to register login request", 500);
	}
	if (stored.user_code !== user_code) {
		return deviceCodeFail("This device code is already registered", 409);
	}

	return NextResponse.json({
		expires_in: Math.floor(PENDING_DEVICE_CODE_TTL_MS / 1000),
		interval: 2,
	});
}
