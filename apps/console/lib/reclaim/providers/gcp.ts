// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GCP orphan-reclaim adapter.
//
// The adapter lists and deletes. It decides nothing — see lib/reclaim/guards.ts.
//
// WHY PER-SERVICE LISTS AND NOT CLOUD ASSET INVENTORY
// Cloud Asset Inventory (`searchAllResources`, `query=labels.k:v`) is the obvious fit: one genuine
// server-side filter across every service. We do not use it, for two independent reasons — either alone
// would be disqualifying:
//   1. It is NOT reachable with the credential we hold. The connector (infra/connector/gcp/main.tf) never
//      enables `cloudasset.googleapis.com` and grants the Alethia service account no `roles/cloudasset.*`
//      — so `searchAllResources` returns SERVICE_DISABLED / PERMISSION_DENIED for every connected
//      customer. (The Cloud Asset *feed* in the opt-in events.tf is created by the customer's own
//      Terraform, not by us, and even it notes the API must be enabled separately.)
//   2. Its resource names would silently DEFEAT the not-in-state guard. CAI identifies a resource as
//      `//compute.googleapis.com/projects/p/zones/z/instances/i`. tofu state stores `id` and `self_link`
//      (`https://www.googleapis.com/compute/v1/projects/...`), and lib/reclaim/state.ts matches native ids
//      against exactly those strings. A CAI name matches NEITHER — so every tofu-managed resource would
//      look absent from state, i.e. look like an orphan. That is a fail-OPEN guard, the worst failure this
//      code can have.
// So: per-service lists, and `native_id` is the **selfLink** — the exact string tofu writes to `self_link`,
// which is both a valid delete target and a key the state guard can actually match.
//
// WHAT CAN BE SWEPT AT ALL
// A label selector can only ever reach a resource that CARRIES labels. On GCP that excludes VPC networks,
// subnetworks, firewall rules and routers outright — the GCP API has no `labels` field on any of them (our
// vpc-network module computes `merged_labels` and cannot apply it). They therefore cannot be listed under a
// server-side label filter, so this adapter never lists them: no filter ⇒ no listing, no exceptions. They
// remain deletable by exact native id (deleteOrder + delete() cover them) should a future discovery path
// ever produce one, but list() will not invent candidates for them.
//
// THE ONE SERVER-SIDE-FILTER EXCEPTION: GKE clusters
// `container.projects.locations.clusters.list` accepts NO filter parameter — GCP simply does not offer a
// server-side label filter for GKE, and CAI (the only API that does) is unavailable per above. GKE clusters
// are also the single most valuable orphan: the cluster is the only thing our GCP template stamps the sweep
// label onto in Compute-land (node-pool VMs and their disks get k8s node labels, not GCE resource labels).
// Dropping GKE would leave the adapter unable to see anything it exists to reclaim. So clusters are listed
// and narrowed by EXACT equality on `resourceLabels[selector.key]` — never a prefix, contains or regex — and
// a cluster with no labels map is dropped, not kept. The narrowing only ever shrinks the candidate set, and
// guards.ts re-verifies the label before any delete. To remove this exception, grant `roles/cloudasset.viewer`
// + enable `cloudasset.googleapis.com` in the connector and revisit the native_id mapping in (2) above.

import { and, eq } from "drizzle-orm";
import { externalAccountClientFromWif } from "@/lib/cloud-providers/session/gcp";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import type { CloudResourceRef, LabelSelector, ReclaimAdapter } from "../types";

const COMPUTE_API = "https://compute.googleapis.com/compute/v1";
const CONTAINER_API = "https://container.googleapis.com/v1";
// v1beta4 deliberately: it is the version the Terraform provider writes into `self_link`, so a selfLink
// listed here is the same string the state guard compares against.
const SQL_API = "https://sqladmin.googleapis.com/sql/v1beta4";

const TIMEOUT_MS = 20_000;
const PAGE_SIZE = 500;

