// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client-safe git-provider slugs + guard. Mirrors the `git_provider` pgEnum but as a plain const,
// so client components can narrow a slug without importing the drizzle schema (which would drag the
// DB layer into the browser bundle). Kept in lockstep with the enum via `satisfies`.

import type { GitProvider } from "@/lib/db/schema";
import { isEnumMember } from "@/lib/coerce";

export const GIT_PROVIDERS = [
	"github",
	"bitbucket",
	"gitlab",
] as const satisfies readonly GitProvider[];

/** Cast-free narrow: true when a string is a known git provider. */
export function asGitProvider(s: string): GitProvider {
	return isEnumMember(s, GIT_PROVIDERS) ? s : "github";
}

/** Cast-free narrow: true when a string is a known git provider. */
export function isGitProvider(s: string): s is GitProvider {
	return isEnumMember(s, GIT_PROVIDERS);
}
