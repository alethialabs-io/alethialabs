// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The server half of #5565: a project design that carries a credential in a component's
// `provider_config` is refused at the write, not only hidden in the canvas.
//
// Hiding the control is not a boundary. `createProject`, `updateProjectDesign`,
// `reconcileEnvironmentComponents`, `duplicateEnvironment` and `stageChanges` are all
// POST-addressable server actions, and `updateProjectDesign` is also reached by the CLI's
// `alethia apply` design route. Each takes a whole design and spreads `provider_config` into the
// row, so a crafted request could still plant a password in plaintext JSONB — where it is copied into
// every config snapshot and passed to tofu as a variable. This file decides which keys those are;
// the write actions call it before they touch a row.
//
// One exception, and it is deliberate: a credential value that is ALREADY STORED somewhere in the
// same project, byte-for-byte, may be written again. Rows written before #5565 hold such values
// (`pnpm -C apps/console run audit:credential-knobs` counts them, without printing them). Refusing
// them would make every save of that project fail until the key was removed, and removing
// `rds_extra_credentials` changes the extra database user at the next apply — a destructive change
// forced on someone who only edited a cache. So an unchanged legacy value rides along, and a NEW or
// CHANGED one is refused. Project-wide rather than per environment, because promoting a design or
// duplicating an environment copies the value between environments of the same project. The canvas
// shows such a value as stored (never its content) and offers to remove it.

import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import {
	TEMPLATE_KNOBS,
	credentialGuidance,
	isCredentialKeyName,
	isCredentialKnob,
	normalizeKeyName,
	type TemplateKnob,
} from "@/lib/cloud-providers/template-knobs";
import { asRecord } from "@/lib/records";

/**
 * The design keys whose components carry a `provider_config`, mapped to the canvas `NodeKind` the
 * template manifest files their knobs under. The design shape is `CreateProjectInput` — a singleton
 * object for `cluster` and `dns`, an array of named components for the rest.
 */
const DESIGN_PROVIDER_CONFIG_KIND: Readonly<Record<string, NodeKind>> = {
	cluster: "cluster",
	dns: "dns",
	databases: "database",
	caches: "cache",
	queues: "queue",
	topics: "topic",
	nosql_tables: "nosql",
	secrets: "secret",
	storage_buckets: "bucket",
	container_registries: "registry",
	helm_registries: "helm_registry",
};

/** One credential-shaped `provider_config` entry found in a design or a stored row. */
export interface CredentialEntry {
	/** The component's canvas kind. */
	kind: NodeKind;
	/** The component, for the refusal: its `name`, or the design key for a singleton. */
	component: string;
	/** The `provider_config` key. */
	key: string;
	/** The stored value — compared, never rendered. */
	value: unknown;
}

/**
 * True when `key` is a credential on a component of `kind`: the name carries a credential word, it
 * is a secret's own `value`, or some cloud's template declares a knob of that name on that component
 * which `isCredentialKnob` classifies as one. ANY cloud, on purpose: the design does not always say
 * which cloud it is for, and a key that is a credential on one cloud is not a safe thing to store on
 * another.
 *
 * Compared in `normalizeKeyName`'s spelling (trimmed, camelCase → snake_case, lower case), so
 * `Value`, `RDS_EXTRA_CREDENTIALS` and `rds_extra_credentials ` are the keys they imitate.
 */
export function isCredentialKey(
	kind: NodeKind,
	key: string,
	knobs: readonly TemplateKnob[] = TEMPLATE_KNOBS.knobs,
): boolean {
	if (isCredentialKeyName(key)) return true;
	const name = normalizeKeyName(key);
	if (kind === "secret" && name === "value") return true;
	return knobs.some((k) => k.component === kind && k.name === name && isCredentialKnob(k));
}

/**
 * The `provider_config` kinds as `NodeKind`s, for a caller that holds a kind as a plain string
 * (the staged-changes diff's `component_type`).
 */
function providerConfigKind(kind: string): NodeKind | null {
	return Object.values(DESIGN_PROVIDER_CONFIG_KIND).find((k) => k === kind) ?? null;
}

/**
 * A component record with every credential entry removed from its `provider_config` — for a copy
 * that is DISPLAY-ONLY, such as the staged-changes payload. A grandfathered legacy value passes the
 * write guard (it is already stored); this keeps it from being written a SECOND time, in plaintext,
 * into `project_changes`. Everything else in the record is kept, so the change still reads as a
 * change. A kind without `provider_config` is returned unchanged.
 */