/** The GCP resource kinds this adapter knows, named as Cloud Asset asset types (service/Type). */
const KIND = {
	cluster: "container.googleapis.com/Cluster",
	nodePool: "container.googleapis.com/NodePool",
	instance: "compute.googleapis.com/Instance",
	disk: "compute.googleapis.com/Disk",
	address: "compute.googleapis.com/Address",
	globalAddress: "compute.googleapis.com/GlobalAddress",
	forwardingRule: "compute.googleapis.com/ForwardingRule",
	globalForwardingRule: "compute.googleapis.com/GlobalForwardingRule",
	firewall: "compute.googleapis.com/Firewall",
	router: "compute.googleapis.com/Router",
	subnetwork: "compute.googleapis.com/Subnetwork",
	network: "compute.googleapis.com/Network",
	sqlInstance: "sqladmin.googleapis.com/Instance",
} as const;

/** A GCP REST failure, carrying the status so the caller can tell "may not read" from "is broken". */
class GcpHttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "GcpHttpError";
		this.status = status;
	}
}

// --- credentials -----------------------------------------------------------------------------------

/**
 * Mints a GCP access token for one connection and resolves its project id. KEYLESS: the token comes from
 * Workload Identity Federation (a freshly minted Alethia OIDC assertion exchanged by google-auth) — the
 * same path as lib/cloud-providers/inventory/gcp.ts. No service-account key is ever read or stored.
 */
async function gcpSession(
	identityId: string,
): Promise<{ token: string; projectId: string }> {
	const [identity] = await getServiceDb()
		.select({ credentials: cloudIdentities.credentials })
		.from(cloudIdentities)
		// Always scoped by provider: a cloud_identities read that does not filter by provider can hand back
		// another cloud's credentials for the same id.
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.provider, "gcp"),
			),
		)
		.limit(1);

	const credentials = identity?.credentials;
	if (!credentials) throw new Error("gcp reclaim: GCP cloud identity not found");

	const projectId = credentials.project_id;
	if (!projectId) throw new Error("gcp reclaim: cloud identity has no project id");

	const wif = credentials.wif_config;
	if (!wif) throw new Error("gcp reclaim: cloud identity has no WIF config");

	const client = externalAccountClientFromWif(wif);
	if (!client) {
		throw new Error(
			"gcp reclaim: this GCP connection uses the retired AWS-hub setup — reconnect it.",
		);
	}
	const accessToken = await client.getAccessToken();
	if (!accessToken.token) {
		throw new Error("gcp reclaim: GCP token acquisition returned no token");
	}
	return { token: accessToken.token, projectId };
}

// --- HTTP ------------------------------------------------------------------------------------------

/** One GCP REST GET with a timeout. Throws a GcpHttpError carrying the status on any non-2xx. */
async function gcpGet<T>(url: string, token: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new GcpHttpError(
				res.status,
				`gcp reclaim: GET ${new URL(url).pathname} → HTTP ${res.status}`,
			);
		}
		const body: T = await res.json();
		return body;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Deletes one resource by its exact self-link. Idempotent by construction: a 404 is a SUCCESS — the
 * resource is already gone (a retried sweep, or a `tofu destroy` that raced us), which is precisely the
 * outcome we wanted. Compute/GKE/SQL deletes are asynchronous (they return a long-running Operation); we do
 * not wait — the resource simply stops appearing in the next sweep's listing.
 */
async function gcpDelete(url: string, token: string): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (res.status === 404) return;
		if (!res.ok) {
			throw new GcpHttpError(
				res.status,
				`gcp reclaim: DELETE ${new URL(url).pathname} → HTTP ${res.status}`,
			);
		}
	} finally {
		clearTimeout(timer);
	}
}

// --- the label filter ------------------------------------------------------------------------------

// GCP's own label grammar. Validating the selector against it is not cosmetic: it is what makes the filter
// expression un-escapable. A value carrying a quote, space or parenthesis could otherwise turn
// `labels.cluster=x` into a broader predicate — the account-wide listing this design exists to prevent.
const LABEL_KEY_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const LABEL_VALUE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Renders the selector as a server-side label filter for one API family. Throws (fail-closed) on anything
 * that is not a syntactically valid GCP label — such a resource cannot exist in GCP anyway, so refusing is
 * free, and it removes filter injection as a category.
 */
