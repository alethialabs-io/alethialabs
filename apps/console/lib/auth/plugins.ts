// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { BetterAuthOptions } from "better-auth";
import { getEnterprise } from "@/lib/enterprise";

/**
 * Extra Better Auth plugins contributed by the enterprise build (spec 07 Part F,
 * seam 3) — `organization()` + SSO. Community returns `[]`. The core community
 * plugins (emailOTP, genericOAuth, nextCookies) stay in lib/auth/index.ts; this
 * only appends the enterprise ones.
 *
 * NOTE: Better Auth needs plugins synchronously at init, so the enterprise module
 * must be registered before lib/auth/index.ts evaluates — wired in sub-phase 4.5.
 * Today `getEnterprise()` is null at init, so this is `[]` (no behaviour change).
 */
export function getAuthPlugins(): NonNullable<BetterAuthOptions["plugins"]> {
	return getEnterprise()?.authPlugins ?? [];
}
