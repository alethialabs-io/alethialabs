// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The CLI project-component registry — the single source of the component KINDS the
// `alethia project component` group can author, and the per-kind validation of the
// generic `--set key=value` field setter. Each kind maps to one drizzle component table
// (project_network, project_databases, …); singletons are 1:1 per project, multi kinds are
// keyed on (project_id, name). The `fields` of an add request are validated against the
// table's drizzle-zod insert schema (picked down to the user-settable columns) so an
// unknown or mistyped field is a clear 400 — code and DB never drift.

import { createHash } from "node:crypto";
import { createInsertSchema } from "drizzle-zod";
import { and, eq, getTableColumns, notInArray, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
	DEFAULT_COUNT_CAP,
	afterCursor,
	countScoped,
	cursorKey,
	decodeCursor,
	encodeCursor,
	pageFetchLimit,
	pageOrder,
	parsePageOpts,
	type CursorPosition,
	type CursorScope,
	type PageInfo,
} from "@/lib/cli/paging";
import {
	DEFAULT_INSTANCE_TYPE,
	type CloudProviderSlug,
} from "@/lib/cloud-providers/generated/catalog";
import { applySizingOneWriter } from "@/lib/cloud-providers/node-sizing";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import { getServiceDb, type Db, type Tx } from "@/lib/db";
import { asRecord } from "@/lib/records";
import {
	cloudIdentities,
	projects,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectHelmRegistries,
	projectNetwork,
	projectNosqlTables,
	projectObservability,
	projectQueues,
	projectRepositories,
	projectEnvironments,
	projectSecrets,
	projectStorageBuckets,
	projectTopics,
} from "@/lib/db/schema";
import {
	ProviderConfigRefusedError,
	hasProviderConfig,
	mergeProviderConfig,
	providerConfigPatchSchema,
	resolveProviderConfigPatch,
} from "@/lib/cli/provider-config-knobs";
import { actorIdentityWhere } from "@/lib/runners/claim-identity";
import { appsPathSchema } from "@/lib/validations/apps-path";
import {
	clusterNodeSizingBounds,
	nodeSizeSchema,
} from "@/lib/validations/project-form.schema";

/** A component as it appears on the CLI wire — uniform across every kind. `config` is the
 * kind-specific column set as an open object (mirrors componentWire). */
export interface ComponentWire {
	id: string;
	kind: string;
	name: string;
	status: string;
	cloud_identity_id: string | null;
	config: Record<string, unknown>;
	/** The row's revision, `updated_at` as ISO-8601 — what `If-Match` is compared with (#5551). */
	updated_at: string | null;
}

/** One supported component kind. `fields` is the drizzle-zod insert schema narrowed to the
 * user-settable columns (everything else is server-managed). */
interface KindDef {
	table: PgTable;
	singleton: boolean;
	fields: z.ZodTypeAny;
}

// Columns never surfaced in `config` (server-managed envelope + secrets). Name + status +
// cloud_identity_id are surfaced as dedicated wire fields; everything else is config.
//
// This is a DENY list, so a column added to a component table surfaces in `config` unless it is
// named here — nothing else fails when one is missed. `org_id` (#4823 put the tenancy column on
// every table this registry reads) is server-managed, cannot be `--set` (no kind's pick schema
// below includes it), and was riding every list/add/upsert response as if it were user config
// (#4847).
// tests/lib/cli/project-components-wire.test.ts pins it absent on all three shapes.
const WIRE_EXCLUDE = new Set<string>([
	"id",
	"org_id",
	"project_id",
	"created_at",
	"updated_at",
	"status",
	"status_message",
	"estimated_monthly_cost",
	"name",
	"cloud_identity_id",
	"argocd_url",
	"cluster_endpoint",
	"endpoint",
	"reader_endpoint",
	"provider_outputs",
	"repository_url",
	"secret_ref",
	"cursor_key",
]);

/**
 * The `provider_config` field every kind whose table has the column accepts (#5529): an object of
 * template-knob overrides, `null` removing a key. This is the SHAPE only — which keys, at what type,
 * depends on the component's cloud and is decided on the write path by `resolveProviderConfigPatch`
 * (lib/cli/provider-config-knobs.ts), over the same `offerableKnobs` the canvas renders. A write
 * MERGES into the stored object; it never replaces it.
 */
const PROVIDER_CONFIG_FIELD = { provider_config: providerConfigPatchSchema.optional() };

/** The component-kind registry. The pick-lists are the columns a CLI caller may `--set`;
 * server-managed columns (status, endpoints, provider_outputs) are excluded. `provider_config` is
 * added by {@link PROVIDER_CONFIG_FIELD} on the kinds whose table has it. */
