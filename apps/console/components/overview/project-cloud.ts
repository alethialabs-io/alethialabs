// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the overview says about a project's cloud. No "use client" and no server imports.

import { PROVIDER_LABELS } from "@repo/ui/provider-icon";
import { lookup } from "@/lib/typed-object";

/** The display name of a cloud slug, from the shared provider labels; the slug in capitals otherwise. */
export function providerLabel(slug: string): string {
	return lookup(PROVIDER_LABELS, slug) ?? slug.toUpperCase();
}

/**
 * Why a project on `provider` cannot be planned or deployed on this deployment, or `null` when it
 * can. `offered` is the server's list of offered clouds (`overview.projects.summary`), never a list written
 * here: the same list decides what a plan or a deploy is refused for.
 *
 * A project with no cloud account has no cloud to refuse, so it answers `null`.
 */
export function cloudNotOfferedReason(provider: string | null, offered: readonly string[]): string | null {
	if (provider === null || offered.includes(provider)) return null;
	return `${providerLabel(provider)} is not available in this release, so this project can't be planned or deployed.`;
}
