// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	connectorCredentials,
	connectors,
	jobs,
	runners,
} from "@/lib/db/schema";
import { markFailed } from "@/lib/connectors/health";
import { decryptSecret } from "@/lib/crypto/secrets";
import { verifyRunnerToken } from "@/lib/runners/auth";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Extracts the pluggable provider slugs a job's project references, from the
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

		// claim_next_job atomically claims + returns the row, but raw execute over the
		// prepare:false client yields Postgres-format timestamp strings the runner can't
		// decode (it wants RFC3339). Use it only for the id, then re-read via a typed
		// select so Drizzle maps timestamptz → Date → ISO in the JSON response.
		const claimed = await db.execute<{ id: string }>(
			sql`select id from claim_next_job(${runnerId}::uuid, ${tokenHash}, ${runner?.cloud_identity_id ?? null}::uuid)`,
		);

		const claimedId = claimed[0]?.id;
		if (!claimedId) {
			return NextResponse.json({ job: null });
		}

		const [job] = await db
			.select()
			.from(jobs)
			.where(eq(jobs.id, claimedId))
			.limit(1);
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
				// Token clouds (DigitalOcean/Hetzner/Civo) store the token encrypted;
				// decrypt it here so the plaintext only ever leaves to the runner.
				let apiToken = "";
				if (c.token) {
					try {
						apiToken = decryptSecret(c.token).api_token ?? "";
					} catch (e) {
						console.error(
							`Failed to decrypt cloud token for identity ${job.cloud_identity_id}:`,
							e,
						);
					}
				}
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
					api_token: apiToken,
					// Self-managed: no token stored here; the self-hosted runner reads it
					// from its own env (HCLOUD_TOKEN / CIVO_TOKEN / DIGITALOCEAN_ACCESS_TOKEN).
					self_managed: c.self_managed ?? false,
				};
			}
		}

		// Attach decrypted api_key credentials for the pluggable providers this
		// project references. Secrets live only here (claim time) — never in the
		// snapshot. Decryption failures degrade gracefully (the runner's Validate
		// surfaces the missing credential) rather than failing the whole claim.
		const connector_credentials: Array<{
			category: string;
			slug: string;
			credentials: Record<string, string>;
		}> = [];
		const slugs = referencedConnectorSlugs(job.config_snapshot);
		if (slugs.length > 0 && job.user_id) {
			// The runner may use the job creator's PERSONAL credential or one shared with
			// the job's ORG. Fetch both; dedupe per slug preferring the creator's personal.
			const rows = await db
				.select({
					slug: connectors.slug,
					category: connectors.category,
					credentials: connectorCredentials.credentials,
					scope: connectorCredentials.scope,
				})
				.from(connectorCredentials)
				.innerJoin(
					connectors,
					eq(connectors.id, connectorCredentials.connector_id),
				)
				.where(
					and(
						inArray(connectors.slug, slugs),
						// Creator's personal credential, plus the org's shared one when the job
						// carries an org (org_id is nullable on legacy/community rows).
						job.org_id
							? or(
									and(
										eq(connectorCredentials.user_id, job.user_id),
										eq(connectorCredentials.scope, "personal"),
									),
									and(
										eq(connectorCredentials.org_id, job.org_id),
										eq(connectorCredentials.scope, "org"),
									),
								)
							: and(
									eq(connectorCredentials.user_id, job.user_id),
									eq(connectorCredentials.scope, "personal"),
								),
					),
				);

			// Personal first so a creator's own credential wins over the shared one.
			rows.sort((a, b) => (a.scope === "personal" ? -1 : 1));
			const seen = new Set<string>();
			for (const row of rows) {
				if (seen.has(row.slug)) continue;
				seen.add(row.slug);
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
					// Durable connector health: a credential the runner can't use is a
					// real, point-of-use failure → emit system.connector.token_failed once.
					if (job.user_id) {
						void markFailed(
							{ userId: job.user_id, orgId: job.org_id ?? job.user_id },
							"api_key",
							row.slug,
							"credential could not be decrypted",
						);
					}
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
