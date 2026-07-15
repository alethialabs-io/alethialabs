// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure orphan-reclaim adapter.
//
// Authenticates KEYLESS, as the customer's User-Assigned Managed Identity (lib/cloud-providers/
// session/azure.ts) — no client secret, and no platform Entra app. Azure was deliberately de-Entra'd;
// nothing here may reintroduce one.
//
// Both listing paths below are SERVER-SIDE tag filters. That is not a performance choice: the
// subscription may hold unrelated production infrastructure, so an unfiltered listing that we narrow
// afterwards is one bad predicate away from enumerating (and then deleting) someone's prod. There is
// no code path in this file that lists without a tag filter.
//
// Two sources, unioned, because neither alone is sufficient:
//   * Resource Graph (ARG) — one KQL, one paginated call, every resource type at once. The preferred
//     lister. But ARG is an INDEX: it lags reality by seconds-to-minutes, and it exposes a creation
//     time only for the few types that surface `properties.timeCreated`.
//   * The ARM generic resource list with `$expand=createdTime` — authoritative (not an index, so it
//     sees a resource a failed apply created moments ago) and it yields `createdTime` for essentially
//     every tracked type. This is what makes the created-after guard evaluable.
// Both are filtered on the same tag, so their union can never be broader than the selector. ARM wins
// on `created_at`; ARG fills in anything ARM's index-free listing shapes differently.
//
// The adapter lists and deletes. It decides nothing — see lib/reclaim/guards.ts.

import { eq, and } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { assumeAzureIdentity } from "@/lib/cloud-providers/session/azure";
import type { CloudResourceRef, LabelSelector, ReclaimAdapter } from "../types";

const ARM = "https://management.azure.com";
const TIMEOUT_MS = 20_000;

/** api-version for the ARG query endpoint. */
const ARG_API_VERSION = "2022-10-01";
/** api-version for the generic resource list / provider-metadata endpoints. */
const RESOURCES_API_VERSION = "2021-04-01";

/** ARG caps a page at 1000 rows; we page until the skip token runs out. */
const PAGE_SIZE = 1000;

/**
 * Last-resort api-versions, keyed by lowercase ARM type. Normally the api-version for a delete is read
 * live from the provider metadata (see resolveApiVersion) so it can never go stale; this map only
 * covers the case where that metadata call fails. Wrong api-version ⇒ the delete fails and the orphan
 * survives — a safe failure, but a broken one, hence the live lookup is preferred.
 */
const FALLBACK_API_VERSIONS: Record<string, string> = {
	"microsoft.containerservice/managedclusters": "2024-05-01",
	"microsoft.compute/virtualmachines": "2024-07-01",
	"microsoft.compute/virtualmachinescalesets": "2024-07-01",
	"microsoft.compute/disks": "2023-04-02",
	"microsoft.compute/snapshots": "2023-04-02",
	"microsoft.network/virtualnetworks": "2023-09-01",
	"microsoft.network/networksecuritygroups": "2023-09-01",
	"microsoft.network/publicipaddresses": "2023-09-01",
	"microsoft.network/loadbalancers": "2023-09-01",
	"microsoft.network/natgateways": "2023-09-01",
	"microsoft.network/networkinterfaces": "2023-09-01",
	"microsoft.network/privateendpoints": "2023-09-01",
	"microsoft.network/applicationgateways": "2023-09-01",
	"microsoft.network/applicationgatewaywebapplicationfirewallpolicies":
		"2023-09-01",
	"microsoft.network/privatednszones": "2020-06-01",
	"microsoft.network/dnszones": "2018-05-01",
	"microsoft.dbforpostgresql/flexibleservers": "2024-08-01",
	"microsoft.cache/redis": "2024-03-01",
	"microsoft.cache/redisenterprise": "2024-09-01-preview",
	"microsoft.servicebus/namespaces": "2022-10-01-preview",
	"microsoft.documentdb/databaseaccounts": "2024-05-15",
	"microsoft.containerregistry/registries": "2023-07-01",
	"microsoft.storage/storageaccounts": "2023-05-01",
	"microsoft.keyvault/vaults": "2023-07-01",
	"microsoft.managedidentity/userassignedidentities": "2023-01-31",
};

/** Narrows an unknown JSON value to a plain object without an `as` cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a non-empty string, or null. Used to keep unknown JSON off the typed surface. */
function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Collects only the string-valued entries of a tag bag; anything else is not a tag we can match on. */
function asTags(value: unknown): Record<string, string> {
	const tags: Record<string, string> = {};
	if (!isRecord(value)) return tags;
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw === "string") tags[key] = raw;
	}
	return tags;
}

