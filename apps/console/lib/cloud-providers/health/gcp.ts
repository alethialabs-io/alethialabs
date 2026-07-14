// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GCP health — server-side. The customer's stored Workload Identity Federation config trusts Alethia's
// identity; google-auth-library mints an access token from it, then a cheap Compute "list regions" call
// proves access to the project, then a capability probe surfaces DEGRADED when the service account
// can't see what we provision into (parity with the AWS/Alibaba probes). NOTE: token minting needs
// Alethia's OIDC subject-token source (present in a hosted/staging env, not local dev) — otherwise it
// returns a clear DISCONNECTED reason instead of a 5-min timeout.

import type { CloudIdentity } from "@/lib/db/schema";
import { externalAccountClientFromWif } from "../session/gcp";
import { type HealthResult, errorMessage } from "./types";

const TIMEOUT_MS = 12_000;

function disconnected(error: string): HealthResult {
	return { status: "disconnected", accountId: null, error, missingPermissions: [] };
}

/**
 * Representative reads proving the federated service account can see what our templates provision.
 * Read-only and cheap — this is a health check, not an audit; write permissions are only truly proven
 * by a real provision.
 */
const CAPABILITY_PROBES: {
	permission: string;
	/** The GCP service this read belongs to — named when the API itself is switched off. */
	service: string;
	url: (project: string) => string;
}[] = [
	{
		permission: "compute.networks.list",
		service: "compute.googleapis.com",
		url: (p) => `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks`,
	},
	{
		permission: "container.clusters.list",
		service: "container.googleapis.com",
		url: (p) => `https://container.googleapis.com/v1/projects/${p}/locations/-/clusters`,
	},
	{
		permission: "cloudsql.instances.list",
		service: "sqladmin.googleapis.com",
		url: (p) => `https://sqladmin.googleapis.com/v1/projects/${p}/instances`,
	},
];

/**
 * Classifies a denied GCP read. A 403 is overloaded: it means EITHER the principal lacks the
 * permission OR the API is simply not enabled on the project (`SERVICE_DISABLED`). Those need
 * different fixes — widen the role vs `gcloud services enable` — so we must not collapse them into
 * one "missing permission", which would send the operator down the wrong path entirely.
 */
function classifyDenial(
	body: string,
	probe: (typeof CAPABILITY_PROBES)[number],
): string {
	return /SERVICE_DISABLED|has not been used in project|is disabled/i.test(body)
		? `${probe.service} (API not enabled)`
		: probe.permission;
}

/** Probes a GCP connection via its WIF config: mint a token, list the project's compute regions, then
 * probe the reads our templates need (DEGRADED when denied). Never throws. */
export async function probeGcpHealth(
	identity: Pick<CloudIdentity, "credentials">,
): Promise<HealthResult> {
	const wif = identity.credentials.wif_config;
	const projectId = identity.credentials.project_id;
	if (!wif) return disconnected("This GCP connection has no Workload Identity config.");
	if (!projectId) return disconnected("This GCP connection has no project id.");

	let token: string;
	try {
		// Direct-OIDC: the client mints its own subject token (no AWS). A retired AWS-hub config yields no
		// client — it must be re-connected.
		const client = externalAccountClientFromWif(wif);
		if (!client)
			return disconnected(
				"This GCP connection uses the retired AWS-hub setup. Reconnect it (Connectors → GCP) to migrate to direct-OIDC.",
			);
		const at = await client.getAccessToken();
		if (!at.token) return disconnected("GCP token acquisition returned no token.");
		token = at.token;
	} catch (e) {
		return disconnected(`GCP authentication failed: ${errorMessage(e)}`);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const get = (url: string) =>
		fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});

	try {
		// 1) Project access — the authoritative proof the federated identity can reach the project.
		const res = await get(
			`https://compute.googleapis.com/compute/v1/projects/${projectId}/regions`,
		);
		if (!res.ok) {
			if (res.status === 401 || res.status === 403) {
				return {
					status: "disconnected",
					accountId: projectId,
					error: `Access to project ${projectId} was denied (HTTP ${res.status}).`,
					missingPermissions: [],
				};
			}
			return disconnected(`GCP Compute API returned HTTP ${res.status}.`);
		}

		// 2) Capability probe → DEGRADED when a representative read is denied. Only a denial counts; a
		// transient/network error must not flap a working connection.
		const missingPermissions: string[] = [];
		for (const probe of CAPABILITY_PROBES) {
			try {
				const probeRes = await get(probe.url(projectId));
				if (probeRes.status === 401 || probeRes.status === 403) {
					missingPermissions.push(
						classifyDenial(await probeRes.text().catch(() => ""), probe),
					);
				}
			} catch {
				// Transient/aborted — ignore.
			}
		}

		return {
			status: missingPermissions.length > 0 ? "degraded" : "connected",
			accountId: projectId,
			error: null,
			missingPermissions,
		};
	} catch (e) {
		return disconnected(errorMessage(e));
	} finally {
		clearTimeout(timer);
	}
}
