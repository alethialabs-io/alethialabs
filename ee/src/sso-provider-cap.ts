// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The most identity providers one organization may configure (LST-9, #7491).
//
// The console's SSO settings list reads every provider of the org in one read and does not page
// it; `apps/console/list-standard/sso.json` records that decision, and it holds only because the
// write is capped HERE. @better-auth/sso's own `providersLimit` counts providers per USER (default
// 10), so an organization with many administrators had no bound at all.
//
// Better Auth inserts the row itself, outside any transaction this module can hold, so the cap is
// enforced twice:
//   1. BEFORE /sso/register: an organization already at the cap is refused before anything is
//      written, with a sentence the provider sheet shows as it is.
//   2. AFTER a registration that succeeded: the organization's providers are counted again, and a
//      registration that took it past the cap removes its own row and is refused. Two requests that
//      both passed step 1 at the cap cannot both stay: the one committed last sees the other's row.
//      At worst both see each other and both are refused, and a retry then succeeds — the list never
//      ends above the cap.

import { APIError, createAuthMiddleware } from "better-auth/api";
import { sql } from "drizzle-orm";
import type { ScopeQueryRunner } from "./scope";
import type { EnterpriseAuthPlugin } from "./sso-provisioning";

/** The most identity providers one organization may hold. */
export const SSO_PROVIDERS_MAX = 20;

/** The plugin id, for the hook's place in better-auth's plugin order. */
export const SSO_PROVIDER_CAP_PLUGIN_ID = "alethia-sso-provider-cap";

/** The path the cap guards: the one endpoint that creates a provider. */
const REGISTER_PATH = "/sso/register";

/** The refusal an organization at the cap is given. */
export const SSO_PROVIDERS_FULL_MESSAGE =
  `This organization already has ${SSO_PROVIDERS_MAX} identity providers, the most it can ` +
  "configure. Remove one before connecting another.";

/** A string field of the request body, or null. */
function bodyField(body: unknown, field: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value: unknown = Reflect.get(body, field);
  return typeof value === "string" ? value : null;
}

/** How many identity providers organization `orgId` holds. */
export async function countOrgProviders(db: ScopeQueryRunner, orgId: string): Promise<number> {
  const rows = await db.execute(
    sql`select count(*)::int as n from sso_provider where organization_id = ${orgId}::uuid`,
  );
  const row: unknown = rows[0];
  const n: unknown = typeof row === "object" && row !== null ? Reflect.get(row, "n") : undefined;
  if (typeof n !== "number") throw new Error("sso-provider-cap: count query returned no number");
  return n;
}

/**
 * The Better Auth plugin that caps an organization's identity providers at
 * {@link SSO_PROVIDERS_MAX}. It must be listed AFTER `sso()`, so its after-hook runs once the
 * provider row exists. A registration with no organization is left to the entitlement guard,
 * which refuses it.
 *
 * @param db a tagged-SQL runner over the service connection
 */
export function ssoProviderCapPlugin(db: ScopeQueryRunner): EnterpriseAuthPlugin {
  const matcher = (context: { path?: string }) => context.path === REGISTER_PATH;
  return {
    id: SSO_PROVIDER_CAP_PLUGIN_ID,
    hooks: {
      before: [
        {
          matcher,
          handler: createAuthMiddleware(async (ctx) => {
            const orgId = bodyField(ctx.body, "organizationId");
            if (!orgId) return;
            if ((await countOrgProviders(db, orgId)) >= SSO_PROVIDERS_MAX) {
              throw new APIError("CONFLICT", { message: SSO_PROVIDERS_FULL_MESSAGE });
            }
          }),
        },
      ],
      after: [
        {
          matcher,
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof APIError) return;
            const orgId = bodyField(ctx.body, "organizationId");
            const providerId = bodyField(ctx.body, "providerId");
            if (!orgId || !providerId) return;
            if ((await countOrgProviders(db, orgId)) <= SSO_PROVIDERS_MAX) return;
            await db.execute(
              sql`delete from sso_provider where provider_id = ${providerId} and organization_id = ${orgId}::uuid`,
            );
            throw new APIError("CONFLICT", { message: SSO_PROVIDERS_FULL_MESSAGE });
          }),
        },
      ],
    },
  };
}