function labelFilter(
	selector: LabelSelector,
	syntax: "compute" | "sql",
): string {
	if (!LABEL_KEY_RE.test(selector.key) || !LABEL_VALUE_RE.test(selector.value)) {
		throw new Error(
			`gcp reclaim: refusing to build a filter from a selector that is not a valid GCP label (${selector.key}=${selector.value})`,
		);
	}
	// Compute: `labels.k=v` is an exact match. Cloud SQL (AIP-160): `:` is a HAS operator, so it can
	// over-match — harmless, because carriesSelector() re-narrows every result to exact equality below.
	return syntax === "compute"
		? `labels.${selector.key}=${selector.value}`
		: `settings.userLabels.${selector.key}:${selector.value}`;
}

/**
 * True only when the resource's OWN labels carry the selector, exactly. Fail-closed: a resource with no
 * labels map is not a match. Applied to every kind after its server-side filter — it can only ever SHRINK
 * the candidate set, never widen it, and for GKE clusters (no filter parameter exists) it is the filter.
 */
function carriesSelector(
	labels: Record<string, string> | undefined,
	selector: LabelSelector,
): boolean {
	return labels?.[selector.key] === selector.value;
}

// --- Compute ---------------------------------------------------------------------------------------

/** The fields every Compute list entry we sweep exposes. `creationTimestamp` is universal in Compute. */
interface ComputeResource {
	name?: string;
	selfLink?: string;
	creationTimestamp?: string;
	labels?: Record<string, string>;
	zone?: string;
	region?: string;
}

/** One scope bucket of a Compute `aggregatedList` — keyed by the collection being listed. */
interface ComputeScope {
	instances?: ComputeResource[];
	disks?: ComputeResource[];
	addresses?: ComputeResource[];
	forwardingRules?: ComputeResource[];
}

interface ComputeAggregatedList {
	items?: Record<string, ComputeScope>;
	nextPageToken?: string;
}

interface ComputeGlobalList {
	items?: ComputeResource[];
	nextPageToken?: string;
}

/** The trailing segment of a Compute zone/region URL ("…/regions/europe-west3" → "europe-west3"). */
function lastSegment(url: string | undefined): string | null {
	return url ? (url.split("/").pop() || null) : null;
}

/**
 * Maps one Compute list entry to a CloudResourceRef. A resource with no selfLink is DROPPED rather than
 * identified by name: without an exact delete handle we have nothing safe to report.
 */
function refFromCompute(
	item: ComputeResource,
	kind: string,
): CloudResourceRef | null {
	if (!item.selfLink) return null;
	return {
		native_id: item.selfLink,
		kind,
		name: item.name ?? null,
		region: lastSegment(item.zone) ?? lastSegment(item.region),
		// Every Compute resource carries `creationTimestamp`, so the created-after guard is always
		// evaluable for these kinds — none is ever refused for an unknown age.
		created_at: item.creationTimestamp
			? new Date(item.creationTimestamp)
			: null,
		labels: item.labels ?? {},
	};
}

/**
 * Lists one Compute collection across every zone/region (`aggregatedList`), filtered SERVER-SIDE by
 * `labels.<key>=<value>` and paginated to exhaustion.
 */
async function listComputeAggregated(
	projectId: string,
	token: string,
	collection: keyof ComputeScope,
	kind: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			filter: labelFilter(selector, "compute"),
			maxResults: String(PAGE_SIZE),
		});
		if (pageToken) params.set("pageToken", pageToken);

		const page = await gcpGet<ComputeAggregatedList>(
			`${COMPUTE_API}/projects/${projectId}/aggregated/${collection}?${params.toString()}`,
			token,
		);
		for (const scope of Object.values(page.items ?? {})) {
			for (const item of scope[collection] ?? []) {
				if (!carriesSelector(item.labels, selector)) continue;
				const ref = refFromCompute(item, kind);
				if (ref) out.push(ref);
			}
		}
		pageToken = page.nextPageToken;
	} while (pageToken);
	return out;
}