export function withoutCredentials(kind: string, record: Record<string, unknown>): Record<string, unknown> {
	const nodeKind = providerConfigKind(kind);
	if (!nodeKind || record.provider_config === undefined || record.provider_config === null) return record;
	const providerConfig = { ...asRecord(record.provider_config) };
	for (const entry of credentialEntriesOf(nodeKind, kind, providerConfig)) delete providerConfig[entry.key];
	return { ...record, provider_config: providerConfig };
}

/**
 * Removes every credential entry from every component's `provider_config` in a design, IN PLACE —
 * for a design about to be COPIED (duplicating an environment). A legacy value stored before #5565
 * stays where it is, but is not multiplied into a new environment in plaintext; the copy's component
 * starts without it, as a new one would. Everything else in the design is untouched.
 */
export function stripDesignCredentials(design: object): void {
	for (const [designKey, kind] of Object.entries(DESIGN_PROVIDER_CONFIG_KIND)) {
		const section: unknown = Reflect.get(design, designKey);
		const items: unknown[] = Array.isArray(section) ? section : section ? [section] : [];
		for (const item of items) {
			if (typeof item !== "object" || item === null) continue;
			const providerConfig: unknown = Reflect.get(item, "provider_config");
			if (typeof providerConfig !== "object" || providerConfig === null) continue;
			for (const key of Object.keys(providerConfig)) {
				if (isCredentialKey(kind, key)) Reflect.deleteProperty(providerConfig, key);
			}
		}
	}
}

/**
 * The credential entries of one component's `provider_config`: each key {@link isCredentialKey}
 * classifies. Decided from the KEY and the template's declaration of it — never from the value, whose
 * inner keys are user data (a `map(string)` of Postgres flags, keepers named after secrets).
 */
export function credentialEntriesOf(
	kind: NodeKind,
	component: string,
	providerConfig: unknown,
	knobs: readonly TemplateKnob[] = TEMPLATE_KNOBS.knobs,
): CredentialEntry[] {
	return Object.entries(asRecord(providerConfig))
		.filter(
			([key, value]) =>
				value !== undefined &&
				value !== null &&
				isCredentialKey(kind, key, knobs),
		)
		.map(([key, value]) => ({ kind, component, key, value }));
}

/** Every credential entry in a whole design (`CreateProjectInput`-shaped). */
export function credentialKeysInDesign(
	design: unknown,
	knobs: readonly TemplateKnob[] = TEMPLATE_KNOBS.knobs,
): CredentialEntry[] {
	const root = asRecord(design);
	const found: CredentialEntry[] = [];
	for (const [designKey, kind] of Object.entries(DESIGN_PROVIDER_CONFIG_KIND)) {
		const section = root[designKey];
		if (Array.isArray(section)) {
			section.forEach((item, i) => {
				const record = asRecord(item);
				const name = typeof record.name === "string" && record.name ? record.name : `${designKey}[${i}]`;
				found.push(...credentialEntriesOf(kind, name, record.provider_config, knobs));
			});
		} else if (section !== undefined && section !== null) {
			found.push(...credentialEntriesOf(kind, designKey, asRecord(section).provider_config, knobs));
		}
	}
	return found;
}

/** A JSON rendering with object keys sorted, so two equal values compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = asRecord(value);
		return `{${Object.keys(record)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The credential entries of a design that are NOT already stored, unchanged, in the same project —
 * the ones a write refuses (see the file header).
 */
function newCredentialEntries(
	design: unknown,
	stored: readonly CredentialEntry[],
	knobs: readonly TemplateKnob[],
): CredentialEntry[] {
	const identity = (e: CredentialEntry) => `${e.kind}\u0000${e.key}\u0000${canonicalJson(e.value)}`;
	const storedValues = new Set(stored.map(identity));
	return credentialKeysInDesign(design, knobs).filter((e) => !storedValues.has(identity(e)));
}

/** The components and keys a refusal names — `database "orders": rds_extra_credentials; …`. Never a value. */
function credentialWhere(entries: readonly CredentialEntry[]): string {
	return entries.map((e) => `${e.kind} "${e.component}": ${e.key.trim()}`).join("; ");
}

/** The refusal sentence for a set of offending entries. */
function refusalMessage(offending: readonly CredentialEntry[]): string {
	const guidance = [
		...new Set(offending.map((e) => credentialGuidance(e.kind, normalizeKeyName(e.key)))),
	].join(" ");
	return (
		`provider_config cannot hold these keys: each is a credential, or is named like one, and Alethia would store its value in plaintext (${credentialWhere(offending)}). ` +
		`${guidance} Remove the key from the component and save again.`
	);
}

/**
 * The refusal for a design that writes a credential into `provider_config`, or null when it writes
 * none — or only values already stored, unchanged, in the same project (see the file header).
 *
 * The message names each component and key, never a value, and says where the value goes instead.
 */
