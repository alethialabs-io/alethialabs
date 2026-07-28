// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GCP managed-SERVICE capability enumeration (Wave-2, epic #928, lane #974). Mints a WIF token AS the
// customer (keyless, container.viewer + cloudsql.viewer) and reads what MANAGED SERVICES this project can
// launch — the service-axis twin of capabilities/gcp.ts (which does regions + machine types):
//
//   - kubernetes  GKE `getServerConfig` → the offered control-plane versions (minor grain, e.g. "1.35").
//   - database    Cloud SQL `projects.tiers.list` (account-scoped: proves the project can launch Cloud SQL)
//                 + `flags.list` (the offered DB engine versions) → one row per (engine, offered version).
//   - database_instance_class
//                 the same `tiers.list` response, read for the machine types it lists (`db-custom-2-7680`).
//                 Engine-agnostic: Cloud SQL offers tiers per project, not per engine.
//   - nosql       Firestore `databases.list` probe → Firestore availability for this project.
//   - cache       DOCUMENTED EXCLUSION: GCP exposes NO keyless per-account "list Memorystore tiers" API
//                 (the Redis API lists instances, not offered tiers; capacity tiers are a fixed pricing
//                 dimension), so the cache axis is intentionally left to fail open to the static Catalog #2
//                 (lib/queries/capabilities.ts getCacheTierCapabilities). This is an explicit per-axis gap,
//                 not a silent omission — the cloud-parity rule allows a documented exclusion.
//   - cache_version
//                 DOCUMENTED EXCLUSION, same reason: the offered Memorystore engine versions are a fixed
//                 product enum, not an account-scoped fact any read-only API reports.
//
// Account-global axes (k8s versions, DB engines, Firestore) are region-uniform on GCP and the consumer
// reads them region-agnostically (getK8sVersionCapabilities / getDatabaseCapabilities / getNosqlCapability
// never filter by region and never de-duplicate), so every service row is anchored to ONE real canonical
// region — this keeps exactly one row per (kind, native_id) (the per-region unique key never trips
// Postgres's "NULLs are distinct" rule, and the region-agnostic reads see no duplicates).
//
// Structural contract mirrors the inventory/Wave-1 lanes: best-effort — an enumeration failure never
// throws (the refresh sweep retries); availability is design-time GUIDANCE, never a hard gate (#918
// fail-open). `launchable`/`launchable_reason` are BOUNDED enums, never provider free-text.

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CapabilityLaunchable,
	type CapabilityLaunchableReason,
	type CloudCapabilityServiceInsert,
	cloudCapabilityServices,
} from "@/lib/db/schema";
import { softRemoveUnseen } from "../../inventory/upsert";
import { externalAccountClientFromWif } from "../../session/gcp";
import { dedupeVersionsDesc, sortVersionsDesc } from "./version";
import type { CapabilityIdentity, SyncServiceCapabilities } from "../types";

const TIMEOUT_MS = 15_000;
// GCP managed-service versions/engines are region-uniform; anchor the account-global rows to one real
// region so the per-region unique key holds and the region-agnostic reads don't see duplicates.
const CANONICAL_REGION = "us-central1";
const GKE = "https://container.googleapis.com/v1";
const SQLADMIN = "https://sqladmin.googleapis.com/v1";
const FIRESTORE = "https://firestore.googleapis.com/v1";

// ── Raw GCP API response shapes (only the fields we read) ────────────────────────────
interface GkeServerConfig {
	validMasterVersions?: string[];
	channels?: { channel?: string; validVersions?: string[] }[];
	defaultClusterVersion?: string;
}
interface GcpSqlTiersList {
	// `RAM` is bytes of memory for the tier; `kind` is the API's type discriminator (unread).
	items?: { tier?: string; region?: string[]; RAM?: string | number }[];
}
interface GcpSqlFlagsList {
	items?: { name?: string; appliesTo?: string[] }[];
}

/** The already-fetched inputs the pure normalizer turns into rows — so it is unit-testable without any
 * network or database (the mandated "normalizer against a recorded fixture" test drives THIS). A `null`
 * source means that call failed / was skipped; the normalizer simply emits no rows for that axis. */
