// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { TEMPLATE_KNOBS } from "@/lib/cloud-providers/template-knobs";

// Hetzner installs one Kubernetes version: the patch its Talos release is pinned to (#5366). It
// never reads `cluster_version` — hetzner_provider.go sends tofu `kubernetes_version`, not the
// cluster's version — so a stored version other than that minor is one the cluster does not run.
//
// The pin is read from the generated template-knobs manifest, which is generated from the
// `kubernetes_version` default in infra/templates/project/hetzner/variables.tf. That template is
// the source. The Go copy (`cloud.HetznerKubernetesVersion`) and this manifest are both held equal
// to it by TestHetznerKubernetesPinMatchesTemplate in packages/core/cloud.

/**
 * Read the Hetzner Kubernetes pin from the template-knobs manifest. Throws at module load when
 * the knob or its default is missing, so a template change that drops it fails loudly rather than
 * showing an empty version.
 */
function readHetznerPin(): string {
	const knob = TEMPLATE_KNOBS.knobs.find(
		(k) => k.cloud === "hetzner" && k.name === "kubernetes_version",
	);
	if (typeof knob?.default !== "string" || knob.default === "") {
		throw new Error(
			"template-knobs.json has no string default for hetzner kubernetes_version — the Talos pin moved; re-anchor hetzner-k8s-pin.ts",
		);
	}
	return knob.default;
}

/** The Kubernetes version a Hetzner cluster installs, e.g. `1.35.6`. */
export const HETZNER_K8S_VERSION = readHetznerPin();

/** Trim a Kubernetes version to `MAJOR.MINOR` (`v1.35.6` → `1.35`). Mirrors Go's `k8sMinor`. */
export function k8sMinor(version: string): string {
	const parts = version.trim().replace(/^v/, "").split(".");
	return parts.length < 2 ? parts.join(".") : `${parts[0]}.${parts[1]}`;
}

/** The pinned minor, e.g. `1.35` — the one non-empty `cluster_version` Hetzner accepts. */
export const HETZNER_K8S_MINOR = k8sMinor(HETZNER_K8S_VERSION);

/**
 * True when a Hetzner cluster's stored `cluster_version` names a minor Hetzner does not install.
 * The apply refuses such a row (Go `validateHetznerClusterVersion`); unset is never a conflict.
 */
export function hetznerVersionConflicts(clusterVersion: string | null | undefined): boolean {
	const set = clusterVersion?.trim() ?? "";
	return set !== "" && k8sMinor(set) !== HETZNER_K8S_MINOR;
}

/**
 * The Kubernetes version to SHOW for a cluster: on Hetzner the pinned version Talos installs,
 * whatever the row holds; elsewhere the stored `cluster_version`, or null when unset.
 *
 * Not read here: a `kubernetes_version` key in the cluster's provider_config, which Go honours
 * over the pin (`hetznerKubernetesVersion`). The console offers no control that writes one — the
 * knob is provider-owned in the template-knobs manifest — so only a hand-written provider_config
 * can make this answer differ from what installs.
 */
export function displayedK8sVersion(
	provider: string | null | undefined,
	clusterVersion: string | null | undefined,
): string | null {
	if (provider === "hetzner") return HETZNER_K8S_VERSION;
	return clusterVersion || null;
}
