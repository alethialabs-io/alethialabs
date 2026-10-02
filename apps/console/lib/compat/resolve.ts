// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Kubernetes version a compat check must judge: the version that will DEPLOY (#5314).
//
// A cluster whose `cluster_version` is unset deploys the catalog's default for its cloud — the Go
// side resolves it in packages/core/cloud/resolve.go (`ResolveK8sVersion`), and the apply gate in
// packages/core/provisioner/deploy.go judges that resolved value. Every console surface fed the
// engine the RAW value instead, so an unset version read as `not_evaluable` and every check was
// skipped for exactly the clusters that pin nothing (CLI-created projects, blank projects). This is
// the one place the console resolves it, so the canvas, the add-on chips and the config-time report
// cannot each pick a different answer.
//
// Same precedence as the Go resolver, held equal by
// apps/console/tests/lib/compat/k8s-version-resolution-parity.test.ts against a fixture the Go side
// generates (packages/core/cloud/testdata/k8s_version_resolution.json).
//
// Judging only — never write the result back into a config or snapshot: unset keeps meaning
// "follow the catalog", so a later catalog bump still moves the cluster.

import { DEFAULT_K8S_VERSION } from "@/lib/cloud-providers/generated/catalog";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";

/**
 * Resolve a cluster's Kubernetes version for a compat check: an explicit version wins; otherwise
 * the catalog default for `provider`. Returns `undefined` only when there is no explicit version
 * AND no known provider — which the engine then honestly reports as `not_evaluable`.
 */
export function resolveK8sVersion(
	provider: string | null | undefined,
	configVersion: string | null | undefined,
): string | undefined {
	if (configVersion) return configVersion;
	if (provider && isCloudProviderSlug(provider)) return DEFAULT_K8S_VERSION[provider];
	return undefined;
}

/**
 * Why a BYO-IaC cluster with no explicit version cannot be judged. Shown wherever the canvas would
 * otherwise say "Unverified" with the engine's generic "version is unset" note.
 */
export const BYO_IAC_K8S_VERSION_REASON = "Your IaC module decides the Kubernetes version.";

/** The version a compat check judges, and — when there is none — why, if the engine cannot say. */
export interface JudgedK8sVersion {
	/** The version to judge. `undefined` → the engine answers `not_evaluable`. */
	version: string | undefined;
	/**
	 * Set only when `version` is undefined for a reason the engine cannot know (today: a BYO-IaC
	 * module owns the version). Surfaces show it in place of the engine's generic coverage note.
	 */
	reason: string | undefined;
}

/**
 * The Kubernetes version a compat check must judge, given how the environment is provisioned.
 *
 * Template path: `resolveK8sVersion` — explicit wins, unset → the catalog default it deploys as.
 * BYO-IaC path: the customer's module decides the version and the catalog default is never applied,
 * so an explicit value is judged as written and an unset one stays `not_evaluable` with
 * BYO_IAC_K8S_VERSION_REASON. Same split as the config-time report (`buildConfigSnapshot` in
 * app/server/actions/projects.ts) and the apply gate (`compatK8sVersion` in
 * packages/core/provisioner/deploy.go), so the canvas cannot judge a version nobody deploys.
 */
export function judgedK8sVersion(
	provider: string | null | undefined,
	configVersion: string | null | undefined,
	byoIac: boolean,
): JudgedK8sVersion {
	if (byoIac) {
		return configVersion
			? { version: configVersion, reason: undefined }
			: { version: undefined, reason: BYO_IAC_K8S_VERSION_REASON };
	}
	return { version: resolveK8sVersion(provider, configVersion), reason: undefined };
}