export interface GcpServiceSources {
	cloudIdentityId: string;
	region: string;
	now: Date;
	k8s: GkeServerConfig | null;
	sqlTiers: GcpSqlTiersList | null;
	sqlFlags: GcpSqlFlagsList | null;
	/** Firestore reachable for this project: true = launchable, false = probe failed (not_evaluable),
	 * null = not probed (no row). */
	firestore: boolean | null;
}

/** The catalog engine value + display label for the two Cloud SQL engine families the picker models
 * (matches DB_ENGINES[gcp] so federated + fallback rows share one value space). */
const GCP_DB_ENGINES: Record<string, { value: string; label: string }> = {
	POSTGRES: { value: "cloudsql-postgresql", label: "Cloud SQL PostgreSQL" },
	MYSQL: { value: "cloudsql-mysql", label: "Cloud SQL MySQL" },
};

/** Reduce a GKE full version ("1.30.5-gke.1355000") to its MAJOR.MINOR ("1.30"); "" if it isn't one. */
function k8sMinor(full: string): string {
	const m = /^(\d+)\.(\d+)/.exec(full.trim());
	return m ? `${m[1]}.${m[2]}` : "";
}

/** Every offered GKE control-plane version, minor grain, de-duplicated and sorted high→low. Prefers
 * `validMasterVersions`; falls back to the union of the release channels' `validVersions`. */
export function offeredK8sMinors(cfg: GkeServerConfig | null): string[] {
	if (!cfg) return [];
	const raw =
		cfg.validMasterVersions && cfg.validMasterVersions.length > 0
			? cfg.validMasterVersions
			: (cfg.channels ?? []).flatMap((c) => c.validVersions ?? []);
	const minors = new Set<string>();
	for (const v of raw) {
		const minor = k8sMinor(v);
		if (minor) minors.add(minor);
	}
	return sortVersionsDesc([...minors]);
}

/** Parse a Cloud SQL databaseVersion token ("POSTGRES_16", "MYSQL_8_0") into { family, version }, or null
 * for a family the picker does not model (e.g. SQLSERVER_*). The numeric tail's underscores become dots
 * ("8_0" → "8.0"); a versionless family (none today) yields version "". */
export function parseSqlVersion(
	token: string,
): { family: string; version: string } | null {
	const idx = token.indexOf("_");
	if (idx < 0) return null;
	const family = token.slice(0, idx);
	if (!GCP_DB_ENGINES[family]) return null;
	const version = token.slice(idx + 1).replace(/_/g, ".");
	return { family, version };
}

/** EVERY offered version per Cloud SQL engine family, newest-first, from the union of every flag's
 * `appliesTo`. Keyed by the family token ("POSTGRES"/"MYSQL"); empty when flags is null/absent.
 *
 * This replaced a latest-only reduce (#1351). The version is an axis the picker offers, so collapsing
 * to the newest here made an engine-version selector impossible — and the full list was always in
 * hand, since `flags.list` returns per-FLAG rows whose `appliesTo` carries the whole version set. */
export function sqlVersionsByFamily(
	flags: GcpSqlFlagsList | null,
): Map<string, string[]> {
	const byFamily = new Map<string, string[]>();
	for (const flag of flags?.items ?? []) {
		for (const token of flag.appliesTo ?? []) {
			const parsed = parseSqlVersion(token);
			if (!parsed) continue;
			const seen = byFamily.get(parsed.family);
			if (seen) seen.push(parsed.version);
			else byFamily.set(parsed.family, [parsed.version]);
		}
	}
	for (const [family, versions] of byFamily) {
		byFamily.set(family, dedupeVersionsDesc(versions));
	}
	return byFamily;
}

/** Cloud SQL reports a tier's memory as BYTES (`RAM`), as a string on the JSON wire. Converts to GB for
 * `mem_gb`, or null when the field is absent/unparseable — an honest "not reported" rather than a 0. */
