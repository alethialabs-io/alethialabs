// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which clouds the runner can mint a kubeconfig on, and in which shapes (#5250 decisions 4 and 8).

import { MINTABLE_CLOUDS } from "@/lib/clusters/mint-eligibility";
import type {
	CloudProvider,
	KubeconfigMintShape,
	KubeconfigMintTier,
} from "@/lib/db/schema/enums";

/** Clouds whose credential is a certificate, so only a static, TTL-capped file can carry it
 *  (decision 4): Talos on Hetzner, ACK on Alibaba. */
const STATIC_ONLY: ReadonlySet<CloudProvider> = new Set(["alibaba", "hetzner"]);

/** Why a (cloud, shape) pair cannot be minted, or null when it can. */
export type MintShapeRefusal = "unsupported-cloud" | "static-only" | null;

/**
 * Whether the runner can mint `shape` on `provider`. A null provider (no cloud identity on the
 * cluster or its project) is unsupported: the runner would have no identity to mint under.
 */
export function mintShapeRefusal(
	provider: CloudProvider | null,
	shape: KubeconfigMintShape,
): MintShapeRefusal {
	if (provider === null || !MINTABLE_CLOUDS.has(provider)) return "unsupported-cloud";
	if (shape === "exec" && STATIC_ONLY.has(provider)) return "static-only";
	return null;
}

/** The authz action that gates a tier: exactly one per tier, never "either" (#5280). */
export function actionForTier(
	tier: KubeconfigMintTier,
): "access_readonly" | "access_admin" {
	switch (tier) {
		case "readonly":
			return "access_readonly";
		case "admin":
			return "access_admin";
	}
}
