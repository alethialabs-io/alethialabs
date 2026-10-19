// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

/**
 * The billing domain's read procedures — empty until #6127 moves its reads here (ADR 0005 D1).
 * Pre-created and wired into the root router by #6113 so no lane ever edits `router.ts`
 * (stress test R10). Each procedure starts from `query` in `@/lib/rpc/base`.
 */
export const billingRouter = {};