/** Lists one GLOBAL Compute collection (global addresses / global forwarding rules), server-side filtered. */
async function listComputeGlobal(
	projectId: string,
	token: string,
	collection: "addresses" | "forwardingRules",
	kind: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			filter: labelFilter(selector, "compute"),
			maxResults: String(PAGE_SIZE),
		});
		if (pageToken) params.set("pageToken", pageToken);

		const page = await gcpGet<ComputeGlobalList>(
			`${COMPUTE_API}/projects/${projectId}/global/${collection}?${params.toString()}`,
			token,
		);
		for (const item of page.items ?? []) {
			if (!carriesSelector(item.labels, selector)) continue;
			const ref = refFromCompute(item, kind);
			if (ref) out.push(ref);
		}
		pageToken = page.nextPageToken;
	} while (pageToken);
	return out;
}

// --- GKE -------------------------------------------------------------------------------------------

interface GkeCluster {
	name?: string;
	selfLink?: string;
	createTime?: string;
	location?: string;
	resourceLabels?: Record<string, string>;
}

interface GkeClusterList {
	clusters?: GkeCluster[];
}

/**
 * Lists GKE clusters carrying the selector, via the aggregated `locations/-` list (one call, no pagination
 * — the API returns every cluster in the project).
 *
 * This is the ONE kind with no server-side label filter: `clusters.list` accepts no filter parameter at
 * all (see the file header for why Cloud Asset Inventory, the only API that does, is not available to us).
 * The narrowing below is exact equality on the cluster's own `resourceLabels`, fail-closed, and guards.ts
 * re-checks the label before any delete. Node pools are NOT listed: our template stamps the sweep label on
 * the cluster's `resource_labels`, while a node pool's `node_config.labels` are Kubernetes node labels, not
 * GCE resource labels — the pool and its VMs genuinely do not carry the selector, and deleting the cluster
 * removes them anyway.
 */
async function listGkeClusters(
	projectId: string,
	token: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const page = await gcpGet<GkeClusterList>(
		`${CONTAINER_API}/projects/${projectId}/locations/-/clusters`,
		token,
	);
	const out: CloudResourceRef[] = [];
	for (const cluster of page.clusters ?? []) {
		if (!carriesSelector(cluster.resourceLabels, selector)) continue;
		if (!cluster.selfLink) continue;
		out.push({
			native_id: cluster.selfLink,
			kind: KIND.cluster,
			name: cluster.name ?? null,
			// A GKE `location` is a region OR a zone (a zonal cluster is a valid, cheaper topology).
			region: cluster.location ?? null,
			// GKE reports `createTime` on every cluster ⇒ the created-after guard is always evaluable.
			created_at: cluster.createTime ? new Date(cluster.createTime) : null,
			labels: cluster.resourceLabels ?? {},
		});
	}
	return out;
}

// --- Cloud SQL -------------------------------------------------------------------------------------

interface SqlInstance {
	name?: string;
	selfLink?: string;
	createTime?: string;
	region?: string;
	settings?: { userLabels?: Record<string, string> };
}

interface SqlInstanceList {
	items?: SqlInstance[];
	nextPageToken?: string;
}

/**
 * Lists Cloud SQL instances carrying the selector, filtered SERVER-SIDE by
 * `settings.userLabels.<key>:<value>` and paginated to exhaustion. The `:` operator is HAS (it can
 * over-match), so every page is re-narrowed to exact equality.
 */
async function listSqlInstances(
	projectId: string,
	token: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			filter: labelFilter(selector, "sql"),
			maxResults: String(PAGE_SIZE),
		});
		if (pageToken) params.set("pageToken", pageToken);

		const page = await gcpGet<SqlInstanceList>(
			`${SQL_API}/projects/${projectId}/instances?${params.toString()}`,
			token,
		);
		for (const instance of page.items ?? []) {
			if (!carriesSelector(instance.settings?.userLabels, selector)) continue;
			if (!instance.selfLink) continue;
			out.push({
				native_id: instance.selfLink,
				kind: KIND.sqlInstance,
				name: instance.name ?? null,
				region: instance.region ?? null,
				// Cloud SQL reports `createTime` ⇒ the created-after guard is always evaluable.
				created_at: instance.createTime ? new Date(instance.createTime) : null,
				labels: instance.settings?.userLabels ?? {},
			});
		}
		pageToken = page.nextPageToken;
	} while (pageToken);
	return out;
}

