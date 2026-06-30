// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeUserId } from "@/lib/authz/guard";
import * as conn from "@/lib/cloud-providers/connections";
import { errorResponse, resolveCliProvider } from "@/lib/cli/providers";
import { NextResponse } from "next/server";

type ConnectBody = {
	identity_id?: string;
	credentials?: {
		role_arn?: string;
		wif_config?: unknown;
		tenant_id?: string;
		client_id?: string;
		subscription_id?: string;
		api_token?: string;
		self_managed?: boolean;
	};
};

/**
 * Persists the captured cloud credentials and queues a CONNECTION_TEST job.
 * Credentials shape depends on the provider:
 *  - aws:   { role_arn }
 *  - gcp:   { wif_config }  (the WIF credential config object or JSON string)
 *  - azure: { tenant_id, client_id, subscription_id }
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { userId, scope, provider, errorResponse: authError } =
		await resolveCliProvider(req, params);
	if (authError) return authError;

	const forbid = await authorizeUserId(userId, "manage_identities", {
		type: "cloud_identity",
	});
	if (forbid) return forbid;

	let body: ConnectBody;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const identityId = body.identity_id;
	const creds = body.credentials ?? {};
	if (!identityId) {
		return NextResponse.json(
			{ error: "Missing identity_id" },
			{ status: 400 },
		);
	}

	try {
		let result: { jobId: string; identityId: string };

		switch (provider) {
			case "aws":
				if (!creds.role_arn) {
					return NextResponse.json(
						{ error: "Missing credentials.role_arn" },
						{ status: 400 },
					);
				}
				result = await conn.saveAwsIdentity(
					scope,
					identityId,
					creds.role_arn,
				);
				break;
			case "gcp": {
				if (!creds.wif_config) {
					return NextResponse.json(
						{ error: "Missing credentials.wif_config" },
						{ status: 400 },
					);
				}
				const wifJson =
					typeof creds.wif_config === "string"
						? creds.wif_config
						: JSON.stringify(creds.wif_config);
				result = await conn.saveGcpIdentity(scope, identityId, wifJson);
				break;
			}
			case "azure":
				if (
					!creds.tenant_id ||
					!creds.client_id ||
					!creds.subscription_id
				) {
					return NextResponse.json(
						{
							error: "Missing tenant_id, client_id, or subscription_id",
						},
						{ status: 400 },
					);
				}
				result = await conn.saveAzureIdentity(
					scope,
					identityId,
					creds.tenant_id,
					creds.client_id,
					creds.subscription_id,
				);
				break;
			case "alibaba":
				if (!creds.role_arn) {
					return NextResponse.json(
						{ error: "Missing credentials.role_arn" },
						{ status: 400 },
					);
				}
				result = await conn.saveAlibabaIdentity(
					scope,
					identityId,
					creds.role_arn,
				);
				break;
			case "digitalocean":
			case "hetzner":
			case "civo":
				if (creds.self_managed) {
					// Self-hosted runner supplies the token from its env — store nothing.
					result = await conn.saveSelfManagedTokenIdentity(
						scope,
						identityId,
						provider,
					);
					break;
				}
				if (!creds.api_token) {
					return NextResponse.json(
						{ error: "Missing credentials.api_token (or set self_managed: true)" },
						{ status: 400 },
					);
				}
				result = await conn.saveTokenCloudIdentity(
					scope,
					identityId,
					provider,
					creds.api_token,
				);
				break;
			default:
				return NextResponse.json(
					{ error: `Unsupported provider: ${provider}` },
					{ status: 400 },
				);
		}

		return NextResponse.json({
			job_id: result.jobId,
			identity_id: result.identityId,
		});
	} catch (err) {
		return errorResponse(err, 400);
	}
}