/**
 * Parses a cloud-reported timestamp. Returns null for anything unparseable — NEVER a substitute value.
 * A fabricated timestamp would defeat the created-after guard, which is the only thing making
 * pre-existing infrastructure unsweepable.
 */
function asDate(value: unknown): Date | null {
	const raw = asString(value);
	if (!raw) return null;
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Escapes a value for a single-quoted KQL string literal (ARG). */
function kqlLiteral(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Escapes a value for a single-quoted OData string literal (ARM `$filter`); quotes are doubled. */
function odataLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** The resource group segment of an ARM resource id, or null when the id carries none. */
function resourceGroupOf(armId: string): string | null {
	return /\/resourceGroups\/([^/]+)/i.exec(armId)?.[1] ?? null;
}

/**
 * True when an ARM id lives in an AKS node resource group.
 *
 * AKS auto-creates a shadow "node resource group" (default name `MC_<rg>_<cluster>_<region>`; our
 * template leaves the default in place) and fills it with the cluster's own VMSS, disks, NICs, load
 * balancers and public IPs. Azure PROPAGATES the cluster's tags onto much of it, so those resources
 * carry our selector and would otherwise look exactly like orphans.
 *
 * They are not. They are owned by the managed cluster, and deleting the cluster deletes them. Removing
 * them individually would fight the cluster's own controllers — so this adapter never returns them, and
 * the deleteOrder puts `managedclusters` first precisely so the node RG is reclaimed as a side effect.
 *
 * (Consequence, stated plainly: if a cluster is deleted but Azure strands its node RG — a known Azure
 * failure mode — this adapter will not sweep the remains. That residue is left for a human, which is
 * the conservative side to err on.)
 */
function isNodeResourceGroup(armId: string): boolean {
	const group = resourceGroupOf(armId);
	return group !== null && /^mc_/i.test(group);
}

/** The Azure connection's subscription + a keyless ARM bearer token for it. */
interface AzureContext {
	token: string;
	subscriptionId: string;
}

/**
 * Loads the Azure cloud identity and mints an ARM token as its user-assigned managed identity.
 * Filtered by `provider` so an identity id can never resolve across clouds.
 */
async function azureContext(identityId: string): Promise<AzureContext> {
	const [identity] = await getServiceDb()
		.select({ credentials: cloudIdentities.credentials })
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.provider, "azure"),
			),
		)
		.limit(1);

	const subscriptionId = identity?.credentials?.subscription_id;
	const tenantId = identity?.credentials?.tenant_id;
	const clientId = identity?.credentials?.client_id;
	if (!subscriptionId) {
		throw new Error("azure reclaim: cloud identity has no subscription id");
	}
	if (!tenantId) throw new Error("azure reclaim: cloud identity has no tenant id");
	if (!clientId) throw new Error("azure reclaim: cloud identity has no client id");

	const credential = assumeAzureIdentity(tenantId, clientId);
	const accessToken = await credential.getToken(`${ARM}/.default`);
	if (!accessToken?.token) {
		throw new Error("azure reclaim: ARM token acquisition returned no token");
	}
	return { token: accessToken.token, subscriptionId };
}

/**
 * One ARM call with a timeout. Returns the parsed body, or null for 204/404 — a resource that is
 * already gone is not an error (see `remove`, which relies on this for idempotence).
 */
async function armCall(
	token: string,
	url: string,
	init?: RequestInit,
): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				...init?.headers,
			},
			signal: controller.signal,
		});
		if (res.status === 404 || res.status === 204) return null;
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(
				`azure ARM ${init?.method ?? "GET"} ${res.status}: ${detail.slice(0, 300)}`,
			);
		}
		const body = await res.text();
		return body ? JSON.parse(body) : null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Lists tagged resources via Azure Resource Graph — a genuine server-side filter across every resource
 * type in one paginated query. `=~` is case-insensitive on the tag VALUE, which can only ever
 * over-return (the core re-checks the selector exactly, and refuses a mismatch), never under-return.
 * Paginated fully via `$skipToken`.
 */