// --- list ------------------------------------------------------------------------------------------

// A note on the 403 you will eventually see here, because it is DELIBERATE and must not be "fixed".
//
// The connector grants the Alethia SA no roles/compute.instanceAdmin (infra/connector/gcp/main.tf), so
// deleting a Compute Instance or Disk would 403. That is correct, and the grant must NOT be added:
//
//   - The GCP template creates NO raw compute instances or disks. Every node is GKE-managed, and GKE's
//     node VMs carry GKE's own labels — not the resource labels our sweep handle lives in. So a LABELLED
//     orphaned VM/disk cannot arise from our own provisioning at all.
//   - Deleting the GKE cluster reclaims its nodes anyway (roles/container.admin, which we DO hold).
//
// Granting instanceAdmin would therefore expand privilege on a customer-facing connector to handle a case
// that cannot occur — precisely the creep the least-privilege connector work exists to prevent. The kinds
// stay LISTED (a BYO-IaC user could label their own VMs, and the audit trail should show them), and a
// delete that 403s is recorded in the sweep's `failed` list for an operator. Under-deleting is the safe
// direction; over-privileging is not.

/**
 * Runs one kind's listing. A kind we may not READ (403) or whose API is disabled (403/404) is SKIPPED with
 * a warning rather than failing the sweep: a resource we cannot see is a resource we can never report, so
 * the sweep can only under-delete — the safe direction. Every other failure (5xx, network, bad token)
 * propagates: a broken sweep must be loud, never a silently empty one.
 */
async function listOrSkipUnreadable(
	kind: string,
	run: () => Promise<CloudResourceRef[]>,
): Promise<CloudResourceRef[]> {
	try {
		return await run();
	} catch (err) {
		if (err instanceof GcpHttpError && (err.status === 403 || err.status === 404)) {
			console.warn(
				`gcp reclaim: cannot list ${kind} (HTTP ${err.status}) — skipping. These resources will never be reclaimed until the connector grants read access to them.`,
			);
			return [];
		}
		throw err;
	}
}

/**
 * Lists every GCP resource carrying the selector label, across the kinds our project template creates that
 * GCP allows to be labelled at all. Server-side filtered throughout (the one exception, GKE clusters, is
 * documented on listGkeClusters and in the file header). Networks, subnetworks, firewall rules and routers
 * are deliberately absent: GCP puts no labels on them, so there is no filter to list them under.
 */
async function list(
	identityId: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const { token, projectId } = await gcpSession(identityId);

	const sources: Array<{ kind: string; run: () => Promise<CloudResourceRef[]> }> =
		[
			{
				kind: KIND.cluster,
				run: () => listGkeClusters(projectId, token, selector),
			},
			{
				kind: KIND.instance,
				run: () =>
					listComputeAggregated(
						projectId,
						token,
						"instances",
						KIND.instance,
						selector,
					),
			},
			{
				kind: KIND.disk,
				run: () =>
					listComputeAggregated(projectId, token, "disks", KIND.disk, selector),
			},
			{
				kind: KIND.address,
				run: () =>
					listComputeAggregated(
						projectId,
						token,
						"addresses",
						KIND.address,
						selector,
					),
			},
			{
				kind: KIND.forwardingRule,
				run: () =>
					listComputeAggregated(
						projectId,
						token,
						"forwardingRules",
						KIND.forwardingRule,
						selector,
					),
			},
			{
				kind: KIND.globalAddress,
				run: () =>
					listComputeGlobal(
						projectId,
						token,
						"addresses",
						KIND.globalAddress,
						selector,
					),
			},
			{
				kind: KIND.globalForwardingRule,
				run: () =>
					listComputeGlobal(
						projectId,
						token,
						"forwardingRules",
						KIND.globalForwardingRule,
						selector,
					),
			},
			{
				kind: KIND.sqlInstance,
				run: () => listSqlInstances(projectId, token, selector),
			},
		];

	const results = await Promise.all(
		sources.map((source) => listOrSkipUnreadable(source.kind, source.run)),
	);
	return results.flat();
}

// --- delete ----------------------------------------------------------------------------------------

