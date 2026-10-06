// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which `provider_config` keys a CLI or `alethia.yaml` write may set, and how a write lands (#5529).
//
// `provider_config` is the JSONB passthrough the Go providers merge into the template's tfvars
// (`mergeProviderConfig`, packages/core/cloud/aws_provider.go). Whatever a key names reaches tofu as
// a variable, so this file is a WRITE BOUNDARY into the templates, not a convenience: a key that
// named an `alethia_*` platform variable, or a credential, would let a caller override the platform's
// context or plant a secret in state.
//
// "Settable" therefore has ONE definition, and it is the canvas's: `offerableKnobs` — the function
// behind `knobsFor`, which the cluster inspector renders its Advanced section from — over the
// generated `template-knobs.json`. This file only NARROWS that set, never widens it, and it narrows
// it by two rules the canvas does not need because a person is looking at the control there:
//
//   · RESERVED — any key starting `alethia_` is platform context (`alethia_project`,
//     `alethia_environment`, …). None is offerable today; the prefix is refused anyway so that a
//     template adding one cannot open it to the CLI by accident.
//   · CREDENTIAL — a knob the template marks `sensitive`, a knob whose name or declared type carries
//     a credential word (`rds_extra_credentials` declares a `password` attribute), and a secret's own
//     material (`value` on a secret). A credential belongs in a secret store, not in a component's
//     config, where it would ride the config snapshot and the tofu state in the clear.
//
// Everything else the manifest knows a reason for — typed, provider-owned, ceiling, dead,
// unreachable — is the manifest's reason, and the refusal says which one, beside the list of keys
// that ARE settable.

import { z } from "zod";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import {
	TEMPLATE_KNOBS,
	isRead,
	offerableKnobs,
	type TemplateKnob,
} from "@/lib/cloud-providers/template-knobs";
import { asRecord } from "@/lib/records";

/**
 * The CLI component kinds whose table has a `provider_config` column, mapped to the canvas
 * `NodeKind` the manifest files their knobs under. `null` is a kind with the column and no canvas
 * node of its own — its knobs, if a template ever declares any, are not modelled, so nothing on it is
 * settable.
 *
 * `network` and `repositories` are absent on purpose: their tables carry no `provider_config`
 * column (CUSTOMIZABILITY-PARITY.md), so there is nowhere for a key to be stored.
 */
const PROVIDER_CONFIG_NODE_KIND: Readonly<Record<string, NodeKind | null>> = {
	cluster: "cluster",
	dns: "dns",
	observability: null,
	databases: "database",
	caches: "cache",
	queues: "queue",
	topics: "topic",
	nosql_tables: "nosql",
	container_registries: "registry",
	helm_registries: "helm_registry",
	secrets: "secret",
	storage_buckets: "bucket",
};

/** True when a CLI component kind's table has a `provider_config` column the CLI may write. */
export function hasProviderConfig(kind: string): boolean {
	return Object.prototype.hasOwnProperty.call(PROVIDER_CONFIG_NODE_KIND, kind);
}

/**
 * The SHAPE of a `provider_config` patch, before anyone knows the cloud: an object of JSON values,
 * where `null` means "remove this key". It is what the component registry adds to each kind's
 * `fields` schema, so it is also what the published component schema advertises — which is what
 * makes `alethia.yaml` accept a nested `provider_config:` mapping.
 *
 * Shape only. Which keys, and what type each value must be, depend on the project's cloud and are
 * decided by {@link resolveProviderConfigPatch} on the write path.
 */
export const providerConfigPatchSchema = z.record(z.string().min(1), z.json());

/** Why a key is not settable, in the words the refusal uses. */
type RefusalReason =
	| "reserved"
	| "credential"
	| "unknown"
	| "unreachable"
	| "ceiling"
	| "provider-owned"
	| "typed"
	| "dead";

/** The sentence fragment each refusal reason renders as. */
const REASON_TEXT: Readonly<Record<RefusalReason, string>> = {
	reserved: "reserved for platform context (alethia_*)",
	credential: "a credential — store it as a secret, never in provider_config",
	unknown: "not a variable of this template",
	unreachable: "not reachable from this component's provider_config",
	ceiling: "a provider ceiling — the cloud cannot honour it",
	"provider-owned": "always set by Alethia, so an override would be ignored",
	typed: "set through the component's own field, not provider_config",
	dead: "read by nothing in the template",
};

