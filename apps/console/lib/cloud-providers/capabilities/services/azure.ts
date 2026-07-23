// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure managed-SERVICE capability enumeration (Wave-2, epic #928, lane #973). Authenticates AS the
// customer's managed identity (keyless, via session/azure) and reads what managed services THIS
// subscription can launch, per location, into `cloud_capability_services`:
//   - kubernetes — AKS offered control-plane versions (ContainerService ListKubernetesVersions).
//   - database   — Azure Database for PostgreSQL/MySQL Flexible Server offered engine VERSIONS
//                  (the DBforPostgreSQL/DBforMySQL location-based capabilities).
//   - cache      — Azure Cache for Redis SKU tiers. Redis has NO dynamic per-region SKU/capability ARM
//                  op, so the tiers are the fixed product enum; account-availability is the Microsoft.Cache
//                  resource-provider registration state (registered ⇒ launchable; not ⇒ not_launchable).
//   - nosql      — Cosmos DB availability, taken from the Microsoft.DocumentDB provider registration state
//                  (+ the databaseAccounts region list) — the read-only "this subscription can use Cosmos"
//                  signal.
//
// Availability is design-time GUIDANCE, never a hard gate (#918 fail-open) — the pickers fall back to the
// static Catalog #2 per kind when a row is absent. Best-effort: never throws (the refresh sweep retries);
// each ARM call is isolated so one failing axis/region never sinks the pass. Uses raw ARM REST (matching
// the Wave-1 capabilities/azure.ts lane) rather than per-service SDK clients — those aren't installed and
// the calls are simple GETs.

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CapabilityLaunchable,
	type CapabilityLaunchableReason,
	type CapabilityServiceKind,
	cloudCapabilityServices,
} from "@/lib/db/schema";
import { softRemoveUnseen } from "../../inventory/upsert";
import { assumeAzureIdentity } from "../../session/azure";
import type { CapabilityIdentity } from "../types";

const ARM = "https://management.azure.com";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 200;

// Stable ARM api-versions (see the DBforPostgreSQL/DBforMySQL/ContainerService/Resources REST specs).
const API_LOCATIONS = "2022-12-01";
const API_AKS = "2024-05-01";
const API_PG = "2021-06-01";
const API_MYSQL = "2023-12-30";
const API_PROVIDERS = "2021-04-01";

// ── The normalized offering (pre-persistence) a normalizer emits ────────────────────
// Identity + timestamps are added by the orchestrator; keeping the normalizers pure of DB/identity makes
// them unit-testable against recorded ARM fixtures (the #973 acceptance test).
export interface NormalizedService {
	region: string;
	service_kind: CapabilityServiceKind;
	// Provider-native id, made distinct ACROSS kinds (softRemoveUnseen keys on native_id per identity):
	// k8s version ("1.29"), `${engine}-${version}` ("postgres-16"), Redis SKU ("Standard_C1"), or "Cosmos DB".
	native_id: string;
	name: string;
	engine: string | null;
	version: string | null;
	tier: string | null;
	mem_gb: number | null;
	launchable: CapabilityLaunchable;
	launchable_reason: CapabilityLaunchableReason;
}

// ── ARM response shapes (only the fields we read) ────────────────────────────────────
interface AzureLocation {
	name?: string;
	metadata?: { regionType?: string };
}
interface AksVersionEntry {
	version?: string;
	isPreview?: boolean;
	isDefault?: boolean;
}
interface AksVersionsResponse {
	values?: AksVersionEntry[];
}
interface FlexibleServerVersion {
	name?: string;
}
interface FlexibleServerEdition {
	supportedServerVersions?: FlexibleServerVersion[];
}
interface FlexibleCapabilityEntry {
	supportedFlexibleServerEditions?: FlexibleServerEdition[];
}
interface ArmProvider {
	registrationState?: string;
	resourceTypes?: { resourceType?: string; locations?: string[] }[];
}

