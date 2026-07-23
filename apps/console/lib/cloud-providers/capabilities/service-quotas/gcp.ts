// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GCP service-quota headroom enumeration (Wave-2 quota axis, epic #928, #981). Authenticates AS the
// customer's workload-identity-federated service account (keyless, session/gcp) and reads the Compute
// quotas — each `{metric, limit, usage}` — from the classic Compute REST API. GCP reports usage, so
// `used`/`available` are populated. Regional metrics come from `regions.list` (per region), global
// metrics from `projects.get` (stored with region = "global", since they have no region). Best-effort:
// never throws; a failing call is skipped.
//
// DOCUMENTED per-cloud parity gaps (cloud parity is a hard rule — explicit, not silent):
//   - nat_gateway: Cloud NAT gateways are NOT a Compute quota metric (bounded per Cloud Router, not
//     surfaced in the quotas[] arrays) → not read-obtainable here, emitted as no row.
//   - load_balancer: GCP has no single "load balancers per region" count; FORWARDING_RULES (the classic
//     global metric) is the closest read-only proxy. Newer per-region LB metrics live only in the Cloud
//     Quotas API (a separate wiring).

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CapabilityQuotaKind,
	cloudCapabilityQuotas,
} from "@/lib/db/schema";
import { softRemoveUnseen } from "../../inventory/upsert";
import { externalAccountClientFromWif } from "../../session/gcp";
import type { CapabilityIdentity } from "../types";

const COMPUTE = "https://compute.googleapis.com/compute/v1";
const TIMEOUT_MS = 15_000;
const GLOBAL_REGION = "global";

// Regional Compute quota metrics (from regions.list) → the kind they measure.
const GCP_REGIONAL_METRICS: Record<string, CapabilityQuotaKind> = {
	STATIC_ADDRESSES: "elastic_ip", // reserved static regional external IPs
};
// Global Compute quota metrics (from projects.get) → the kind they measure. Firewall rules are GCP's
// security-group equivalent and are a GLOBAL quota; FORWARDING_RULES is the classic global LB proxy.
const GCP_GLOBAL_METRICS: Record<string, CapabilityQuotaKind> = {
	FIREWALLS: "security_group",
	FORWARDING_RULES: "load_balancer",
};

/** A quota row before identity/timestamps are attached — the pure normalizer output (testable). */
export interface NormalizedQuota {
	region: string;
	quota_kind: CapabilityQuotaKind;
	native_id: string;
	name: string;
	quota_limit: number | null;
	used: number | null;
	available: number | null;
}

interface GcpQuota {
	metric?: string;
	limit?: number;
	usage?: number;
}

/** Maps a Compute `quotas[]` array to headroom rows for the metrics in `metricMap`, tagged with `region`
 * (a real region code, or "global" for project-scoped metrics). `available` = limit − usage. Pure. */
export function normalizeGcpQuotas(
	region: string,
	quotas: GcpQuota[],
	metricMap: Record<string, CapabilityQuotaKind>,
): NormalizedQuota[] {
	const out: NormalizedQuota[] = [];
	for (const q of quotas) {
		const metric = q.metric;
		if (!metric) continue;
		const kind = metricMap[metric];
		if (!kind) continue;
		const limit = typeof q.limit === "number" ? q.limit : null;
		const used = typeof q.usage === "number" ? q.usage : null;
		out.push({
			region,
			quota_kind: kind,
			native_id: metric,
			name: metric,
			quota_limit: limit,
			used,
			available: limit !== null && used !== null ? limit - used : null,
		});
	}
	return out;
}

/** Acquires a GCP access token for the WIF service account (keyless), or throws. */
async function gcpToken(identity: CapabilityIdentity): Promise<string> {
	const wif = identity.credentials.wif_config;
	if (!wif) throw new Error("no WIF config on identity");
	const client = externalAccountClientFromWif(wif);
	if (!client) throw new Error("WIF config is not usable (retired hub)");
	const t = await client.getAccessToken();
	if (!t?.token) throw new Error("GCP token acquisition returned no token");
	return t.token;
}

/** A single Compute REST GET with an abort timeout; throws on a non-2xx. */
async function gcpGet<T>(url: string, token: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`GCP compute HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

/** Enumerates this project's Compute quota headroom into `cloud_capability_quotas` (regional IP metrics
 * per region + global firewall/forwarding-rule metrics). Best-effort — never throws. */
export async function syncGcpQuotaCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const projectId = identity.credentials.project_id;
	if (!projectId) return;

	let token: string;
	try {
		token = await gcpToken(identity);
	} catch {
		return;
	}
	const db = getServiceDb();
	const identityId = identity.id;

	const now = new Date();
	const seen: string[] = [];
	const allRows: NormalizedQuota[] = [];

	// Regional metrics — regions.list returns every region with its quotas[] embedded (one call).
	try {
		const resp = await gcpGet<{ items?: { name?: string; quotas?: GcpQuota[] }[] }>(
			`${COMPUTE}/projects/${projectId}/regions`,
			token,
		);
		for (const region of resp.items ?? []) {
			if (!region.name) continue;
			allRows.push(
				...normalizeGcpQuotas(region.name, region.quotas ?? [], GCP_REGIONAL_METRICS),
			);
		}
	} catch {
		// Regional quotas unreadable — fall through to the global pass.
	}

	// Global metrics — projects.get carries the project-wide quotas[] (firewalls, forwarding rules).
	try {
		const proj = await gcpGet<{ quotas?: GcpQuota[] }>(
			`${COMPUTE}/projects/${projectId}`,
			token,
		);
		allRows.push(
			...normalizeGcpQuotas(GLOBAL_REGION, proj.quotas ?? [], GCP_GLOBAL_METRICS),
		);
	} catch {
		// Global quotas unreadable — keep whatever regional rows we gathered.
	}

	if (allRows.length === 0) return;

	const insertRows = allRows.map((r) => {
		seen.push(r.native_id);
		return {
			cloud_identity_id: identityId,
			provider: "gcp" as const,
			region: r.region,
			native_id: r.native_id,
			name: r.name,
			quota_kind: r.quota_kind,
			quota_limit: r.quota_limit,
			used: r.used,
			available: r.available,
			last_seen: now,
			last_synced_at: now,
			removed_at: null,
		};
	});

	await db
		.insert(cloudCapabilityQuotas)
		.values(insertRows)
		.onConflictDoUpdate({
			target: [
				cloudCapabilityQuotas.cloud_identity_id,
				cloudCapabilityQuotas.provider,
				cloudCapabilityQuotas.region,
				cloudCapabilityQuotas.quota_kind,
				cloudCapabilityQuotas.native_id,
			],
			set: {
				name: sql`excluded.name`,
				quota_limit: sql`excluded.quota_limit`,
				used: sql`excluded.used`,
				available: sql`excluded.available`,
				last_seen: sql`excluded.last_seen`,
				last_synced_at: sql`excluded.last_synced_at`,
				removed_at: sql`excluded.removed_at`,
			},
		});

	await softRemoveUnseen("cloud_capability_quotas", identityId, seen);
}