/** A credential word as a whole `_`-separated segment of a knob name. */
const CREDENTIAL_NAME =
	/(^|_)(password|passwd|passphrase|credentials?|token|secret_key|access_key|private_key|api_key|client_secret)(_|$)/;

/** A credential attribute declared inside a knob's type (`object({ password = … })`). */
const CREDENTIAL_ATTRIBUTE =
	/\b(password|passwd|passphrase|token|secret_key|access_key|private_key|api_key|client_secret)\s*=/;

/**
 * True when a knob carries a credential: the template marks it `sensitive`, its name or its declared
 * type names a credential, or it is a secret component's own material (`value`).
 */
export function isCredentialKnob(knob: TemplateKnob): boolean {
	if (knob.sensitive) return true;
	if (CREDENTIAL_NAME.test(knob.name)) return true;
	if (CREDENTIAL_ATTRIBUTE.test(knob.typeExpr)) return true;
	return knob.component === "secret" && knob.name === "value";
}

/** True for a key the platform reserves for its own context. */
function isReservedKey(key: string): boolean {
	return key.startsWith("alethia_");
}

/**
 * The knobs a CLI write may set on one component kind on one cloud: the canvas's offerable set
 * (`offerableKnobs`, the body of `knobsFor`) less reserved and credential knobs. Sorted by name.
 *
 * `knobs` defaults to the committed manifest; a test passes a fixture to drive a category the live
 * manifest no longer contains (a dead knob, since #4320).
 */
export function settableProviderConfigKnobs(
	cloud: string,
	kind: string,
	knobs: readonly TemplateKnob[] = TEMPLATE_KNOBS.knobs,
): TemplateKnob[] {
	const nodeKind = PROVIDER_CONFIG_NODE_KIND[kind];
	if (!nodeKind) return [];
	return offerableKnobs(knobs, cloud, nodeKind).filter(
		(k) => !isReservedKey(k.name) && !isCredentialKnob(k),
	);
}

/** Why `key` is not in the settable set — the first matching reason, most fundamental first. */
function refusalReason(
	key: string,
	cloud: string,
	nodeKind: NodeKind | null | undefined,
	knobs: readonly TemplateKnob[],
): RefusalReason {
	if (isReservedKey(key)) return "reserved";
	const knob = nodeKind
		? knobs.find((k) => k.cloud === cloud && k.component === nodeKind && k.name === key)
		: undefined;
	if (!knob) return CREDENTIAL_NAME.test(key) ? "credential" : "unknown";
	if (isCredentialKnob(knob)) return "credential";
	if (!knob.reachable) return "unreachable";
	if (knob.ceiling) return "ceiling";
	if (knob.ownedByProvider) return "provider-owned";
	if (knob.typed) return "typed";
	if (!isRead(knob)) return "dead";
	// Unreachable for a knob outside the settable set — kept so the type stays total.
	return "unknown";
}

/** A `list(string)` / `set(string)`-style element type, or null for anything richer. */
function scalarElement(typeExpr: string, container: "list" | "map"): "string" | "number" | "bool" | null {
	const pattern =
		container === "list"
			? /^\s*(?:list|set)\s*\(\s*(string|number|bool)\s*\)\s*$/
			: /^\s*map\s*\(\s*(string|number|bool)\s*\)\s*$/;
	const match = pattern.exec(typeExpr);
	if (!match) return null;
	const element = match[1];
	return element === "string" || element === "number" || element === "bool" ? element : null;
}

/** True when `value` is a JSON value of the scalar type a template names. */
function isScalar(value: unknown, type: "string" | "number" | "bool"): boolean {
	if (type === "string") return typeof value === "string";
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	return typeof value === "boolean";
}

/** True for a JSON object (not an array, not null). */
function isPlainObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks one value against its knob's declared type, returning what was expected when it does not
 * fit, or null when it does.
 *
 * Only what the template DECLARES is checked: the coarse `kind`, and a list's or map's element type
 * when that is a plain scalar. Object attributes, bounds and enums are OpenTofu's to judge — a rule
 * invented here could refuse a value the template accepts.
 */
