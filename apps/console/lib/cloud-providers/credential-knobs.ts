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
	type TemplateKnob,
} from "@/lib/cloud-providers/template-knobs";
import { asRecord } from "@/lib/records";

/**
 * The design keys whose components carry a `provider_config`, mapped to the canvas `NodeKind` the
 * template manifest files their knobs under. The design shape is `CreateProjectInput` — a singleton
 * object for `cluster` and `dns`, an array of named components for the rest.
 */
export const DESIGN_PROVIDER_CONFIG_KIND: Readonly<Record<string, NodeKind>> = {
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
 */
export function isCredentialKey(
	kind: NodeKind,
	key: string,
	knobs: readonly TemplateKnob[] = TEMPLATE_KNOBS.knobs,
): boolean {
	if (isCredentialKeyName(key)) return true;
	if (kind === "secret" && key === "value") return true;
	return knobs.some((k) => k.component === kind && k.name === key && isCredentialKnob(k));
}

/** The credential entries of one component's `provider_config`. */
export function credentialEntriesOf(
	kind: NodeKind,
	component: string,
	providerConfig: unknown,
	knobs: readonly TemplateKnob[] = TEMPLATE_KNOBS.knobs,
): CredentialEntry[] {
	return Object.entries(asRecord(providerConfig))
		.filter(([key, value]) => value !== undefined && value !== null && isCredentialKey(kind, key, knobs))
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
	const storedValues = new Set(stored.map((s) => `${s.kind}\u0000${s.key}\u0000${canonicalJson(s.value)}`));
	const offending = credentialKeysInDesign(design, knobs).filter(
		(e) => !storedValues.has(`${e.kind}\u0000${e.key}\u0000${canonicalJson(e.value)}`),
	);
	if (offending.length === 0) return null;
	const where = offending.map((e) => `${e.kind} "${e.component}": ${e.key}`).join("; ");
	const guidance = [...new Set(offending.map((e) => credentialGuidance(e.kind, e.key)))].join(" ");
	return (
		`provider_config cannot hold a credential, because Alethia would store it in plaintext (${where}). ` +
		`${guidance} Remove the key from the component and save again.`
	);
}

/**
 * A design refused for carrying a credential in `provider_config`. SQLSTATE `23514`
 * (check_violation), like `ProviderConfigRefusedError`, because it is a check on the stored value
 * enforced in the application.
 */
export class CredentialKnobRefusedError extends Error {
	readonly code = "23514";

	/** Builds the refusal from the message the caller will read. */
	constructor(message: string) {
		super(message);
		this.name = "CredentialKnobRefusedError";
	}
}

/** Throws {@link CredentialKnobRefusedError} when {@link credentialRefusal} refuses the design. */
export function assertNoNewCredentials(design: unknown, stored: readonly CredentialEntry[]): void {
	const refusal = credentialRefusal(design, stored);
	if (refusal) throw new CredentialKnobRefusedError(refusal);
}

/**
 * The read-only query behind `audit:credential-knobs` (#5565) for one component table: how many
 * rows, and how many distinct projects, carry each `provider_config` KEY.
 *
 * It reads key NAMES only — `jsonb_object_keys` — and never selects a value, so no credential can
 * reach the output however the result is printed. Every key comes back, and the caller keeps the
 * credential ones with {@link credentialKeyCounts}, so the rule is `isCredentialKey` and is not
 * restated in SQL. `table` is a schema table name taken from Drizzle, never user input.
 */
export function providerConfigKeyCountSql(table: string): string {
	return `select k as key, count(*)::int as rows, count(distinct t.project_id)::int as projects
  from public."${table}" t
  cross join lateral jsonb_object_keys(
    case when jsonb_typeof(t.provider_config) = 'object' then t.provider_config else '{}'::jsonb end
  ) as k
 group by k
 order by k`;
}

/** One `provider_config` key's tally in one component table, as {@link providerConfigKeyCountSql} returns it. */
export interface KeyCount {
	key: string;
	rows: number;
	projects: number;
}

/** The credential keys among one kind's key tallies — what the audit reports. */
export function credentialKeyCounts(kind: NodeKind, counts: readonly KeyCount[]): KeyCount[] {
	return counts.filter((c) => isCredentialKey(kind, c.key));
}