export function gbFromBytes(raw: string | number | undefined): number | null {
	const bytes = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
	if (bytes === undefined || Number.isNaN(bytes) || bytes <= 0) return null;
	return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

/** Pure: the recorded GCP API responses → the `cloud_capability_services` rows for this identity. No I/O,
 * so the normalizer is fully unit-testable. Emits kubernetes + database + nosql rows; cache is the
 * documented exclusion (see the file header). */
export function normalizeGcpServices(
	src: GcpServiceSources,
): CloudCapabilityServiceInsert[] {
	const { cloudIdentityId, region, now } = src;
	const rows: CloudCapabilityServiceInsert[] = [];
	const base = {
		cloud_identity_id: cloudIdentityId,
		provider: "gcp" as const,
		region,
		last_seen: now,
		last_synced_at: now,
		removed_at: null,
	};

	// kubernetes — every offered control-plane minor. Offered ⇒ launchable (control-plane version carries
	// no per-account quota dimension).
	for (const version of offeredK8sMinors(src.k8s)) {
		rows.push({
			...base,
			service_kind: "kubernetes",
			native_id: version,
			name: version,
			version,
			launchable: "launchable",
			launchable_reason: "available",
		});
	}

	// database — one row per (Cloud SQL engine family, offered version). `tiers.list` returning tiers
	// proves the project can launch Cloud SQL (launchable); absent tiers ⇒ availability unknown.
	// `native_id` is the composite `<engine>-<version>` because the unique key carries native_id but
	// NOT version, so per-version rows under a bare-engine id would overwrite each other. `engine` is
	// the CATALOG value (not the lowercased family) so synced rows and the static DB_ENGINES fallback
	// share one value space — otherwise the fail-open path (#918) swaps the engine identity.
	const hasTiers = (src.sqlTiers?.items ?? []).length > 0;
	const dbVerdict: {
		launchable: CapabilityLaunchable;
		reason: CapabilityLaunchableReason;
	} = hasTiers
		? { launchable: "launchable", reason: "available" }
		: { launchable: "not_evaluable", reason: "quota_unknown" };
	for (const [family, versions] of sqlVersionsByFamily(src.sqlFlags)) {
		const engine = GCP_DB_ENGINES[family];
		if (!engine) continue;
		for (const version of versions) {
			rows.push({
				...base,
				service_kind: "database",
				native_id: `${engine.value}-${version}`,
				name: engine.label,
				engine: engine.value,
				version,
				launchable: dbVerdict.launchable,
				launchable_reason: dbVerdict.reason,
			});
		}
	}

	// database_instance_class — the SAME `tiers.list` response, read for what it lists rather than only
	// whether it was non-empty. Its items ARE the Cloud SQL machine types (`db-custom-2-7680`,
	// `db-n1-standard-1`), which is what the canvas's `instance_class` box asked the user to type.
	//
	// `engine` is NULL: a Cloud SQL tier is offered per PROJECT, not per engine — the API says nothing
	// about which engine a tier belongs to, and inventing a per-engine split would be a wrong verdict.
	// The reader treats a NULL engine as "offerable for every engine".
	//
	// CUSTOM machine types (`db-custom-<vCPU>-<MB>`) are constructible beyond what `tiers.list` returns;
	// the picker keeps a pinned value representable (`withSelected`), so a custom tier already in the
	// config survives even though it is not in this list.
	for (const item of src.sqlTiers?.items ?? []) {
		const tier = item.tier?.trim();
		if (!tier) continue;
		rows.push({
			...base,
			service_kind: "database_instance_class",
			native_id: tier,
			name: tier,
			// Explicitly null, not merely absent: "offerable for every engine" is a claim this lane
			// makes on purpose, and the reader keys on it.
			engine: null,
			tier,
			mem_gb: gbFromBytes(item.RAM),
			launchable: "launchable",
			launchable_reason: "available",
		});
	}

	// cache_version — DOCUMENTED EXCLUSION, for the same reason as the cache tier axis: there is no
	// keyless per-account API that lists the Memorystore engine versions a project may launch (the Redis
	// API lists INSTANCES, and the supported versions are a fixed product enum, not an account fact).
	// The picker falls open to the cloud default rather than inventing a per-account answer.

	// nosql — Firestore is a GCP-wide offering; the probe distinguishes "confirmed reachable" (launchable)
	// from "couldn't verify" (not_evaluable). Both keep the picker's `available` true (only not_launchable
	// flips it); a null probe emits no row (fail-open to static).
	if (src.firestore !== null) {
		rows.push({
			...base,
			service_kind: "nosql",
			native_id: "Firestore",
			name: "Firestore",
			launchable: src.firestore ? "launchable" : "not_evaluable",
			launchable_reason: src.firestore ? "available" : "quota_unknown",
		});
	}

	return rows;
}

/** Mints a GCP access token from the connection's stored WIF config, or throws (caught by the caller). */
async function gcpToken(identity: CapabilityIdentity): Promise<string> {
	const wif = identity.credentials.wif_config;
	if (!wif) throw new Error("No GCP WIF config");
	const client = externalAccountClientFromWif(wif);
	if (!client) throw new Error("Retired AWS-hub GCP setup — reconnect it.");
	const at = await client.getAccessToken();
	if (!at.token) throw new Error("GCP token acquisition returned no token");
	return at.token;
}

/** Best-effort authenticated GET: parsed JSON on 2xx, else null (a per-axis failure must not fail the
 * whole sync — the other axes still populate, and the refresh sweep retries). */
async function gcpGetOptional<T>(url: string, token: string): Promise<T | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Whether the Firestore Databases API answers for this project (2xx even with zero databases ⇒ the
 * service is reachable). null when the request errored (inconclusive → no row, fail-open). */
async function firestoreReachable(
	projectId: string,
	token: string,
): Promise<boolean | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(
			`${FIRESTORE}/projects/${projectId}/databases`,
			{ headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
		);
		return res.ok;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Enumerate this GCP project's launchable managed services into `cloud_capability_services`. Best-effort:
 * never throws (the services dispatcher also guards, and the refresh sweep retries). */
export const syncGcpServiceCapabilities: SyncServiceCapabilities = async (
	identity: CapabilityIdentity,
): Promise<void> => {
	const projectId = identity.credentials.project_id;
	if (!projectId) return;
	const token = await gcpToken(identity);

	// Fetch each axis independently and best-effort — one failing source never blocks the others.
	const [k8s, sqlTiers, sqlFlags, firestore] = await Promise.all([
		gcpGetOptional<GkeServerConfig>(
			`${GKE}/projects/${projectId}/locations/${CANONICAL_REGION}/serverConfig`,
			token,
		),
		gcpGetOptional<GcpSqlTiersList>(
			`${SQLADMIN}/projects/${projectId}/tiers`,
			token,
		),
		gcpGetOptional<GcpSqlFlagsList>(`${SQLADMIN}/flags`, token),
		firestoreReachable(projectId, token),
	]);

	const rows = normalizeGcpServices({
		cloudIdentityId: identity.id,
		region: CANONICAL_REGION,
		now: new Date(),
		k8s,
		sqlTiers,
		sqlFlags,
		firestore,
	});

	const db = getServiceDb();
	if (rows.length > 0) {
		await db
			.insert(cloudCapabilityServices)
			.values(rows)
			.onConflictDoUpdate({
				target: [
					cloudCapabilityServices.cloud_identity_id,
					cloudCapabilityServices.provider,
					cloudCapabilityServices.region,
					cloudCapabilityServices.service_kind,
					cloudCapabilityServices.native_id,
				],
				set: {
					name: sql`excluded.name`,
					engine: sql`excluded.engine`,
					version: sql`excluded.version`,
					tier: sql`excluded.tier`,
					mem_gb: sql`excluded.mem_gb`,
					launchable: sql`excluded.launchable`,
					launchable_reason: sql`excluded.launchable_reason`,
					last_seen: sql`excluded.last_seen`,
					last_synced_at: sql`excluded.last_synced_at`,
					removed_at: sql`excluded.removed_at`,
				},
			});
	}
	// Soft-remove any offering (across all kinds) this pass no longer saw — but ONLY when we actually
	// reached GCP. On a total outage (every source null ⇒ no rows) we must NOT nuke the last-good catalog;
	// leaving it intact keeps the pickers account-accurate until the refresh sweep succeeds.
	const reachedGcp =
		k8s !== null || sqlTiers !== null || sqlFlags !== null || firestore !== null;
	if (reachedGcp) {
		await softRemoveUnseen(
			"cloud_capability_services",
			identity.id,
			rows.map((r) => r.native_id),
		);
	}
};
