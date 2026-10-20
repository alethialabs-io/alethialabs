// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one read-side filter for a job's `config_snapshot`.
 *
 * A job snapshot is a frozen, denormalised copy of what a runner was asked to do, and it is shown to
 * everyone who can view the job: the jobs list, the job detail page, the runners page and the CLI's
 * job reads all return it. Credentials are never meant to be in it — cloud identities and connector
 * credentials are attached at claim time (app/api/jobs/claim/route.ts), and a runner-lifecycle job's
 * bearer token is minted at claim time too (lib/runners/lifecycle-token.ts). This filter is the
 * second layer behind that rule: every user-facing read passes its snapshot through
 * {@link redactJobSnapshot}, so the rule holds at the read boundary independently of every write
 * path.
 *
 * It is an EXACT-NAME deny-list, applied at every depth. Exact on purpose: a snapshot embeds user
 * data whose key names merely contain a credential word (`password_encryption` in a map of database
 * flags is a setting), and a substring match would silently delete those from the detail view.
 *
 * The deny-list has two halves. A fixed list names credential material by its wire name. Design
 * knobs a template declares as credentials are DERIVED from the same classifier the project write
 * actions use (`isCredentialKnob` over `TEMPLATE_KNOBS`, #5565), so the read filter and the
 * write-time refusal share one definition. A secret component's own material is the knob named
 * `value`, a name that appears all over a snapshot, so it is matched only as `provider_config.value`.
 *
 * Runner-facing reads (the claim route, the runner's own `GET /api/jobs/:id`) do not use it: the
 * runner is the party the snapshot is for.
 */

import { TEMPLATE_KNOBS, isCredentialKnob } from "@/lib/cloud-providers/template-knobs";

/** The fixed snapshot keys that name credential material and are never returned to a job viewer. */
export const JOB_SNAPSHOT_SECRET_KEYS = [
	// A runner-lifecycle job's bearer token (DEPLOY_RUNNER / UPDATE_RUNNER).
	"runner_token",
	// Cloud identity material, which the claim route attaches and a snapshot must not carry.
	"api_token",
	"s3_access_key",
	"s3_secret_key",
	"secret_key",
	"client_secret",
	"private_key",
	// Cluster admin credentials.
	"kubeconfig",
	"talosconfig",
	"talos_admin_config",
	// A credential-shaped design knob (designs refuse new ones at write, #5565).
	"password",
] as const;

/** The knob a secret component carries its own material in; matched only under `provider_config`. */
const SECRET_VALUE_KNOB = "value";

/** The design knobs the write-time classifier calls credentials, except the secret's `value`. */
export const DESIGN_CREDENTIAL_KNOB_KEYS: readonly string[] = [
	...new Set(
		TEMPLATE_KNOBS.knobs
			.filter(isCredentialKnob)
			.map((knob) => knob.name)
			.filter((name) => name !== SECRET_VALUE_KNOB),
	),
].sort();

const SECRET_KEYS: ReadonlySet<string> = new Set([
	...JOB_SNAPSHOT_SECRET_KEYS,
	...DESIGN_CREDENTIAL_KNOB_KEYS,
]);

/** Narrows an unknown to a plain JSON object (not an array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copies one JSON value with every deny-listed key removed, at any depth. `inProviderConfig` is true
 * for the object directly under a `provider_config` key, where `value` is a secret's material.
 */
function redactValue(value: unknown, inProviderConfig = false): unknown {
	if (Array.isArray(value)) return value.map((item) => redactValue(item));
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value)) {
		if (SECRET_KEYS.has(key)) continue;
		if (inProviderConfig && key === SECRET_VALUE_KNOB) continue;
		out[key] = redactValue(inner, key === "provider_config");
	}
	return out;
}

/**
 * Returns a copy of a job snapshot without any deny-listed key, at any depth. The input is not
 * modified. A non-object input (a corrupt row) comes back as an empty object.
 */
export function redactJobSnapshot(snapshot: unknown): Record<string, unknown> {
	const redacted = redactValue(snapshot);
	return isPlainObject(redacted) ? redacted : {};
}

/** Returns a copy of a job row whose `config_snapshot` has been through {@link redactJobSnapshot}. */
export function redactJobRow<T extends { config_snapshot: Record<string, unknown> }>(job: T): T {
	return { ...job, config_snapshot: redactJobSnapshot(job.config_snapshot) };
}
