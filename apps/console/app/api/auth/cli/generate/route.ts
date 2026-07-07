// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getServiceDb } from "@/lib/db";
import { cliLogins } from "@/lib/db/schema";
import { NextResponse } from "next/server";

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"];

export async function POST(req: Request) {
	const hdrs = await headers();
	const session = await auth.api.getSession({ headers: hdrs });

	if (!session) {
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	const { device_code } = await req.json();
	if (!device_code) {
		return new Response(JSON.stringify({ error: "Missing device_code" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Best-effort: stash the user's first linked git provider token for the CLI
	// (temporarily held in verification_code, during the device-code flow).
	let providerToken: string | null = null;
	try {
		const accounts = await auth.api.listUserAccounts({ headers: hdrs });
		const git = accounts.find((a) => GIT_PROVIDERS.includes(a.providerId));
		if (git) {
			const at = await auth.api.getAccessToken({
				body: { providerId: git.providerId, userId: session.user.id },
				headers: hdrs,
			});
			providerToken = at.accessToken ?? null;
		}
	} catch {
		// No linked git provider / token unavailable — proceed without one.
	}

	const values = {
		device_code,
		profile_id: session.user.id,
		verification_code: providerToken,
	};

	try {
		await getServiceDb()
			.insert(cliLogins)
			.values(values)
			.onConflictDoUpdate({
				target: cliLogins.device_code,
				set: {
					profile_id: values.profile_id,
					verification_code: values.verification_code,
				},
			});
	} catch (err) {
		console.error("Error saving CLI login attempt:", err);
		return new Response(
			JSON.stringify({ error: "Failed to save login attempt" }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}

	return NextResponse.json({ success: true });
}