async function listViaResourceGraph(
	ctx: AzureContext,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	// The tag predicate is the ONLY thing standing between this sweep and the rest of the subscription,
	// so it is baked into the query — there is no unfiltered variant of it.
	const query = [
		"Resources",
		`| where tags[${kqlLiteral(selector.key)}] =~ ${kqlLiteral(selector.value)}`,
		"| project id, name, type, location, tags, createdTime = properties.timeCreated",
	].join("\n");

	const out: CloudResourceRef[] = [];
	let skipToken: string | null = null;

	do {
		const body = await armCall(
			ctx.token,
			`${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API_VERSION}`,
			{
				method: "POST",
				body: JSON.stringify({
					subscriptions: [ctx.subscriptionId],
					query,
					options: {
						resultFormat: "objectArray",
						$top: PAGE_SIZE,
						...(skipToken ? { $skipToken: skipToken } : {}),
					},
				}),
			},
		);

		if (!isRecord(body)) break;
		const rows = body.data;
		if (!Array.isArray(rows)) break;

		for (const row of rows) {
			if (!isRecord(row)) continue;
			const id = asString(row.id);
			const type = asString(row.type);
			if (!id || !type) continue;
			// AKS owns its node resource group; see isNodeResourceGroup.
			if (isNodeResourceGroup(id)) continue;

			out.push({
				native_id: id,
				kind: type.toLowerCase(),
				name: asString(row.name),
				region: asString(row.location),
				// Only a handful of types surface properties.timeCreated. The ARM pass below backfills the
				// rest; whatever is still null after that is REFUSED by the created-after guard.
				created_at: asDate(row.createdTime),
				labels: asTags(row.tags),
			});
		}

		skipToken = asString(body.$skipToken);
	} while (skipToken);

	return out;
}

/**
 * Lists tagged resources via the ARM generic resource list, server-side filtered with
 * `$filter=tagName eq … and tagValue eq …` and expanded with `createdTime`.
 *
 * This is the authoritative source for `created_at`: unlike Resource Graph it is not an index (so it
 * sees a resource a failed apply created seconds ago) and `$expand=createdTime` yields a creation time
 * for essentially every tracked resource type, including the network resources ARG reports as null.
 * Paginated fully via `nextLink`.
 */
async function listViaResourceManager(
	ctx: AzureContext,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const filter = `tagName eq ${odataLiteral(selector.key)} and tagValue eq ${odataLiteral(selector.value)}`;
	let url: string | null =
		`${ARM}/subscriptions/${ctx.subscriptionId}/resources` +
		`?api-version=${RESOURCES_API_VERSION}` +
		`&$expand=createdTime` +
		`&$filter=${encodeURIComponent(filter)}`;

	const out: CloudResourceRef[] = [];
	while (url) {
		const body: unknown = await armCall(ctx.token, url);
		if (!isRecord(body)) break;
		const rows = body.value;
		if (!Array.isArray(rows)) break;

		for (const row of rows) {
			if (!isRecord(row)) continue;
			const id = asString(row.id);
			const type = asString(row.type);
			if (!id || !type) continue;
			if (isNodeResourceGroup(id)) continue;

			out.push({
				native_id: id,
				kind: type.toLowerCase(),
				name: asString(row.name),
				region: asString(row.location),
				created_at: asDate(row.createdTime),
				labels: asTags(row.tags),
			});
		}

		url = asString(body.nextLink);
	}
	return out;
}

/**
 * Lists every Azure resource carrying the selector tag.
 *
 * Runs both server-side-filtered sources and unions them by ARM resource id, preferring a non-null
 * `created_at` from whichever source reported one (in practice: the ARM list). Both sources apply the
 * same tag filter, so the union is still exactly "resources carrying the selector" — it is a recall
 * improvement, never a widening.
 */
async function list(
	identityId: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const ctx = await azureContext(identityId);
	const [graph, manager] = await Promise.all([
		listViaResourceGraph(ctx, selector),
		listViaResourceManager(ctx, selector),
	]);

	const merged = new Map<string, CloudResourceRef>();
	for (const ref of [...graph, ...manager]) {
		const existing = merged.get(ref.native_id);
		if (!existing) {
			merged.set(ref.native_id, ref);
			continue;
		}
		// Same resource from both sources: keep whichever actually knows when it was created.
		merged.set(ref.native_id, {
			...existing,
			created_at: existing.created_at ?? ref.created_at,
			labels: Object.keys(existing.labels).length
				? existing.labels
				: ref.labels,
		});
	}
	return [...merged.values()];
}

/** Per-namespace api-version cache, so a sweep resolves each resource provider at most once. */
type ApiVersionCache = Map<string, Map<string, string>>;

/**
 * Picks the newest api-version for a type, preferring STABLE over preview. Azure's api-versions are
 * ISO-dated, so a lexicographic descending sort is a chronological one.
 */
function newestApiVersion(versions: string[]): string | null {
	const stable = versions.filter((v) => !v.includes("-preview")).sort().reverse();
	if (stable.length > 0) return stable[0] ?? null;
	return [...versions].sort().reverse()[0] ?? null;
}

/**
 * Resolves the api-version to delete `armType` with, by reading the resource provider's live metadata
 * (`GET /subscriptions/{id}/providers/{namespace}`) rather than hardcoding one per type — the map would
 * rot, and a stale api-version silently turns a delete into a failure. Falls back to
 * FALLBACK_API_VERSIONS if the metadata call fails.
 */