// A delete is issued against the resource's self-link, and a self-link is a URL. So before we send DELETE
// to a string that came out of a list response, we prove it is a self-link of the service that owns the
// kind. Nothing else can be deleted through here — not a name, not a relative path, not another host.
const COMPUTE_SELF_LINKS = [
	"https://www.googleapis.com/compute/v1/projects/",
	"https://compute.googleapis.com/compute/v1/projects/",
] as const;
const CONTAINER_SELF_LINKS = [
	"https://container.googleapis.com/v1/projects/",
] as const;
const SQL_SELF_LINKS = [
	"https://sqladmin.googleapis.com/sql/v1beta4/projects/",
	"https://sqladmin.googleapis.com/v1/projects/",
] as const;

/**
 * The self-link prefixes a delete is permitted to target, per kind. Doubles as the set of kinds we can
 * delete at all: a kind absent from this map is refused rather than guessed at.
 *
 * Networks / subnetworks / firewalls / routers appear here even though list() can never produce one (GCP
 * does not label them) — the ordering below still has to name them, and a delete by exact self-link is
 * correct if any other path ever hands us one. `google_compute_router_nat` is NOT a kind: a Cloud NAT is a
 * field of its router, and dies with it.
 */
const DELETABLE: Record<string, readonly string[]> = {
	[KIND.cluster]: CONTAINER_SELF_LINKS,
	[KIND.nodePool]: CONTAINER_SELF_LINKS,
	[KIND.instance]: COMPUTE_SELF_LINKS,
	[KIND.disk]: COMPUTE_SELF_LINKS,
	[KIND.address]: COMPUTE_SELF_LINKS,
	[KIND.globalAddress]: COMPUTE_SELF_LINKS,
	[KIND.forwardingRule]: COMPUTE_SELF_LINKS,
	[KIND.globalForwardingRule]: COMPUTE_SELF_LINKS,
	[KIND.firewall]: COMPUTE_SELF_LINKS,
	[KIND.router]: COMPUTE_SELF_LINKS,
	[KIND.subnetwork]: COMPUTE_SELF_LINKS,
	[KIND.network]: COMPUTE_SELF_LINKS,
	[KIND.sqlInstance]: SQL_SELF_LINKS,
};

/**
 * Deletes ONE resource by its exact native id (its self-link). Called only for resources guards.ts has
 * already cleared. Idempotent: an already-deleted resource (404) is a success.
 *
 * Deleting a GKE cluster removes its node pools and their VMs/disks; deleting a router removes its Cloud
 * NAT. A resource still in use answers 400/409 (a disk attached to a live instance, a subnetwork still
 * holding one) — that surfaces, and the next sweep retries once deleteOrder has cleared the dependent.
 */
async function remove(
	identityId: string,
	resource: CloudResourceRef,
): Promise<void> {
	const prefixes = DELETABLE[resource.kind];
	if (!prefixes) {
		throw new Error(`gcp reclaim: unknown kind ${resource.kind}`);
	}
	if (!prefixes.some((prefix) => resource.native_id.startsWith(prefix))) {
		throw new Error(
			`gcp reclaim: refusing to DELETE "${resource.native_id}" — not a ${resource.kind} self-link`,
		);
	}
	const { token } = await gcpSession(identityId);
	await gcpDelete(resource.native_id, token);
}

export const gcpReclaim: ReclaimAdapter = {
	provider: "gcp",
	list,
	delete: remove,
	// Most-dependent FIRST. Node pools before the cluster; the cluster and any labelled VMs before the
	// load-balancing objects pointing at them; Cloud SQL before the network it holds a private-services
	// peering into; disks once nothing is attached to them; and the VPC last, since a network refuses to
	// die while a single firewall rule, router or subnetwork still lives in it.
	deleteOrder: [
		KIND.nodePool,
		KIND.cluster,
		KIND.instance,
		KIND.sqlInstance,
		KIND.globalForwardingRule,
		KIND.forwardingRule,
		KIND.globalAddress,
		KIND.address,
		KIND.disk,
		KIND.firewall,
		KIND.router,
		KIND.subnetwork,
		KIND.network,
	],
};