export function knobTypeError(knob: TemplateKnob, value: unknown): string | null {
	switch (knob.kind) {
		case "string":
		case "number":
		case "bool":
			return isScalar(value, knob.kind) ? null : `a ${knob.kind}`;
		case "list": {
			if (!Array.isArray(value)) return `a list (${knob.typeExpr.replace(/\s+/g, " ")})`;
			const element = scalarElement(knob.typeExpr, "list");
			if (element && !value.every((v) => isScalar(v, element))) {
				return `a list of ${element} values`;
			}
			return null;
		}
		case "map": {
			if (!isPlainObject(value)) return `a map (${knob.typeExpr.replace(/\s+/g, " ")})`;
			const element = scalarElement(knob.typeExpr, "map");
			if (element && !Object.values(asRecord(value)).every((v) => isScalar(v, element))) {
				return `a map of ${element} values`;
			}
			return null;
		}
		case "object":
			return isPlainObject(value) ? null : `an object (${knob.typeExpr.replace(/\s+/g, " ")})`;
		case "any":
			return null;
	}
}

/**
 * Merges a validated patch into the stored `provider_config`: every key in `set` is written, every
 * key in `unset` is removed, and every other stored key — including one the canvas set — is kept.
 * Pure, and never mutates `stored`.
 */
export function mergeProviderConfig(
	stored: unknown,
	set: Readonly<Record<string, unknown>>,
	unset: readonly string[],
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...asRecord(stored), ...set };
	for (const key of unset) delete next[key];
	return next;
}

/** The outcome of resolving a `provider_config` patch against one cloud. */
export type ProviderConfigPatchResult =
	| { ok: true; set: Record<string, unknown>; unset: string[] }
	| { ok: false; error: string };

/**
 * Validates a `provider_config` patch for one component kind on one cloud.
 *
 * Every key must be in {@link settableProviderConfigKnobs}; a refusal names each offending key with
 * its reason and lists the keys that ARE settable, so the error is also the discovery mechanism. A
 * `null` value removes the key and is held to the same allow-list. Every other value must fit the
 * knob's declared type. Nothing is stored unless the whole patch passes.
 */
export function resolveProviderConfigPatch(
	cloud: string,
	kind: string,
	patch: Readonly<Record<string, unknown>>,
	knobs: readonly TemplateKnob[] = TEMPLATE_KNOBS.knobs,
): ProviderConfigPatchResult {
	const settable = settableProviderConfigKnobs(cloud, kind, knobs);
	const byName = new Map(settable.map((k) => [k.name, k]));
	const nodeKind = PROVIDER_CONFIG_NODE_KIND[kind];
	const keys = Object.keys(patch).sort();

	const refused = keys.filter((key) => !byName.has(key));
	if (refused.length > 0) {
		const reasons = refused
			.map((key) => `${key} (${REASON_TEXT[refusalReason(key, cloud, nodeKind, knobs)]})`)
			.join(", ");
		const offer =
			settable.length > 0
				? `Settable keys for ${kind} on ${cloud}: ${settable.map((k) => k.name).join(", ")}`
				: `${kind} on ${cloud} has no settable provider_config keys`;
		return {
			ok: false,
			error: `provider_config key(s) not settable for ${kind} on ${cloud}: ${reasons}. ${offer}`,
		};
	}

	const set: Record<string, unknown> = {};
	const unset: string[] = [];
	const typeErrors: string[] = [];
	for (const key of keys) {
		const value = patch[key];
		if (value === null) {
			unset.push(key);
			continue;
		}
		const knob = byName.get(key);
		if (!knob) continue;
		const expected = knobTypeError(knob, value);
		if (expected) typeErrors.push(`${key} must be ${expected}`);
		else set[key] = value;
	}
	if (typeErrors.length > 0) {
		return {
			ok: false,
			error: `Invalid provider_config value(s) for ${kind} on ${cloud}: ${typeErrors.join("; ")}. Set a key to null to remove it`,
		};
	}
	return { ok: true, set, unset };
}

/**
 * A `provider_config` patch the cloud refuses. It carries SQLSTATE `23514` (check_violation)
 * because it IS a check on the stored value — enforced in the application rather than by a column
 * CHECK, since the allow-list depends on the project's cloud — and both component write routes
 * already answer a `23514` with a 400 carrying the message.
 */
export class ProviderConfigRefusedError extends Error {
	readonly code = "23514";

	/** Builds the refusal from the message the caller will read. */
	constructor(message: string) {
		super(message);
		this.name = "ProviderConfigRefusedError";
	}
}
