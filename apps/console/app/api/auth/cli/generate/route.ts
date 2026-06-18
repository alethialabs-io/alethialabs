// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { cliLogins } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const supabase = await createClient();
	const {
		data: { session },
	} = await supabase.auth.getSession();

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

	// Provider token is temporarily stashed in verification_code (CLI device flow).
	const values = {
		device_code,
		profile_id: session.user.id,
		verification_code: session.provider_token ?? null,
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