// ── Static Redis SKU catalog (no dynamic ARM list op for Microsoft.Cache/redis) ─────
// Basic/Standard family C (C0–C6) + Premium family P (P1–P5), with the cache size in GB. name = the
// create-time `${sku.name}_C${capacity}` shape so Basic C1 and Standard C1 stay distinct offerings.
interface RedisTier {
	sku: string; // Basic | Standard | Premium
	code: string; // C0..C6 | P1..P5
	memGb: number;
}
const REDIS_TIERS: RedisTier[] = [
	{ sku: "Basic", code: "C0", memGb: 0.25 },
	{ sku: "Basic", code: "C1", memGb: 1 },
	{ sku: "Basic", code: "C2", memGb: 2.5 },
	{ sku: "Basic", code: "C3", memGb: 6 },
	{ sku: "Basic", code: "C4", memGb: 13 },
	{ sku: "Basic", code: "C5", memGb: 26 },
	{ sku: "Basic", code: "C6", memGb: 53 },
	{ sku: "Standard", code: "C0", memGb: 0.25 },
	{ sku: "Standard", code: "C1", memGb: 1 },
	{ sku: "Standard", code: "C2", memGb: 2.5 },
	{ sku: "Standard", code: "C3", memGb: 6 },
	{ sku: "Standard", code: "C4", memGb: 13 },
	{ sku: "Standard", code: "C5", memGb: 26 },
	{ sku: "Standard", code: "C6", memGb: 53 },
	{ sku: "Premium", code: "P1", memGb: 6 },
	{ sku: "Premium", code: "P2", memGb: 13 },
	{ sku: "Premium", code: "P3", memGb: 26 },
	{ sku: "Premium", code: "P4", memGb: 53 },
	{ sku: "Premium", code: "P5", memGb: 120 },
];

// ── Pure normalizers (exported for the fixture test) ─────────────────────────────────

/** AKS ListKubernetesVersions → one `kubernetes` offering per major.minor version (native_id = version). */
export function normalizeAksVersions(
	region: string,
	resp: AksVersionsResponse,
): NormalizedService[] {
	const seen = new Set<string>();
	const out: NormalizedService[] = [];
	for (const v of resp.values ?? []) {
		const version = v.version?.trim();
		if (!version || seen.has(version)) continue;
		seen.add(version);
		out.push({
			region,
			service_kind: "kubernetes",
			native_id: version,
			name: v.isPreview ? `Kubernetes ${version} (preview)` : `Kubernetes ${version}`,
			engine: null,
			version,
			tier: null,
			mem_gb: null,
			launchable: "launchable",
			launchable_reason: "available",
		});
	}
	return out;
}

/** DBforPostgreSQL/DBforMySQL location capabilities → one `database` offering per distinct engine
 * VERSION. Both services nest versions at
 * `value[].supportedFlexibleServerEditions[].supportedServerVersions[].name`, so one normalizer serves
 * both (the differing SKU sub-shape, supportedVcores vs supportedSkus, is not read here). */
export function normalizeFlexibleServerVersions(
	region: string,
	engine: "postgres" | "mysql",
	value: FlexibleCapabilityEntry[],
): NormalizedService[] {
	const seen = new Set<string>();
	const out: NormalizedService[] = [];
	for (const entry of value ?? []) {
		for (const edition of entry.supportedFlexibleServerEditions ?? []) {
			for (const sv of edition.supportedServerVersions ?? []) {
				const version = sv.name?.trim();
				if (!version || seen.has(version)) continue;
				seen.add(version);
				out.push({
					region,
					service_kind: "database",
					native_id: `${engine}-${version}`,
					name: `${engine === "postgres" ? "PostgreSQL" : "MySQL"} ${version}`,
					engine,
					version,
					tier: null,
					mem_gb: null,
					launchable: "launchable",
					launchable_reason: "available",
				});
			}
		}
	}
	return out;
}

/** Azure Cache for Redis tiers (static enum) → one `cache` offering per SKU tier. `registered` is the
 * Microsoft.Cache RP registration state: registered ⇒ launchable; otherwise the account can't launch
 * Redis, so the tiers are surfaced as not_launchable (account-accurate, not silent). */