async function resolveApiVersion(
	ctx: AzureContext,
	armType: string,
	cache: ApiVersionCache,
): Promise<string> {
	const [namespace, ...rest] = armType.split("/");
	const typeName = rest.join("/");
	const fallback = FALLBACK_API_VERSIONS[armType];

	if (!namespace || !typeName) {
		if (fallback) return fallback;
		throw new Error(`azure reclaim: cannot parse ARM type ${armType}`);
	}

	let namespaceVersions = cache.get(namespace);
	if (!namespaceVersions) {
		namespaceVersions = new Map<string, string>();
		try {
			const body = await armCall(
				ctx.token,
				`${ARM}/subscriptions/${ctx.subscriptionId}/providers/${namespace}?api-version=${RESOURCES_API_VERSION}`,
			);
			const types = isRecord(body) ? body.resourceTypes : null;
			if (Array.isArray(types)) {
				for (const entry of types) {
					if (!isRecord(entry)) continue;
					const name = asString(entry.resourceType);
					const versions = entry.apiVersions;
					if (!name || !Array.isArray(versions)) continue;
					const parsed = versions.filter(
						(v): v is string => typeof v === "string",
					);
					const newest = newestApiVersion(parsed);
					if (newest) namespaceVersions.set(name.toLowerCase(), newest);
				}
			}
		} catch {
			// Metadata is a convenience, not a dependency — fall through to the static map below.
		}
		cache.set(namespace, namespaceVersions);
	}

	const resolved = namespaceVersions.get(typeName.toLowerCase());
	if (resolved) return resolved;
	if (fallback) return fallback;
	throw new Error(`azure reclaim: no api-version known for ${armType}`);
}

/**
 * Deletes ONE resource by its exact ARM resource id — the id is the handle, never the name.
 *
 * Idempotent by construction: `armCall` maps 404 (and the 204 no-content delete) to success, so a
 * resource that has already vanished is a completed delete rather than an error.
 *
 * Azure deletes are long-running: a 202 means "accepted", not "done". We deliberately do NOT poll the
 * async operation — the next sweep tick re-lists, and either the resource is gone (nothing to do) or it
 * is still there and the DELETE is simply re-issued, which is safe because it is idempotent.
 */
async function remove(
	identityId: string,
	resource: CloudResourceRef,
): Promise<void> {
	const ctx = await azureContext(identityId);
	const apiVersion = await resolveApiVersion(ctx, resource.kind, new Map());
	await armCall(
		ctx.token,
		`${ARM}${resource.native_id}?api-version=${apiVersion}`,
		{ method: "DELETE" },
	);
}

export const azureReclaim: ReclaimAdapter = {
	provider: "azure",
	list,
	delete: remove,
	// Most-dependent first, so a delete never trips over a dependency that is still holding it.
	//
	// The managed cluster leads deliberately: it owns its MC_* node resource group (VMSS, node disks,
	// NICs, the cluster's load balancer and its public IPs), and deleting the cluster reclaims all of
	// it in one call — which is why those resources are never listed individually.
	//
	// Then the data services, then the network edge (app gateway → LB → NAT gateway → NICs → public
	// IPs), then disks, then the NSGs/subnets/VNet everything else was attached to. Subnets are listed
	// for ordering completeness only: Azure subnets are child resources and cannot carry tags, so they
	// never appear in a tag-filtered listing — they are removed with their VNet.
	//
	// Resource GROUPS are absent on purpose: neither listing source returns them (they are containers,
	// not resources), and an RG delete is a recursive cascade over everything inside it — including
	// whatever we did not create. This adapter deletes leaf resources only.
	deleteOrder: [
		"microsoft.containerservice/managedclusters",
		"microsoft.compute/virtualmachines",
		"microsoft.compute/virtualmachinescalesets",
		"microsoft.dbforpostgresql/flexibleservers",
		"microsoft.cache/redis",
		"microsoft.cache/redisenterprise",
		"microsoft.servicebus/namespaces",
		"microsoft.documentdb/databaseaccounts",
		"microsoft.containerregistry/registries",
		"microsoft.storage/storageaccounts",
		"microsoft.keyvault/vaults",
		"microsoft.network/applicationgateways",
		"microsoft.network/applicationgatewaywebapplicationfirewallpolicies",
		"microsoft.network/loadbalancers",
		"microsoft.network/natgateways",
		"microsoft.network/privateendpoints",
		"microsoft.network/networkinterfaces",
		"microsoft.network/publicipaddresses",
		"microsoft.compute/disks",
		"microsoft.compute/snapshots",
		"microsoft.network/networksecuritygroups",
		"microsoft.network/virtualnetworks/subnets",
		"microsoft.network/virtualnetworks",
		"microsoft.network/privatednszones",
		"microsoft.network/dnszones",
		"microsoft.managedidentity/userassignedidentities",
	],
};
