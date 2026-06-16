// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as jose from "jose";
import { env } from "next-runtime-env";

export async function verifyCliToken(req: Request) {
	const authHeader = req.headers.get("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return {
			error: new Response(
				JSON.stringify({ error: "Unauthorized: Missing token" }),
				{ status: 401 },
			),
			payload: null,
		};
	}

	const token = authHeader.substring(7);
	const jwtSecret = env("CLI_JWT_SECRET");
	if (!jwtSecret) {
		console.error("CLI_JWT_SECRET is not set.");
		return {
			error: new Response(
				JSON.stringify({
					error: "Internal server configuration error",
				}),
				{ status: 500 },
			),
			payload: null,
		};
	}

	try {
		const secret = new TextEncoder().encode(jwtSecret);
		const { payload } = await jose.jwtVerify(token, secret, {
			issuer: "urn:example:issuer",
			audience: "urn:example:audience",
		});

		if (payload.type !== "access") {
			return {
				error: new Response(
					JSON.stringify({
						error: "Unauthorized: Invalid token type",
					}),
					{ status: 401 },
				),
				payload: null,
			};
		}

		return { payload, error: null };
	} catch (err) {
		return {
			error: new Response(
				JSON.stringify({ error: "Unauthorized: Invalid token" }),
				{ status: 401 },
			),
			payload: null,
		};
	}
}
