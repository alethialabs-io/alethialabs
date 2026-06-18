// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import * as jose from "jose";
import { env } from "next-runtime-env";
import { getServiceDb } from "@/lib/db";
import { cliLogins, profiles } from "@/lib/db/schema";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const { device_code } = await req.json();

	if (!device_code) {
		return new Response(JSON.stringify({ error: "Missing device_code" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const db = getServiceDb();

	// 1. Find the approved login record (profile_id present signifies approval).
	const [loginData] = await db
		.select({
			profile_id: cliLogins.profile_id,
			verification_code: cliLogins.verification_code,
			email: profiles.email,
		})
		.from(cliLogins)
		.leftJoin(profiles, eq(cliLogins.profile_id, profiles.id))
		.where(eq(cliLogins.device_code, device_code))
		.limit(1);

	if (!loginData?.profile_id) {
		return new Response(
			JSON.stringify({ error: "Authentication pending or not found" }),
			{
				status: 404,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	// Clean up the used record
	await db.delete(cliLogins).where(eq(cliLogins.device_code, device_code));

	// 2. Ensure the JWT secret is set
	const jwtSecret = env("CLI_JWT_SECRET");
	if (!jwtSecret) {
		console.error("CLI_JWT_SECRET is not set in environment variables.");
		return new Response(
			JSON.stringify({ error: "Internal server configuration error" }),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	// 3. Create a new custom JWT for the CLI
	const secret = new TextEncoder().encode(jwtSecret);
	const alg = "HS256";

	const accessToken = await new jose.SignJWT({
		sub: loginData.profile_id,
		email: loginData.email,
		type: "access",
	})
		.setProtectedHeader({ alg })
		.setIssuedAt()
		.setIssuer("urn:example:issuer")
		.setAudience("urn:example:audience")
		.setExpirationTime("1h")
		.sign(secret);

	const refreshToken = await new jose.SignJWT({
		sub: loginData.profile_id,
		email: loginData.email,
		type: "refresh",
	})
		.setProtectedHeader({ alg })
		.setIssuedAt()
		.setIssuer("urn:example:issuer")
		.setAudience("urn:example:audience")
		.setExpirationTime("90d")
		.sign(secret);

	return NextResponse.json({
		access_token: accessToken,
		refresh_token: refreshToken,
		provider_token: loginData.verification_code,
		user_email: loginData.email,
	});
}