export function normalizeRedisTiers(
	region: string,
	registered: boolean,
): NormalizedService[] {
	return REDIS_TIERS.map((t) => ({
		region,
		service_kind: "cache" as const,
		native_id: `${t.sku}_${t.code}`,
		name: `${t.sku} ${t.code} (${t.memGb} GB)`,
		engine: "redis",
		version: null,
		tier: t.code,
		mem_gb: t.memGb,
		launchable: registered ? ("launchable" as const) : ("not_launchable" as const),
		launchable_reason: registered
			? ("available" as const)
			: ("not_available_for_subscription" as const),
	}));
}

/** Cosmos DB availability from the Microsoft.DocumentDB provider registration → one `nosql` offering.
 * `registered` gates launchable; `offeredRegions` (the databaseAccounts location list) marks a region
 * where the RP is registered but Cosmos isn't offered as region_not_offered. */
export function normalizeCosmos(
	region: string,
	registered: boolean,
	offeredRegions: Set<string> | null,
): NormalizedService {
	const offeredHere =
		offeredRegions === null || offeredRegions.size === 0
			? registered
			: offeredRegions.has(region);
	let launchable: CapabilityLaunchable;
	let reason: CapabilityLaunchableReason;
	if (!registered) {
		launchable = "not_launchable";
		reason = "not_available_for_subscription";
	} else if (!offeredHere) {
		launchable = "not_launchable";
		reason = "region_not_offered";
	} else {
		launchable = "launchable";
		reason = "available";
	}
	return {
		region,
		service_kind: "nosql",
		native_id: "Cosmos DB",
		name: "Cosmos DB",
		engine: null,
		version: null,
		tier: null,
		mem_gb: null,
		launchable,
		launchable_reason: reason,
	};
}

// ── Keyless ARM access ───────────────────────────────────────────────────────────────

/** Acquires an ARM bearer token as the customer managed identity (keyless), or throws. */
async function azureToken(tenantId: string, clientId: string): Promise<string> {
	const cred = assumeAzureIdentity(tenantId, clientId);
	const t = await cred.getToken("https://management.azure.com/.default");
	if (!t?.token) throw new Error("Azure token acquisition returned no token");
	return t.token;
}

