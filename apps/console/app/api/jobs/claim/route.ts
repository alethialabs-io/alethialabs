// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	connectorCredentials,
	connectors,
	type Job,
	runners,
} from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto/secrets";
import { verifyRunnerToken } from "@/lib/runners/auth";
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Extracts the pluggable provider slugs a job's spec references, from the
 * identifier-only config_snapshot (dns/secrets/registry/observability). Returns
 * the unique non-native slugs so we know which credentials to attach.
 */
function referencedConnectorSlugs(snapshot: unknown): string[] {
	const slugs = new Set<string>();
	const add = (v: unknown) => {
		if (typeof v === "string" && v && v !== "native") slugs.add(v);
	};
	if (snapshot && typeof snapshot === "object") {
		const s = snapshot as Record<string, unknown>;
		const dns = s.dns as Record<string, unknown> | undefined;
		add(dns?.provider);
		const obs = s.observability as Record<string, unknown> | undefined;
		add(obs?.provider);
		for (const key of ["secrets", "container_registries"]) {
			const arr = s[key];
			if (Array.isArray(arr)) {
				for (const item of arr) {
					if (item && typeof item === "object") {
						add((item as Record<string, unknown>).provider);
					}
				}
			}
		}
	}
	return [...slugs];
}

export async function POST(req: Request) {
	const { runnerId, tokenHash, error: authError } =
		await verifyRunnerToken(req);
	if (authError) return authError;

	try {
		const db = getServiceDb();

		const [runner] = await db
			.select({ cloud_identity_id: runners.cloud_identity_id })
			.from(runners)
			.where(eq(runners.id, runnerId))
			.limit(1);

		// claim_next_job returns SETOF jobs — typed via the execute generic.
		const claimed = await db.execute<Job>(
			sql`select * from claim_next_job(${runnerId}::uuid, ${tokenHash}, ${runner?.cloud_identity_id ?? null}::uuid)`,
		);

		const job = claimed[0];
		if (!job) {
			return NextResponse.json({ job: null });
		}

		let cloud_identity = null;
		if (job.cloud_identity_id) {
			const [identity] = await db
				.select({
					credentials: cloudIdentities.credentials,
					provider: cloudIdentities.provider,
				})
				.from(cloudIdentities)
				.where(eq(cloudIdentities.id, job.cloud_identity_id))
				.limit(1);

			if (identity) {
				const c = identity.credentials;
				cloud_identity = {
					provider: identity.provider,
					role_arn: c.role_arn ?? "",
					external_id: c.external_id ?? "",
					account_id: c.account_id ?? "",
					project_id: c.project_id ?? "",
					service_account_email: c.service_account_email ?? "",
					wif_config: c.wif_config ? JSON.stringify(c.wif_config) : "",
					tenant_id: c.tenant_id ?? "",
					client_id: c.client_id ?? "",
					subscription_id: c.subscription_id ?? "",
				};
			}
		}

		// Attach decrypted api_key credentials for the pluggable providers this
		// spec references. Secrets live only here (claim time) — never in the
		// snapshot. Decryption failures degrade gracefully (the runner's Validate
		// surfaces the missing credential) rather than failing the whole claim.
		const connector_credentials: Array<{
			category: string;
			slug: string;
			credentials: Record<string, string>;
		}> = [];
		const slugs = referencedConnectorSlugs(job.config_snapshot);
		if (slugs.length > 0 && job.user_id) {
			const rows = await db
				.select({
					slug: connectors.slug,
					category: connectors.category,
					credentials: connectorCredentials.credentials,
				})
				.from(connectorCredentials)
				.innerJoin(
					connectors,
					eq(connectors.id, connectorCredentials.connector_id),
				)
				.where(
					and(
						eq(connectorCredentials.user_id, job.user_id),
						inArray(connectors.slug, slugs),
					),
				);

			for (const row of rows) {
				const fields = { ...(row.credentials?.fields ?? {}) };
				try {
					if (row.credentials?.secret) {
						Object.assign(fields, decryptSecret(row.credentials.secret));
					}
				} catch (decErr) {
					console.error(
						`Failed to decrypt credential for ${row.slug}:`,
						decErr,
					);
					continue;
				}
				connector_credentials.push({
					category: row.category,
					slug: row.slug,
					credentials: fields,
				});
			}
		}

		return NextResponse.json({ job, cloud_identity, connector_credentials });
	} catch (err) {
		console.error("Claim error:", err);
		return NextResponse.json(
			{ error: "Internal Server Error" },
			{ status: 500 },
		);
	}
}