const KINDS: Record<string, KindDef> = {
	network: {
		table: projectNetwork,
		singleton: true,
		fields: createInsertSchema(projectNetwork)
			.pick({
				cloud_identity_id: true,
				region: true,
				provision_network: true,
				network_id: true,
				cidr_block: true,
				single_nat_gateway: true,
				allowed_cidr_blocks: true,
			})
			.partial(),
	},
	cluster: {
		table: projectCluster,
		singleton: true,
		// The sizing bounds are IMPORTED, not restated. This registry builds a fresh insert
		// schema and shares no validator with the canvas, so a bound added only there left
		// `alethia project component set cluster node_min_size=-4` wide open — one definition,
		// two write paths. The cross-field rule (min <= desired <= max) can't live here: it
		// needs a `.superRefine`, and validateComponentFields introspects `.shape` to reject
		// unknown keys, which a ZodEffects wrapper would empty out. CloudProvider.ValidateConfig
		// is the backstop that catches it on this path.
		//
		// node_disk_size_gb is bounded HERE, not in clusterNodeSizingBounds: the canvas bounds it
		// per field in its inspector (config-schema.ts), with a per-cloud floor this registry cannot
		// apply because it has no provider in hand. 1..2000 matches the canvas max; the per-cloud
		// floor (Azure 30, and so on) is enforced by validateNodeDiskSize in
		// packages/core/cloud/validate.go, which every provider's ValidateConfig calls.
		//
		// node_size is the cloud-indifferent size (#5267). It takes a JSON object —
		// `--set 'node_size={"vcpu":4,"memory_gb":16}'` — and is subject to the one-writer rule with
		// instance_types: validateComponentFields clears whichever the write did not set.
		fields: createInsertSchema(projectCluster, {
			...clusterNodeSizingBounds,
			node_disk_size_gb: z.number().int().min(1).max(2000).nullable().optional(),
			node_size: nodeSizeSchema.nullable().optional(),
		})
			.pick({
				cloud_identity_id: true,
				region: true,
				cluster_version: true,
				instance_types: true,
				node_size: true,
				capacity_type: true,
				node_min_size: true,
				node_max_size: true,
				node_desired_size: true,
				node_disk_size_gb: true,
				cluster_name: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	dns: {
		table: projectDns,
		singleton: true,
		fields: createInsertSchema(projectDns)
			.pick({
				cloud_identity_id: true,
				region: true,
				enabled: true,
				provider: true,
				zone_id: true,
				domain_name: true,
				managed_certificate: true,
				waf_enabled: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	observability: {
		table: projectObservability,
		singleton: true,
		fields: createInsertSchema(projectObservability)
			.pick({
				cloud_identity_id: true,
				region: true,
				enabled: true,
				provider: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	repositories: {
		table: projectRepositories,
		singleton: true,
		fields: createInsertSchema(projectRepositories)
			.pick({ apps_destination_repo: true, apps_path: true })
			.partial()
			// #1767 — `.extend` LAST so the mirrored guard wins over the bare nullable text()
			// column drizzle-zod infers. Without it `--set apps_path=../../etc` is a clean 200
			// straight into the DB and thence into buildConfigSnapshot, and the user only finds
			// out when the deploy job dies on argocd.ValidateAppsPath.
			.extend({ apps_path: appsPathSchema }),
	},
	databases: {
		table: projectDatabases,
		singleton: false,
		fields: createInsertSchema(projectDatabases)
			.pick({
				cloud_identity_id: true,
				region: true,
				engine: true,
				engine_version: true,
				min_capacity: true,
				max_capacity: true,
				port: true,
				backup_retention_days: true,
				iam_auth: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	caches: {
		table: projectCaches,
		singleton: false,
		fields: createInsertSchema(projectCaches)
			.pick({
				cloud_identity_id: true,
				region: true,
				engine: true,
				node_type: true,
				num_cache_nodes: true,
				multi_az: true,
				allowed_cidr_blocks: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	queues: {
		table: projectQueues,
		singleton: false,
		fields: createInsertSchema(projectQueues)
			.pick({
				cloud_identity_id: true,
				region: true,
				ordered: true,
				visibility_timeout: true,
				message_retention: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	topics: {
		table: projectTopics,
		singleton: false,
		fields: createInsertSchema(projectTopics)
			.pick({ cloud_identity_id: true, region: true })
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	nosql_tables: {
		table: projectNosqlTables,
		singleton: false,
		fields: createInsertSchema(projectNosqlTables)
			.pick({
				cloud_identity_id: true,
				region: true,
				table_type: true,
				partition_key: true,
				partition_key_type: true,
				sort_key: true,
				sort_key_type: true,
				capacity_mode: true,
				point_in_time_recovery: true,
				global_replicas: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	container_registries: {
		table: projectContainerRegistries,
		singleton: false,
		fields: createInsertSchema(projectContainerRegistries)
			.pick({
				cloud_identity_id: true,
				region: true,
				provider: true,
				// `repository_url` is NOT here, and the omission is the point: it is a write-back slot
				// the deploy fills with the registry it actually created (see the column's own comment
				// in lib/db/schema/project-components.ts), which is why WIRE_EXCLUDE strips it from the
				// config the runner reads. Accepting it from `--set` validated a value, stored it, and
				// then overwrote it — input taken and discarded, with nothing to tell the caller.
				// Typed columns since #1811, so `--set` reaches them the same way it reaches nosql's
				// point_in_time_recovery. While they were provider_config keys the CLI could not
				// touch them at all.
				immutable_tags: true,
				vulnerability_scanning: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	// A chart repo's HOST lives in the JSONB provider_config, and no template declares it as a knob,
	// so the provider_config allow-list (#5529) offers nothing here: the CLI can list/read these and
	// switch the connector but not finish configuring an "any host" provider — that needs the console.
	helm_registries: {
		table: projectHelmRegistries,
		singleton: false,
		fields: createInsertSchema(projectHelmRegistries)
			.pick({
				cloud_identity_id: true,
				region: true,
				provider: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	secrets: {
		table: projectSecrets,
		singleton: false,
		fields: createInsertSchema(projectSecrets)
			.pick({
				cloud_identity_id: true,
				region: true,
				provider: true,
				generate: true,
				length: true,
				special_chars: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
	storage_buckets: {
		table: projectStorageBuckets,
		singleton: false,
		fields: createInsertSchema(projectStorageBuckets)
			.pick({
				cloud_identity_id: true,
				region: true,
				versioning: true,
				encryption_enabled: true,
				public_access: true,
				cors_origins: true,
			})
			.partial()
			.extend(PROVIDER_CONFIG_FIELD),
	},
};

/** The list of supported component kinds (stable order), for the `kinds` command + docs. */
export const COMPONENT_KINDS = Object.keys(KINDS);

/** Resolves a kind name to its definition, or null when the kind is unknown. */
export function getKindDef(kind: string): KindDef | null {
	return Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
}

/** True if the kind is a project singleton (1:1, name-less). */
export function isSingletonKind(kind: string): boolean {
	const def = getKindDef(kind);
	return def ? def.singleton : false;
}

// ─────────────────────────────────────────────────────────────────────────────
// The PUBLISHED schema (#3671)
//
// Everything above this line is the server's private opinion of what a component kind is. The
// CLI holds a SECOND opinion — `componentKinds` and `singletonKinds`, two literals in
// apps/cli/cmd/project_component.go — and the two have already drifted: `helm_registries` is in
// this registry and is not in that list, so `alethia project component kinds` does not name a
// kind the server will happily author.
//
// A wire projection of THIS registry is what turns that literal into a cache. It carries the
// three things the CLI reads a registry for:
//
//   • which kinds exist, in a stable order   (`componentKinds`)
//   • which of them are 1:1 per environment  (`singletonKinds`)
//   • what `--set key=value` may assign, and AT WHAT TYPE
//
// The third closes the `--set` split-brain. Today coercion lives in Go — `coerceSetValue` JSON-
// decodes the raw text with no idea what the field is — and validation lives here, so
// `--set cluster_version=1.35` becomes the NUMBER 1.35 and this registry refuses it against a
// `text()` column, with the documented workaround being to quote it. A client that has read
// `{"cluster_version": {"type": "string"}}` can coerce per field instead of per literal, and it
// can refuse a bad value before spending a round trip.
//
// The document is deliberately never STRICTER than the server. Some of this registry's rules are
// not expressible in JSON Schema at all — apps_path's mirrored grammar is a `.refine`, so it
// publishes as plain `string` — so what ships is a SUPERSET of what the server accepts. That is
// the safe direction, and it is the epic's invariant: a client validating against this document
// can only ever refuse a value the server would also refuse, never one it would have taken.

/** One published component kind. */
export interface PublishedComponentKind {
	kind: string;
	/** 1:1 per (project, environment) — the CLI's `singletonKinds`, no longer hand-typed. */
	singleton: boolean;
	/** Settable field names, in registry order. DERIVED from `schema.properties` — never
	 *  written out separately, so the list and the schema cannot disagree. */
	fields: string[];
	/** JSON Schema (draft-7) of the `fields` object of an add / `--set` request. */
	schema: Record<string, unknown>;
}

/** The published component-kind registry as it goes over the wire. */
export interface ComponentSchemaDocument {
	/** sha256 over the serialized `kinds` — the CLI's cache key and the route's ETag, so a cached
	 *  copy can be revalidated for free and changes when the published registry does. */
	version: string;
	kinds: PublishedComponentKind[];
}

/** The wire contract for {@link ComponentSchemaDocument}, so `cliJson` validates the bytes that
 *  actually ship. `kinds` is bounded below on purpose: an empty document is not a small answer,
 *  it is a client that will refuse every `--kind`, and it must be a 500 rather than a 200. */
export const componentSchemaWire = z.object({
	version: z.string().min(1),
	kinds: z
		.array(
			z.object({
				kind: z.string().min(1),
				singleton: z.boolean(),
				fields: z.array(z.string().min(1)),
				schema: z.record(z.string(), z.unknown()),
			}),
		)
		.min(1),
});

/**
 * Fails loudly on a VACUOUS published registry — zero kinds, or a kind that publishes zero
 * settable fields.
 *
 * Both are silent-wrong-answer shapes rather than errors: a client caching an empty `kinds`
 * array refuses every `--kind` the server would have accepted, and a kind whose `properties`
 * came back empty tells the client "nothing is settable here" when in fact everything is. Both
 * render as a working CLI that has quietly lost a capability, so the census is asserted rather
 * than assumed.
 *
 * Exported so the zero census can be driven directly — a guard whose failure branch has never
 * run is a comment.
 */
export function assertComponentSchemaPublishable(
	kinds: readonly PublishedComponentKind[],
): void {
	if (kinds.length === 0) {
		throw new Error(
			"component schema: the kind registry published ZERO kinds — a client caching this document would refuse every --kind",
		);
	}
	const empty = kinds.filter((k) => k.fields.length === 0).map((k) => k.kind);
	if (empty.length > 0) {
		throw new Error(
			`component schema: kind(s) published no settable fields: ${empty.join(", ")} — a client caching this document would refuse every --set for them`,
		);
	}
}

/** Projects the private registry into the published document. */
function buildComponentSchemaDocument(): ComponentSchemaDocument {
	const kinds = COMPONENT_KINDS.map((kind) => {
		const def = KINDS[kind];
		// `io: "input"` because this document describes what a caller may SEND, and draft-7 to
		// match the target the Go contract fixtures are already generated at
		// (apps/console/scripts/gen-cli-fixtures.ts).
		//
		// `unrepresentable` is left at its default (THROW) rather than "any", because `{}` is a
		// node that accepts everything and that is the one answer a client must never cache.
		//
		// The throw is NOT a build failure, and it would be wrong to describe it as one. This
		// builder is reachable only through the memoized componentSchemaDocument(), so on its own
		// the first symptom of an inexpressible field would be a 500 on the first REQUEST in
		// production. What catches it before a deploy is a named unit test — "expresses every
		// published kind as JSON Schema" in tests/lib/cli/component-schema.test.ts drives this
		// function directly.
		//
		// The reachable case is a TIMESTAMP column: drizzle-zod infers `z.date()` for one, and
		// `created_at` / `updated_at` sit one line away in every pick-list below. Adding
		// `created_at: true` to a pick is green under `tsc --noEmit`, `eslint` and `next build`,
		// and red in the unit suite with "Date cannot be represented in JSON Schema" — measured,
		// not assumed. (A jsonb column is NOT this case: `provider_config` publishes an explicit
		// any-JSON-value union rather than an empty node.) The test is the guard.
		const schema = asRecord(
			z.toJSONSchema(def.fields, { target: "draft-7", io: "input" }),
		);
		return {
			kind,
			singleton: def.singleton,
			fields: Object.keys(asRecord(schema.properties)),
			schema,
		};
	});
	assertComponentSchemaPublishable(kinds);
	const version = createHash("sha256")
		.update(JSON.stringify(kinds))
		.digest("hex");
	return { version, kinds };
}

let schemaDocument: ComponentSchemaDocument | null = null;

/**
 * The published component-kind schema. Memoized: it is a pure projection of module-level
 * constants, so it is identical for every caller and every tenant, and its `version` must be
 * stable across requests for the ETag to mean anything.
 */
export function componentSchemaDocument(): ComponentSchemaDocument {
	if (!schemaDocument) schemaDocument = buildComponentSchemaDocument();
	return schemaDocument;
}

/** Maps a component row to its uniform CLI wire shape. */
export function rowToComponentWire(kind: string, row: unknown): ComponentWire {
	const rec = asRecord(row);
	const name =
		typeof rec.name === "string" && rec.name.length > 0 ? rec.name : kind;
	const status = typeof rec.status === "string" ? rec.status : "";
	const cloud =
		typeof rec.cloud_identity_id === "string" ? rec.cloud_identity_id : null;
	const config: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(rec)) {
		if (!WIRE_EXCLUDE.has(k)) config[k] = v;
	}
	return {
		id: String(rec.id),
		kind,
		name,
		status,
		cloud_identity_id: cloud,
		config,
		updated_at: componentRevision(rec),
	};
}

/** A row's revision: its `updated_at` as ISO-8601 at millisecond precision, or null when the row
 * has none. Millisecond, because that is what the driver hands back (a JS `Date`), and the write
 * guard below compares against the column truncated to the same precision. */
export function componentRevision(row: unknown): string | null {
	const value = asRecord(row).updated_at;
	const at = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
	return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
}

/**
 * The component statuses a write is refused in (#5551): a deploy is creating or changing the row's
 * resources (`CREATING`, `UPDATING`), or a destroy is removing them (`DESTROYING`). A change landing
 * mid-run is read by nothing that is running, and is then overwritten by the run's own write-back or
 * left on a row whose resources are gone. `PENDING`, `ACTIVE`, `FAILED` and `DESTROYED` are at rest.
 */
export const BUSY_COMPONENT_STATUSES: readonly string[] = ["CREATING", "UPDATING", "DESTROYING"];

/** What a write to an EXISTING component is conditioned on, beyond the status gate every such write
 * gets. `ifMatch` is the revision the caller read ({@link componentRevision}); null writes
 * unconditionally, which is what every caller that sends no `If-Match` gets. */
export interface ComponentWriteGuard {
	ifMatch: string | null;
}

/** The unconditional guard: the status gate only. */
const NO_PRECONDITION: ComponentWriteGuard = { ifMatch: null };

/** Why a guarded write was refused: the component is mid-run, or it is not the copy the caller read
 * (`component` is the server's copy now, null when it no longer exists). */
export type ComponentWriteRefusal =
	| { reason: "busy"; status: string; component: ComponentWire }
	| { reason: "changed"; component: ComponentWire | null };

/** Thrown by a guarded write the server refused — the routes answer it with a 409. Thrown rather
 * than returned so a refusal inside a transaction rolls it back. */
export class ComponentWriteRefusedError extends Error {
	readonly refusal: ComponentWriteRefusal;

	/** Builds the refusal with the sentence the 409 carries. */
	constructor(refusal: ComponentWriteRefusal) {
		super(refusalMessage(refusal));
		this.name = "ComponentWriteRefusedError";
		this.refusal = refusal;
	}
}

/** The 409 body a refused write answers with — `cliComponentConflictResponse` on the wire. The code
 * says which refusal, so a client can tell "wait for the run" from "re-read and retry" without
 * matching on the sentence. */
export function componentWriteRefusedBody(err: ComponentWriteRefusedError): {
	error: string;
	code: "component_busy" | "component_changed";
	status: string | null;
	component: ComponentWire | null;
} {
	const r = err.refusal;
	return r.reason === "busy"
		? { error: err.message, code: "component_busy", status: r.status, component: r.component }
		: {
				error: err.message,
				code: "component_changed",
				status: r.component?.status ?? null,
				component: r.component,
			};
}

/** The sentence a refusal is reported with — what to do next, not only what happened. */
function refusalMessage(r: ComponentWriteRefusal): string {
	if (r.reason === "busy") {
		const label = componentWireLabel(r.component);
		const doing = r.status === "DESTROYING" ? "being destroyed" : "being provisioned";
		return `${label} is ${r.status}: a component cannot be changed while it is ${doing}. Wait for the run to finish, then try again.`;
	}
	if (!r.component) {
		return "The component no longer exists: it was removed or replaced on the server since it was read. Read it again and retry.";
	}
	return `${componentWireLabel(r.component)} changed on the server since it was read (now at revision ${r.component.updated_at ?? "unknown"}). Read it again and retry.`;
}

/** `kind` for a singleton (its wire name is the kind) and `kind/name` for a named component. */
function componentWireLabel(c: ComponentWire): string {
	return c.name === c.kind ? c.kind : `${c.kind}/${c.name}`;
}

/**
 * Parses an `If-Match` header into a revision. Absent, empty or `*` is no precondition; a `W/` weak
 * prefix and the entity-tag quotes are accepted, since a client may send the revision either way.
 * Anything that is not a timestamp is refused rather than ignored: a precondition the server cannot
 * read must not quietly become an unconditional write.
 */
export function parseIfMatch(
	header: string | null,
): { ok: true; ifMatch: string | null } | { ok: false; error: string } {
	const raw = (header ?? "").trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1").trim();
	if (raw === "" || raw === "*") return { ok: true, ifMatch: null };
	const at = new Date(raw);
	if (Number.isNaN(at.getTime())) {
		return {
			ok: false,
			error: `If-Match must be the component's revision (its updated_at, e.g. "2026-01-01T00:00:00.000Z"), got ${JSON.stringify(raw)}`,
		};
	}
	return { ok: true, ifMatch: at.toISOString() };
}

/** The WHERE half of a guarded write: not mid-run, and — when the caller sent one — still at the
 * revision it read. In the statement itself rather than a prior read, so the row the check passes on
 * is the row the write changes: Postgres re-evaluates it on the locked row. */
function writableWhere(cols: Record<string, AnyColumn>, guard: ComponentWriteGuard): SQL | undefined {
	const conds: SQL[] = [];
	if (cols.status) conds.push(notInArray(cols.status, [...BUSY_COMPONENT_STATUSES]));
	if (guard.ifMatch !== null && cols.updated_at) {
		conds.push(sql`date_trunc('milliseconds', ${cols.updated_at}) = ${guard.ifMatch}::timestamptz`);
	}
	return conds.length > 0 ? and(...conds) : undefined;
}

/** Why a guarded write matched no row: reads the row the write addressed and names the refusal, or
 * returns null when there is no such row (the caller's 404). */
async function refusalFor(
	db: Db | Tx,
	def: KindDef,
	kind: string,
	where: SQL | undefined,
): Promise<ComponentWriteRefusedError | null> {
	const [row] = await db.select().from(def.table).where(where).limit(1);
	if (!row) return null;
	const component = rowToComponentWire(kind, row);
	if (BUSY_COMPONENT_STATUSES.includes(component.status)) {
		return new ComponentWriteRefusedError({ reason: "busy", status: component.status, component });
	}
	return new ComponentWriteRefusedError({ reason: "changed", component });
}

/** Result of validating an add request's `fields`: the typed values, or an error message. */
type ValidateResult =
	| { ok: true; values: Record<string, unknown> }
	| { ok: false; error: string };

/** Validates the raw `--set` fields against the kind's insert schema: rejects unknown keys
 * and type-mismatched values, returning a clear message for the 400. */
export function validateComponentFields(
	kind: string,
	fields: Record<string, unknown>,
): ValidateResult {
	const def = getKindDef(kind);
	if (!def) return { ok: false, error: `Unknown component kind "${kind}"` };

	const schema = def.fields;
	const allowed =
		schema instanceof z.ZodObject ? new Set(Object.keys(schema.shape)) : new Set<string>();
	const unknown = Object.keys(fields).filter((k) => !allowed.has(k));
	if (unknown.length > 0) {
		// network and repositories have no provider_config column, so there is nowhere for a template
		// knob to be stored — said outright rather than left as a bare "unknown field".
		const noPassthrough =
			unknown.includes("provider_config") && !hasProviderConfig(kind)
				? `. ${kind} has no provider_config column, so it takes no template knobs from the CLI`
				: "";
		return {
			ok: false,
			error: `Unknown field(s) for ${kind}: ${unknown.join(", ")}. Allowed: ${[...allowed].join(", ")}${noPassthrough}`,
		};
	}

	const parsed = schema.safeParse(fields);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		const path = first?.path.join(".") || "fields";
		return { ok: false, error: `Invalid value for ${path}: ${first?.message ?? "invalid"}` };
	}
	const values = asRecord(parsed.data);
	// The one-writer rule (#5267): setting node_size clears instance_types and vice versa, IN THIS
	// write — so a size set over the default-stamped instance type is not silently shadowed by it.
	return def.table === projectCluster ? applySizingOneWriter(values) : { ok: true, values };
}

/** The tenancy and filter identity of one component collection. */
export interface ComponentListScope {
	readonly orgId: string;
	readonly projectId: string;
	readonly kindFilter?: string;
	readonly environmentId?: string;
}

/** A heterogeneous component cursor: registry kind plus that table's immutable row position. */
interface ComponentCursorPosition extends CursorPosition {
	readonly kind: string;
}

/** Parsed paging inputs for the heterogeneous component collection. */
export interface ComponentPageOpts {
	readonly limit: number;
	readonly after: ComponentCursorPosition | null;
}

/** The result returned by the paged component query. */
export interface ComponentsPage {
	readonly components: ComponentWire[];
	readonly page: PageInfo;
}

/** An internal row coupled to the position from which its next cursor is minted. */
interface PagedComponent {
	readonly component: ComponentWire;
	readonly position: ComponentCursorPosition;
}

/** Returns the registry slice selected by the optional kind filter. */
function selectedComponentKinds(scope: ComponentListScope): string[] {
	return scope.kindFilter ? [scope.kindFilter] : COMPONENT_KINDS;
}

/**
 * Builds the shared codec scope for one position in the heterogeneous collection.
 *
 * The route has already established the project tenancy boundary before it calls this module,
 * but the cursor binds that same org and project plus both filters. Replaying a cursor after any
 * of them changes is therefore a 400 rather than an unrelated page. The registry kind is part of
 * the opaque scope because component UUIDs are unique only within their own physical table.
 */
function componentCursorScope(
	scope: ComponentListScope,
	positionKind: string,
): CursorScope {
	return {
		orgId: scope.orgId,
		list: JSON.stringify([
			"project-components",
			scope.projectId,
			scope.kindFilter ?? null,
			scope.environmentId ?? null,
			positionKind,
		]),
	};
}

/**
 * Parses the standard `limit` plus a cursor whose kind position is hidden inside its scope.
 *
 * The shared cursor envelope deliberately knows only `(created_at, id)`. Trying the finite
 * registry scopes recovers the one kind that minted it without inventing a second codec, while
 * preserving the shared malformed/foreign-scope error vocabulary.
 */
export function parseComponentPageOpts(
	params: URLSearchParams,
	scope: ComponentListScope,
):
	| { readonly ok: true; readonly opts: ComponentPageOpts }
	| { readonly ok: false; readonly error: string } {
	const kinds = selectedComponentKinds(scope);
	const limitParams = new URLSearchParams();
	const rawLimit = params.get("limit");
	if (rawLimit !== null) limitParams.set("limit", rawLimit);
	const parsedLimit = parsePageOpts(
		limitParams,
		componentCursorScope(scope, kinds[0] ?? "none"),
	);
	if (!parsedLimit.ok) return parsedLimit;

	const rawCursor = params.get("cursor");
	if (rawCursor === null || rawCursor === "") {
		return {
			ok: true,
			opts: { limit: parsedLimit.opts.limit, after: null },
		};
	}

	let syntacticallyValid = false;
	for (const kind of kinds) {
		const decoded = decodeCursor(componentCursorScope(scope, kind), rawCursor);
		if (decoded.ok) {
			return {
				ok: true,
				opts: {
					limit: parsedLimit.opts.limit,
					after: { kind, ...decoded.position },
				},
			};
		}
		if (decoded.reason === "foreign-scope") syntacticallyValid = true;
	}
	return {
		ok: false,
		error: syntacticallyValid
			? "cursor was issued for a different component collection"
			: "cursor is malformed",
	};
}

/** Counts the filtered collection to the shared aggregate ceiling, never once per page row. */
async function countProjectComponents(
	scope: ComponentListScope,
): Promise<{ readonly total: number; readonly mode: PageInfo["mode"] }> {
	const db = getServiceDb();
	let total = 0;
	for (const kind of selectedComponentKinds(scope)) {
		const def = getKindDef(kind);
		if (!def) continue;
		const cols = getTableColumns(def.table);
		const remaining = DEFAULT_COUNT_CAP - total;
		const counted = await countScoped(
			db,
			def.table,
			[componentScope(cols, scope.projectId, scope.environmentId)],
			remaining,
		);
		total += counted.total;
		if (counted.mode === "capped") {
			return { total: DEFAULT_COUNT_CAP, mode: "capped" };
		}
	}
	return { total, mode: "exact" };
}

/**
 * Lists one deterministic page of a project's heterogeneous components.
 *
 * Kinds are grouped in the published registry order. Within each kind rows use the shared,
 * immutable `(created_at DESC, id DESC)` order. Each physical table is queried for only the
 * remaining `limit + 1` rows, so neither page construction nor next-page detection materializes
 * a whole component table in JavaScript.
 */
export async function listProjectComponents(
	scope: ComponentListScope,
	opts: ComponentPageOpts,
): Promise<ComponentsPage> {
	if (opts.limit < 1) {
		throw new Error(
			`component page size must be at least 1, got ${opts.limit}`,
		);
	}
	const db = getServiceDb();
	const kinds = selectedComponentKinds(scope);
	const start = opts.after ? kinds.indexOf(opts.after.kind) : 0;
	if (start < 0)
		throw new Error("component cursor kind is outside the selected registry");
	const fetched: PagedComponent[] = [];
	const fetchLimit = pageFetchLimit({ limit: opts.limit, after: null });

	const countPromise = countProjectComponents(scope);
	for (
		let index = start;
		index < kinds.length && fetched.length < fetchLimit;
		index++
	) {
		const kind = kinds[index];
		if (!kind) continue;
		const def = getKindDef(kind);
		if (!def) continue;
		const cols = getTableColumns(def.table);
		const after = opts.after?.kind === kind ? opts.after : null;
		const where = and(
			componentScope(cols, scope.projectId, scope.environmentId),
			after ? afterCursor(after, cols.created_at, cols.id) : undefined,
		);
		const rows = await db
			.select({
				...cols,
				cursor_key: cursorKey(cols.created_at),
			})
			.from(def.table)
			.where(where)
			.orderBy(...pageOrder(cols.created_at, cols.id))
			.limit(fetchLimit - fetched.length);
		for (const row of rows) {
			const record = asRecord(row);
			if (
				typeof record.cursor_key !== "string" ||
				typeof record.id !== "string"
			) {
				throw new Error(`component ${kind} row is missing its cursor position`);
			}
			fetched.push({
				component: rowToComponentWire(kind, row),
				position: {
					kind,
					createdAt: record.cursor_key,
					id: record.id,
				},
			});
		}
	}

	const counted = await countPromise;
	const hasMore = fetched.length > opts.limit;
	const served = hasMore ? fetched.slice(0, opts.limit) : fetched;
	const last = served[served.length - 1];
	return {
		components: served.map((row) => row.component),
		page: {
			...counted,
			limit: opts.limit,
			next_cursor:
				hasMore && last
					? encodeCursor(
							componentCursorScope(scope, last.position.kind),
							last.position,
						)
					: null,
		},
	};
}

/** `project_id` AND, when given, `environment_id`. One helper so a caller cannot scope a read one
 * way and a delete another — which is the asymmetry that made the delete below destructive. */
function componentScope(
	cols: Record<string, AnyColumn>,
	projectId: string,
	environmentId?: string,
): SQL {
	const scope = eq(cols.project_id, projectId);
	if (!environmentId || !cols.environment_id) return scope;
	return and(scope, eq(cols.environment_id, environmentId)) ?? scope;
}

/** True when a cluster write names no instance type at all: the key absent, NULL, or `[]`. Each of
 * those reaches the snapshot as `[]`, i.e. "use the template's default". */
function hasNoInstanceTypes(value: unknown): boolean {
	return value == null || (Array.isArray(value) && value.length === 0);
}

/** The provisioning cloud a component row runs on: its own `cloud_identity_id` when it has one,
 * else the project's (a NULL per-component identity inherits it). `null` when no identity is
 * linked, the identity is gone, or its cloud has no catalog — the caller must then not guess: a new
 * cluster leaves its instance types unset, and a provider_config write is refused. */
async function componentProvider(
	db: Db | Tx,
	projectId: string,
	componentIdentityId: unknown,
): Promise<CloudProviderSlug | null> {
	let identityId = typeof componentIdentityId === "string" ? componentIdentityId : null;
	if (!identityId) {
		const [project] = await db
			.select({ cloud_identity_id: projects.cloud_identity_id })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		identityId = project?.cloud_identity_id ?? null;
	}
	if (!identityId) return null;
	const [identity] = await db
		.select({ provider: cloudIdentities.provider })
		.from(cloudIdentities)
		.where(eq(cloudIdentities.id, identityId))
		.limit(1);
	const provider = identity?.provider;
	return typeof provider === "string" && isCloudProviderSlug(provider) ? provider : null;
}

/** The two stored columns a provider_config write reads from the row it is about to amend. */
interface StoredProviderConfig {
	provider_config: unknown;
	cloud_identity_id: unknown;
}

/**
 * Reads the stored `provider_config` and `cloud_identity_id` of the ONE row a write will amend —
 * the environment's singleton, or the named multi row — or null when there is none yet.
 *
 * `FOR UPDATE`, and only ever called inside the transaction that then writes the merged object: the
 * row stays locked from this read to that write, so a concurrent save (the canvas, another CLI call)
 * waits rather than landing between them and being overwritten by a merge computed without it.
 */
async function readStoredProviderConfig(
	db: Db | Tx,
	def: KindDef,
	projectId: string,
	environmentId: string,
	name: string | null,
): Promise<StoredProviderConfig | null> {
	const cols = getTableColumns(def.table);
	const scope = componentScope(cols, projectId, environmentId);
	const [row] = await db
		.select({ provider_config: cols.provider_config, cloud_identity_id: cols.cloud_identity_id })
		.from(def.table)
		.where(name !== null && cols.name ? and(scope, eq(cols.name, name)) : scope)
		.for("update")
		.limit(1);
	return row ?? null;
}

/**
 * The `provider_config` a write stores, given the patch the caller sent (#5529).
 *
 * The patch is checked against the component's CLOUD — the identity the write sets, else the row's
 * own, else the project's — because the settable keys are per cloud: `resolveProviderConfigPatch`
 * allow-lists them from the same manifest the canvas renders and type-checks each value. A refusal
 * throws {@link ProviderConfigRefusedError}, which the routes answer with a 400.
 *
 * The result MERGES into what is stored: a key the caller did not send — including one the canvas
 * set — is kept, and a key sent as `null` is removed.
 */
async function providerConfigToStore(
	db: Db | Tx,
	kind: string,
	projectId: string,
	values: Record<string, unknown>,
	stored: StoredProviderConfig | null,
): Promise<Record<string, unknown>> {
	const identity =
		"cloud_identity_id" in values ? values.cloud_identity_id : stored?.cloud_identity_id;
	const cloud = await componentProvider(db, projectId, identity);
	if (!cloud) {
		throw new ProviderConfigRefusedError(
			`provider_config needs a cloud: link a cloud identity to the project (or set cloud_identity_id on the ${kind} component) — the settable keys depend on the cloud`,
		);
	}
	const resolved = resolveProviderConfigPatch(cloud, kind, asRecord(values.provider_config));
	if (!resolved.ok) throw new ProviderConfigRefusedError(resolved.error);
	return mergeProviderConfig(stored?.provider_config, resolved.set, resolved.unset);
}

/** Inserts a component of `kind` on a project, scoped to `environmentId`. Singletons upsert on the
 * composite `(project_id, environment_id)` — the table's actual unique; multi kinds require a name
 * and conflict (handled by the caller) on `(project_id, environment_id, name)`. Returns the
 * created/updated row's wire.
 *
 * A singleton that already exists is UPDATED, and that update is guarded like the PATCH's (#5551):
 * refused while the row is mid-run, and — when `guard.ifMatch` is set — refused unless the row is
 * still at that revision, in which case the row must exist (a precondition on a row that is gone is
 * not met, so it is never re-created). A refusal throws {@link ComponentWriteRefusedError}. */
export async function insertProjectComponent(
	kind: string,
	projectId: string,
	environmentId: string,
	name: string,
	values: Record<string, unknown>,
	guard: ComponentWriteGuard = NO_PRECONDITION,
): Promise<ComponentWire> {
	const def = getKindDef(kind);
	if (!def) throw new Error(`Unknown component kind "${kind}"`);
	const db = getServiceDb();
	// A write without provider_config reads nothing extra and stores exactly what it did before #5529.
	if (values.provider_config === undefined) {
		return insertComponentWith(db, def, kind, projectId, environmentId, name, values, guard);
	}
	// A provider_config patch is resolved against the cloud and MERGED into the row it amends — for a
	// singleton the environment's existing row (add upserts), for a new multi row nothing — in ONE
	// transaction, the row locked from the read to the write.
	return db.transaction(async (tx) => {
		const stored = def.singleton
			? await readStoredProviderConfig(tx, def, projectId, environmentId, null)
			: null;
		const merged = await providerConfigToStore(tx, kind, projectId, values, stored);
		return insertComponentWith(
			tx,
			def,
			kind,
			projectId,
			environmentId,
			name,
			{ ...values, provider_config: merged },
			guard,
		);
	});
}

/** The body of {@link insertProjectComponent}, on the connection or transaction it is handed. */
async function insertComponentWith(
	db: Db | Tx,
	def: KindDef,
	kind: string,
	projectId: string,
	environmentId: string,
	name: string,
	values: Record<string, unknown>,
	guard: ComponentWriteGuard,
): Promise<ComponentWire> {
	const cols = getTableColumns(def.table);

	// environment_id is required — a component in a NULL env is invisible to the env-scoped deploy,
	// and the singleton unique is composite, so the conflict target below must include it.
	const insertValues: Record<string, unknown> = {
		project_id: projectId,
		environment_id: environmentId,
		...values,
	};
	if (!def.singleton) insertValues.name = name;

	// A dedicated environment's cluster carries the Fabric linkage, and that linkage has to be
	// made HERE because nothing else makes it at runtime. `project_cluster`
	// was written env-keyed with a null `fabric_id`, and the only thing that ever filled it was
	// a migration-time backfill in programmables.sql — which by definition cannot reach a project
	// created after it ran, i.e. every real project.
	//
	// The consequence was not a null column, it was the whole isolation ladder. The Fabric's own
	// `dedicated` env still resolved, because resolveServingCluster falls back to the env-keyed
	// row; but a `namespace` or `vcluster` env has no cluster row of its own and resolves ONLY by
	// Fabric, so it found nothing and the deploy failed closed with "no serving cluster on the
	// config snapshot — the Fabric's cluster must be provisioned", against a cluster that was
	// provisioned, ACTIVE and serving. Every shared placement was unreachable.
	const fabricLinked = "fabric_id" in cols;
	if (fabricLinked) {
		const [env] = await db
			.select({
				fabric_id: projectEnvironments.fabric_id,
				placement_mode: projectEnvironments.placement_mode,
			})
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, environmentId))
			.limit(1);
		if (env?.placement_mode === "dedicated") {
			insertValues.fabric_id = env.fabric_id;
		} else {
			delete insertValues.fabric_id;
		}
	}

	// A NEW cluster row with no instance types gets the catalog's default node for its cloud (#5251).
	// Left empty, the snapshot carries `[]` and the template's own default applies — which was 2×
	// m5a.4xlarge on AWS until #5266 pinned every template default equal to the catalog's; the row is
	// still stamped so it states its node rather than inheriting one. INSERT ONLY: this goes into `insertValues` and never into the ON CONFLICT `set` below,
	// because `component add` upserts and an existing row the caller is amending must keep exactly
	// what it has — a NULL there is a deployed cluster's current shape, and back-filling it would
	// re-shape (replace the node pool of) a running cluster on its next apply.
	//
	// Only when the write names NEITHER sizing field: a write that set node_size arrives here with
	// `instance_types: []` (the one-writer rule cleared it), and stamping a default over that would
	// shadow the size the caller just chose.
	if (
		def.table === projectCluster &&
		hasNoInstanceTypes(insertValues.instance_types) &&
		insertValues.node_size == null
	) {
		const provider = await componentProvider(db, projectId, insertValues.cloud_identity_id);
		// Unknown provider (no linked identity yet, or a cloud with no catalog): leave it NULL and
		// let the template default apply, exactly as before. Guessing a cloud would stamp another
		// cloud's SKU on the row.
		if (provider) insertValues.instance_types = [DEFAULT_INSTANCE_TYPE[provider]];
	}

	if (def.singleton) {
		// The conflict branch must carry the linkage too. `add` upserts, so the row a caller is
		// amending is very often one written before this fix — repairing it on write is what makes
		// the fix reach existing projects without a data migration.
		//
		// `updated_at` moves on the conflict arm, so the next `If-Match` against this row sees the change
		// — before #5551 an upsert left it where the INSERT put it.
		const updateValues = fabricLinked
			? { ...values, fabric_id: insertValues.fabric_id ?? null, updated_at: new Date() }
			: { ...values, updated_at: new Date() };
		const scope = componentScope(cols, projectId, environmentId);
		const writable = writableWhere(cols, guard);
		// A precondition names a row the caller READ, so it is an UPDATE of that row and never an
		// insert: a singleton removed since the read is a refusal, not a fresh row carrying only the
		// fields that changed.
		const [row] = guard.ifMatch !== null
			? await db.update(def.table).set(updateValues).where(and(scope, writable)).returning()
			: await db
					.insert(def.table)
					.values(insertValues)
					.onConflictDoUpdate({
						target: [cols.project_id, cols.environment_id],
						set: updateValues,
						// The status gate on the conflict arm: an existing row mid-run is not updated, and
						// RETURNING then yields nothing.
						setWhere: writable,
					})
					.returning();
		if (row) return rowToComponentWire(kind, row);
		throw (
			(await refusalFor(db, def, kind, scope)) ??
			new ComponentWriteRefusedError({ reason: "changed", component: null })
		);
	}
	const [row] = await db.insert(def.table).values(insertValues).returning();
	return rowToComponentWire(kind, row);
}

/**
 * Whether a component write may carry the `cloud_identity_id` in `values`.
 *
 * True when the write names no identity (the key absent, or `null` to re-inherit the project's),
 * or names one the caller may use: an `org`-scoped identity of `orgId`, or — when a person is
 * calling, `personalAuthorId` — that person's own `personal` identity. This is
 * {@link actorIdentityWhere}, the predicate the project create route binds its identity with
 * (#5479, #5481).
 *
 * The column is only a foreign key to `cloud_identities.id`, and CLI routes run on the
 * service-role db with no RLS, so without this an `add` or an update could point a component at
 * ANOTHER org's identity by guessing its id. Both component write routes call it before writing.
 */
export async function componentIdentityAllowed(
	values: Record<string, unknown>,
	orgId: string,
	personalAuthorId: string | undefined,
): Promise<boolean> {
	const id = values.cloud_identity_id;
	if (id === undefined || id === null) return true;
	if (typeof id !== "string") return false;
	const [row] = await getServiceDb()
		.select({ id: cloudIdentities.id })
		.from(cloudIdentities)
		.where(actorIdentityWhere(id, orgId, personalAuthorId))
		.limit(1);
	return Boolean(row);
}

/** Updates the settable fields of ONE named (multi-kind) component in ONE environment, and returns
 * its wire — or null when no component of that name exists there (the caller's 404).
 *
 * `values` must already have passed {@link validateComponentFields}, the same check `add` runs, so
 * "settable" has one definition for both writes. Only the keys in `values` are written; every
 * other column keeps what it holds, which is what lets `alethia apply` send just the fields that
 * changed. The row is matched on `(project_id, environment_id, name)` — the table's own unique —
 * through {@link componentScope}, the helper the delete uses, so a sibling environment's row of
 * the same name is never touched.
 *
 * Singletons are refused rather than handled: they have no name to address and `add` upserts
 * them, so a second write path for them would only be a second set of rules.
 *
 * The write is guarded (#5551): a row mid-run is refused, and with `guard.ifMatch` a row no longer at
 * that revision is refused — both as {@link ComponentWriteRefusedError}, in the UPDATE's own WHERE so
 * nothing can land between the check and the write. */
export async function updateProjectComponent(
	kind: string,
	projectId: string,
	environmentId: string,
	name: string,
	values: Record<string, unknown>,
	guard: ComponentWriteGuard = NO_PRECONDITION,
): Promise<ComponentWire | null> {
	const def = getKindDef(kind);
	if (!def) throw new Error(`Unknown component kind "${kind}"`);
	if (def.singleton) throw new Error(`${kind} is a singleton — it is updated by add`);
	if (Object.keys(values).length === 0) {
		throw new Error("updateProjectComponent: no fields to update");
	}
	const cols = getTableColumns(def.table);
	const nameCol = cols.name;
	if (!nameCol) throw new Error(`${kind} has no name column`);
	const db = getServiceDb();
	/** The UPDATE itself, on the connection or transaction it is handed. */
	const target = and(componentScope(cols, projectId, environmentId), eq(nameCol, name));
	const write = async (q: Db | Tx, set: Record<string, unknown>) => {
		const [row] = await q
			.update(def.table)
			.set({ ...set, updated_at: new Date() })
			.where(and(target, writableWhere(cols, guard)))
			.returning();
		if (row) return rowToComponentWire(kind, row);
		// Nothing matched: no such row (null, the 404), or a row the guard refused.
		const refusal = await refusalFor(q, def, kind, target);
		if (refusal) throw refusal;
		return null;
	};
	if (values.provider_config === undefined) return write(db, values);
	// provider_config merges per key into the stored object (#5529): read the row FOR UPDATE, merge,
	// write, in one transaction. No row is the caller's 404, the answer the update itself would give.
	return db.transaction(async (tx) => {
		const stored = await readStoredProviderConfig(tx, def, projectId, environmentId, name);
		if (!stored) return null;
		const merged = await providerConfigToStore(tx, kind, projectId, values, stored);
		return write(tx, { ...values, provider_config: merged });
	});
}

/** Deletes a component within ONE environment. Singletons delete that environment's single row;
 * multi kinds delete the named row in it. Returns whether a row was removed (false → 404).
 *
 * `environmentId` is REQUIRED, and that is the fix rather than a convenience. This used to scope a
 * singleton delete to `project_id` alone, so `component remove --kind cluster` deleted the cluster
 * row of EVERY environment — for a multi-tier project, one command silently destroying the sibling
 * environment's design. Harmless while the insert path could only ever write the default
 * environment; a data-loss bug the moment per-environment authoring exists, which is the same
 * change that introduces it. Pass the environment the caller actually named. */
export async function deleteProjectComponent(
	kind: string,
	projectId: string,
	name: string,
	environmentId: string,
): Promise<boolean> {
	const def = getKindDef(kind);
	if (!def) return false;
	const db = getServiceDb();
	const cols = getTableColumns(def.table);

	const scope = componentScope(cols, projectId, environmentId);
	const where =
		def.singleton || !cols.name ? scope : and(scope, eq(cols.name, name));

	const deleted = await db.delete(def.table).where(where).returning();
	return deleted.length > 0;
}
