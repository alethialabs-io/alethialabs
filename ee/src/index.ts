// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Alethia Enterprise Edition entry point. `register(core)` is invoked once at app
// boot by the core's allowlisted lib/enterprise.ts loader; it receives core
// capabilities (CoreContext.db) and returns the implementations the core seams
// consult: an optional PDP engine override, a multi-org tenancy resolver, extra
// Better Auth plugins (organization; SSO later), and the entitlement gate. Only
// TYPE imports from core (`@/...`) are used — erased at compile time — so this
// package never imports core runtime internals (it queries via core.db).

import type { CoreContext, EnterpriseModule } from "@/lib/enterprise";

/** Returns the enterprise registration. Implementations land in sub-phase 4.5b;
 *  an empty module keeps every core seam on its community default. */
export function register(_core: CoreContext): EnterpriseModule {
	return {};
}
