// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The CLI project-component registry — the single source of the component KINDS the
// `alethia project component` group can author, and the per-kind validation of the
// generic `--set key=value` field setter. Each kind maps to one drizzle component table
// (project_network, project_databases, …); singletons are 1:1 per project, multi kinds are
// keyed on (project_id, name). The `fields` of an add request are validated against the
// table's drizzle-zod insert schema (picked down to the user-settable columns) so an
// unknown or mistyped field is a clear 400 — code and DB never drift.

import { createInsertSchema } from "drizzle-zod";
import { and, eq, getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import {
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectNetwork,
	projectNosqlTables,
	projectObservability,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectStorageBuckets,
	projectTopics,
} from "@/lib/db/schema";

/** A component as it appears on the CLI wire — uniform across every kind. `config` is the
 * kind-specific column set as an open object (mirrors componentWire). */
export interface ComponentWire {
	id: string;
	kind: string;
	name: string;
	status: string;
	cloud_identity_id: string | null;
	config: Record<string, unknown>;
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
const WIRE_EXCLUDE = new Set<string>([
	"id",
	"project_id",
	"created_at",
	"updated_at",
	"status",
	"status_message",
	"estimated_monthly_cost",
	"name",
	"cloud_identity_id",
	"argocd_admin_password",
	"argocd_url",
	"cluster_endpoint",
	"endpoint",
	"reader_endpoint",
	"provider_outputs",
	"repository_url",
	"secret_ref",
]);

/** The component-kind registry. The pick-lists are the columns a CLI caller may `--set`;
 * server-managed columns (status, endpoints, provider_outputs, JSONB provider_config) are
 * intentionally excluded — nested JSONB config is not settable via the scalar `--set` flag. */
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
		fields: createInsertSchema(projectCluster)
			.pick({
				cloud_identity_id: true,
				region: true,
				cluster_version: true,
				instance_types: true,
				node_min_size: true,
				node_max_size: true,
				node_desired_size: true,
				cluster_name: true,
			})
			.partial(),
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
			.partial(),
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
			.partial(),
	},
	repositories: {
		table: projectRepositories,
		singleton: true,
		fields: createInsertSchema(projectRepositories)
			.pick({ apps_destination_repo: true })
			.partial(),
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
			.partial(),
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
			.partial(),
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
			.partial(),
	},
	topics: {
		table: projectTopics,
		singleton: false,
		fields: createInsertSchema(projectTopics)
			.pick({ cloud_identity_id: true, region: true })
			.partial(),
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
			.partial(),
	},
	container_registries: {
		table: projectContainerRegistries,
		singleton: false,
		fields: createInsertSchema(projectContainerRegistries)
			.pick({
				cloud_identity_id: true,
				region: true,
				provider: true,
				repository_url: true,
			})
			.partial(),
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
			.partial(),
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
			.partial(),
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

/** Converts a row/value into a plain key/value record without an unsafe cast. */
function toRecord(row: unknown): Record<string, unknown> {
	return row && typeof row === "object"
		? Object.fromEntries(Object.entries(row))
		: {};
}

/** Maps a component row to its uniform CLI wire shape. */
export function rowToComponentWire(kind: string, row: unknown): ComponentWire {
	const rec = toRecord(row);
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
	};
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
		return {
			ok: false,
			error: `Unknown field(s) for ${kind}: ${unknown.join(", ")}. Allowed: ${[...allowed].join(", ")}`,
		};
	}

	const parsed = schema.safeParse(fields);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		const path = first?.path.join(".") || "fields";
		return { ok: false, error: `Invalid value for ${path}: ${first?.message ?? "invalid"}` };
	}
	return { ok: true, values: toRecord(parsed.data) };
}

/** Lists a project's components — all kinds, or a single kind when `kindFilter` is set —
 * flattened into the uniform wire shape. */
export async function listProjectComponents(
	projectId: string,
	kindFilter?: string,
): Promise<ComponentWire[]> {
	const db = getServiceDb();
	const kinds = kindFilter ? [kindFilter] : COMPONENT_KINDS;
	const out: ComponentWire[] = [];
	for (const kind of kinds) {
		const def = getKindDef(kind);
		if (!def) continue;
		const cols = getTableColumns(def.table);
		const rows = await db
			.select()
			.from(def.table)
			.where(eq(cols.project_id, projectId));
		for (const row of rows) out.push(rowToComponentWire(kind, row));
	}
	return out;
}

/** Inserts a component of `kind` on a project. Singletons upsert on their project_id;
 * multi kinds require a name and conflict (handled by the caller) on (project_id, name).
 * Returns the created/updated row's wire. */
export async function insertProjectComponent(
	kind: string,
	projectId: string,
	name: string,
	values: Record<string, unknown>,
): Promise<ComponentWire> {
	const def = getKindDef(kind);
	if (!def) throw new Error(`Unknown component kind "${kind}"`);
	const db = getServiceDb();
	const cols = getTableColumns(def.table);

	const insertValues: Record<string, unknown> = { project_id: projectId, ...values };
	if (!def.singleton) insertValues.name = name;

	if (def.singleton) {
		const [row] = await db
			.insert(def.table)
			.values(insertValues)
			.onConflictDoUpdate({ target: cols.project_id, set: values })
			.returning();
		return rowToComponentWire(kind, row);
	}
	const [row] = await db.insert(def.table).values(insertValues).returning();
	return rowToComponentWire(kind, row);
}

/** Deletes a component. Singletons delete the project's single row; multi kinds delete the
 * named row. Returns whether a row was removed (false → 404). */
export async function deleteProjectComponent(
	kind: string,
	projectId: string,
	name: string,
): Promise<boolean> {
	const def = getKindDef(kind);
	if (!def) return false;
	const db = getServiceDb();
	const cols = getTableColumns(def.table);

	const where =
		def.singleton || !cols.name
			? eq(cols.project_id, projectId)
			: and(eq(cols.project_id, projectId), eq(cols.name, name));

	const deleted = await db.delete(def.table).where(where).returning();
	return deleted.length > 0;
}
