// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ingest-side secret scrub for runner-posted `execution_metadata`.
 *
 * The runner scrubs its own DEPLOY metadata before posting (see
 * apps/runner/internal/agent/output_scrub.go), but that guard sits on the WRONG side of the
 * trust boundary for the console: runners are separately versioned (release-runner.yml) and
 * customers run self-registered runners, so a legacy / mid-rollout / malicious runner can
 * still post credential-bearing keys (the historical `argocd_admin_password` leak) and
 * `update_job_status` would jsonb-merge them verbatim into jobs.execution_metadata (exposed
 * via getPlanResult/getProjectJobs, cross-tenant support reads, DB backups). This module is
 * the console's own gate, applied in the job-status route BEFORE the RPC.
 *
 * The denylist is a 1:1 port of `sensitiveOutputSubstrings` in the runner's output_scrub.go —
 * KEEP THE TWO IN SYNC (same entries, same rationale comments live there).
 */

// Substrings that mark a metadata key as credential-bearing. Case-insensitive substring
// match so prefixed/suffixed variants (`gke_kubeconfig`, `kube_config_raw`) are covered.
// Mirrors apps/runner/internal/agent/output_scrub.go `sensitiveOutputSubstrings` exactly.
const SENSITIVE_KEY_SUBSTRINGS = [
	"kubeconfig",
	"kube_config",
	"talosconfig",
	"client_key",
	"client_certificate",
	"private_key",
	"client_secret",
	// value-bearing generated credentials (e.g. AWS custom_secret_values, *_secret_value(s))
	"secret_value",
	"secret_key",
	"access_key",
	"password",
	"_token",
	// rendered manifests embed credentials (e.g. Hetzner bootstrap_manifests base64s the API token)
	"manifest",
];

// Top-level metadata keys whose SUBTREES are legitimate raw-plan payloads and must NOT be
// descended into: `plan_result` carries the tofu plan JSON's resource_changes, whose
// before/after attribute maps legitimately contain keys NAMED `password`/`*_token`/… (the
// values are plan-time unknowns / sensitive-marked, and lib/plan/parse-plan.ts renders this
// shape verbatim — key-scrubbing it would corrupt the Plan tab). This mirrors the runner's
// PLAN-path exemption (its scrub runs only on the DEPLOY metadata assembly). The keys
// themselves are still denylist-checked; only recursion stops here.
const OPAQUE_SUBTREES = new Set(["plan_result"]);

/** Narrows an unknown to a plain JSON object (not an array, not null). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when a metadata key names credential material that must never be persisted. */
export function isSensitiveMetadataKey(key: string): boolean {
	const lower = key.toLowerCase();
	return SENSITIVE_KEY_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Recursively deletes credential-named keys from a runner-posted execution_metadata blob,
 * IN PLACE, before it is jsonb-merged into jobs.execution_metadata. Descends into nested
 * objects and array elements; skips descent into OPAQUE_SUBTREES (raw plan payloads whose
 * attribute keys legitimately collide with the denylist). Non-object input is a no-op.
 *
 * Returns the dotted paths of the dropped keys — a non-empty result means a runner posted
 * secret material the console refused to persist (log it loudly; it is either a legacy /
 * mid-rollout runner or an active probe).
 */
export function scrubExecutionMetadata(metadata: unknown): string[] {
	if (!isPlainObject(metadata)) return [];
	const dropped: string[] = [];
	scrubObject(metadata, "", true, dropped);
	return dropped;
}

/** Scrubs one object level; `topLevel` gates the opaque-subtree exemption to depth 0. */
function scrubObject(
	obj: Record<string, unknown>,
	prefix: string,
	topLevel: boolean,
	dropped: string[],
): void {
	for (const key of Object.keys(obj)) {
		const path = prefix === "" ? key : `${prefix}.${key}`;
		if (isSensitiveMetadataKey(key)) {
			delete obj[key];
			dropped.push(path);
			continue;
		}
		if (topLevel && OPAQUE_SUBTREES.has(key)) continue;
		descend(obj[key], path, dropped);
	}
}

/** Recurses into nested objects / array elements (scalars carry no key to match). */
function descend(value: unknown, path: string, dropped: string[]): void {
	if (isPlainObject(value)) {
		scrubObject(value, path, false, dropped);
	} else if (Array.isArray(value)) {
		value.forEach((el, i) => descend(el, `${path}[${i}]`, dropped));
	}
}