/** A single ARM GET with an abort timeout; throws on a non-2xx. */
async function armGet<T>(url: string, token: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`Azure ARM HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

/** Follows ARM `nextLink` pagination, accumulating the `value[]` pages (used by the *_flexible caps). */
async function armListValue<T>(firstUrl: string, token: string): Promise<T[]> {
	const out: T[] = [];
	let url: string | undefined = firstUrl;
	for (let i = 0; i < MAX_PAGES && url; i++) {
		const page: { value?: T[]; nextLink?: string } = await armGet(url, token);
		out.push(...(page.value ?? []));
		url = page.nextLink;
	}
	return out;
}

/** Reads a resource provider's registration + offered-resource locations (best-effort, null on failure). */
async function providerRegistration(
	subscriptionId: string,
	namespace: string,
	resourceType: string,
	token: string,
): Promise<{ registered: boolean; locations: Set<string> } | null> {
	try {
		const p = await armGet<ArmProvider>(
			`${ARM}/subscriptions/${subscriptionId}/providers/${namespace}?api-version=${API_PROVIDERS}`,
			token,
		);
		const state = p.registrationState ?? "";
		const registered = state === "Registered" || state === "Registering";
		const rt = (p.resourceTypes ?? []).find((r) => r.resourceType === resourceType);
		// ARM location display names ("East US") differ from region short names ("eastus"); normalize.
		const locations = new Set(
			(rt?.locations ?? []).map((l) => l.replace(/\s+/g, "").toLowerCase()),
		);
		return { registered, locations };
	} catch {
		return null;
	}
}

// ── Orchestrator ─────────────────────────────────────────────────────────────────────

/** Enumerates this Azure subscription's launchable managed services into `cloud_capability_services`.
 * Best-effort — never throws; each ARM call is isolated so one failure never sinks the pass. */
export async function syncAzureServiceCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const subscriptionId = identity.credentials.subscription_id;
	const tenantId = identity.credentials.tenant_id;
	const clientId = identity.credentials.client_id;
	if (!subscriptionId || !tenantId || !clientId) return;

	const token = await azureToken(tenantId, clientId);
	const db = getServiceDb();
	const identityId = identity.id;

	// Physical locations the subscription can use (same source as the Wave-1 lane).
	let regionNames: string[] = [];
	try {
		const locations = await armListValue<AzureLocation>(
			`${ARM}/subscriptions/${subscriptionId}/locations?api-version=${API_LOCATIONS}`,
			token,
		);
		regionNames = locations
			.filter((l) => l.metadata?.regionType !== "Logical")
			.map((l) => l.name)
			.filter((n): n is string => Boolean(n));
	} catch {
		// No region list ⇒ nothing to enumerate; leave existing rows untouched (don't soft-remove blind).
		return;
	}
	if (regionNames.length === 0) return;

	// Subscription-wide RP registration signals (one call each) for the axes without a per-region caps op.
	const cache = await providerRegistration(subscriptionId, "Microsoft.Cache", "redis", token);
	const cosmos = await providerRegistration(
		subscriptionId,
		"Microsoft.DocumentDB",
		"databaseAccounts",
		token,
	);

	const now = new Date();
	const seen: string[] = [];

	for (const region of regionNames) {
		const rows: NormalizedService[] = [];

		// kubernetes — AKS offered versions (response uses `values`, not `value`).
		try {
			const aks = await armGet<AksVersionsResponse>(
				`${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.ContainerService/locations/${region}/kubernetesVersions?api-version=${API_AKS}`,
				token,
			);
			rows.push(...normalizeAksVersions(region, aks));
		} catch {
			// AKS not offered / RP not registered in this region — best-effort skip.
		}

		// database — PostgreSQL + MySQL flexible-server offered engine versions.
		try {
			const pg = await armListValue<FlexibleCapabilityEntry>(
				`${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.DBforPostgreSQL/locations/${region}/capabilities?api-version=${API_PG}`,
				token,
			);
			rows.push(...normalizeFlexibleServerVersions(region, "postgres", pg));
		} catch {
			// PostgreSQL flexible-server not offered here — skip.
		}
		try {
			const my = await armListValue<FlexibleCapabilityEntry>(
				`${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.DBforMySQL/locations/${region}/capabilities?api-version=${API_MYSQL}`,
				token,
			);
			rows.push(...normalizeFlexibleServerVersions(region, "mysql", my));
		} catch {
			// MySQL flexible-server not offered here — skip.
		}

		// cache — static Redis tiers, availability = Microsoft.Cache RP registration.
		if (cache !== null) {
			rows.push(...normalizeRedisTiers(region, cache.registered));
		}

		// nosql — Cosmos DB availability from the Microsoft.DocumentDB RP registration.
		if (cosmos !== null) {
			rows.push(normalizeCosmos(region, cosmos.registered, cosmos.locations));
		}

		if (rows.length === 0) continue;

		const insertRows = rows.map((r) => {
			seen.push(r.native_id);
			return {
				cloud_identity_id: identityId,
				provider: "azure" as const,
				region: r.region,
				native_id: r.native_id,
				name: r.name,
				service_kind: r.service_kind,
				engine: r.engine,
				version: r.version,
				tier: r.tier,
				mem_gb: r.mem_gb,
				launchable: r.launchable,
				launchable_reason: r.launchable_reason,
				last_seen: now,
				last_synced_at: now,
				removed_at: null,
			};
		});

		await db
			.insert(cloudCapabilityServices)
			.values(insertRows)
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

	await softRemoveUnseen("cloud_capability_services", identityId, seen);
}