export function credentialRefusal(
	design: unknown,
	stored: readonly CredentialEntry[],
	knobs: readonly TemplateKnob[] = TEMPLATE_KNOBS.knobs,
): string | null {
	const offending = newCredentialEntries(design, stored, knobs);
	return offending.length === 0 ? null : refusalMessage(offending);
}

/**
 * A design refused for carrying a credential in `provider_config`. SQLSTATE `23514`
 * (check_violation), like `ProviderConfigRefusedError`, because it is a check on the stored value
 * enforced in the application.
 */
export class CredentialKnobRefusedError extends Error {
	readonly code = "23514";

	/**
	 * Builds the refusal from the message the caller will read, and the components and keys it
	 * names (`where`, never a value) for a wrapper that words its own sentence.
	 */
	constructor(
		message: string,
		readonly where: string,
	) {
		super(message);
		this.name = "CredentialKnobRefusedError";
	}
}

/** Throws {@link CredentialKnobRefusedError} when {@link credentialRefusal} refuses the design. */
export function assertNoNewCredentials(design: unknown, stored: readonly CredentialEntry[]): void {
	const offending = newCredentialEntries(design, stored, TEMPLATE_KNOBS.knobs);
	if (offending.length > 0) {
		throw new CredentialKnobRefusedError(refusalMessage(offending), credentialWhere(offending));
	}
}

/**
 * The read-only query behind `audit:credential-knobs` (#5565): for one JSONB column of one table,
 * how many rows — and how many distinct projects — carry each `provider_config` KEY.
 *
 * `path` picks the `provider_config` objects inside the column: `$` when the column IS a
 * component's provider_config, `lax $.**.provider_config` for a document that embeds components
 * (a job's `config_snapshot`, a staged `project_changes.payload`). Only the keys OF those objects are
 * listed — never the keys inside a knob's value, which are user data (`password_encryption` in a
 * map of database flags is a setting, not a credential).
 *
 * It reads key NAMES only — `jsonb_object_keys` — and never selects a value, so no credential can
 * reach the output however the result is printed. Every key comes back and the caller keeps the
 * credential ones ({@link credentialKeyCounts} / {@link derivedCredentialKeyCounts}), so the rule is
 * the write path's and is not restated in SQL. `table`, `column` and `path` are constants of the
 * audit, never input.
 */
export function jsonKeyCountSql(table: string, column: string, path = "$"): string {
	return `select k as key, count(distinct t.id)::int as rows, count(distinct t.project_id)::int as projects
  from public."${table}" t
  cross join lateral jsonb_path_query(coalesce(t."${column}", '{}'::jsonb), '${path}') as v
  cross join lateral jsonb_object_keys(case when jsonb_typeof(v) = 'object' then v else '{}'::jsonb end) as k
 group by k
 order by k`;
}

/** The path to every embedded component `provider_config` in a derived document. */
export const EMBEDDED_PROVIDER_CONFIG = "lax $.**.provider_config";

/**
 * Rows of a DERIVED document (a job's `config_snapshot`, a staged `project_changes.payload`) that
 * hold a `provider_config.value` at any depth — a secret's own value. Counted separately because
 * `value` is a credential only on a secret, and a bare `value` key appears all over a snapshot.
 */
export function providerConfigValueCountSql(table: string, column: string): string {
	return `select count(*)::int as rows, count(distinct t.project_id)::int as projects
  from public."${table}" t
 where jsonb_path_exists(coalesce(t."${column}", '{}'::jsonb), 'lax $.**.provider_config.value')`;
}

/** One key's tally in one table, as {@link jsonKeyCountSql} returns it. */
export interface KeyCount {
	key: string;
	rows: number;
	projects: number;
}

/** The credential keys among one component kind's key tallies — what the audit reports. */
export function credentialKeyCounts(kind: NodeKind, counts: readonly KeyCount[]): KeyCount[] {
	return counts.filter((c) => isCredentialKey(kind, c.key));
}

/**
 * The credential keys among a DERIVED document's key tallies, where the component kind is not known
 * per key: a credential word in the name, or the name of a template knob that is a credential on
 * some component (`rds_extra_credentials`). A bare `value` is not counted here — see
 * {@link providerConfigValueCountSql}.
 */
export function derivedCredentialKeyCounts(
	counts: readonly KeyCount[],
	knobs: readonly TemplateKnob[] = TEMPLATE_KNOBS.knobs,
): KeyCount[] {
	const knobNames = new Set(knobs.filter(isCredentialKnob).map((k) => k.name));
	knobNames.delete("value");
	return counts.filter((c) => isCredentialKeyName(c.key) || knobNames.has(normalizeKeyName(c.key)));
}
