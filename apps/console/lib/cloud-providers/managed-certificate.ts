// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "./generated/catalog";

/**
 * Which clouds can honour the canvas's "Managed TLS certificate" switch (`dns.managed_certificate`).
 *
 * Shaped exactly like `waf.ts`, the switch beside it: a tiny runtime-only module the inspector gate
 * and the canvas store's normaliser both read. Alibaba is withheld (#4320, maintainer ruling
 * 2026-09-23): it is a recorded PROVIDER CEILING — `alidns_managed_certificate` sits under `ceiling:`
 * in infra/templates/project/knob-exclusions.yaml, and `dns.managed_certificate` / alibaba is an
 * exclusion in both infra/offer-exclusions.yaml and infra/config-carriage-exclusions.yaml (#1824).
 *
 * The sentence is those ledgers' `reason:` VERBATIM, because they print into the public parity
 * matrices: a canvas that says one thing and a matrix that says another is worse than either.
 *
 * Hetzner is NOT listed, the same scope boundary `waf.ts` draws for its hetzner cell: its
 * `dns:managed_certificate` exclusion is equally real, but the ruling gated Alibaba, and gating a
 * second cloud's switch is its own decision.
 *
 * There is no deploy-time refusal, unlike the WAF. A stale `true` on Alibaba reaches a tfvar that no
 * resource reads, so it builds nothing and destroys nothing; refusing live projects over it would be
 * a real break bought for no safety.
 */
const MANAGED_CERTIFICATE_WITHHELD: Partial<Record<string, string>> = {
	alibaba:
		"Unavailable on Alibaba Cloud. The alicloud provider can only upload a certificate you already hold, never order one, and cert-manager ships no Alibaba DNS01 solver — so nothing issues a certificate here, by OpenTofu or in-cluster. Bring your own certificate.",
};

/** Why this cloud cannot honour the Managed TLS switch, or null when it can. A null provider returns
 * null — "no cloud picked yet" is not a refusal. */
export function managedCertificateUnavailableReason(
	provider: CloudProviderSlug | null,
): string | null {
	if (!provider) return null;
	return MANAGED_CERTIFICATE_WITHHELD[provider] ?? null;
}

/**
 * Force `managed_certificate` off on a cloud that cannot honour it; returns the SAME config otherwise.
 *
 * The inspector gate only filters the render, and the switch renders disabled — so without this a
 * project designed on AWS with the certificate on and re-placed on Alibaba would carry `true` under a
 * toggle the user cannot touch. Identity is load-bearing: the store derives `dirty` from it.
 */
export function normalizeManagedCertificate<C extends { managed_certificate?: boolean | null }>(
	config: C,
	provider: CloudProviderSlug | null,
): C {
	if (!config.managed_certificate) return config;
	return managedCertificateUnavailableReason(provider) ? { ...config, managed_certificate: false } : config;
}
