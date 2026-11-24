// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// LST-9 (#7491): an organization's identity providers are capped at SSO_PROVIDERS_MAX, which is the
// bound the console's unpaged SSO list is recorded against. The hooks are driven the way
// better-auth's dispatcher drives them, over a fake runner that holds the organization's rows.

import { APIError } from "better-auth/api";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  SSO_PROVIDER_CAP_PLUGIN_ID,
  SSO_PROVIDERS_FULL_MESSAGE,
  SSO_PROVIDERS_MAX,
  ssoProviderCapPlugin,
} from "./sso-provider-cap";

const ORG = "22222222-2222-4222-8222-222222222222";

/** The SQL text and bound strings of a drizzle `sql` template, flattened for matching. */
function queryText(query: SQL): string {
  const seen = new Set<object>();
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object" && node !== null && !seen.has(node)) {
      seen.add(node);
      const values: unknown[] = Object.values(node);
      for (const value of values) walk(value);
    }
  };
  walk(query);
  return parts.join(" ").replace(/\s+/g, " ");
}

/** A runner holding `providers` (provider ids) for ORG; a delete removes the id it names. */
function fakeDb(initial: number) {
  const providers = Array.from({ length: initial }, (_, i) => `p-${String(i).padStart(3, "0")}`);
  return {
    providers,
    db: {
      execute: async (query: SQL): Promise<unknown[]> => {
        const text = queryText(query);
        if (text.includes("select count(*)")) return [{ n: providers.length }];
        if (text.includes("delete from sso_provider")) {
          const at = providers.findIndex((id) => text.includes(id));
          if (at >= 0) providers.splice(at, 1);
          return [];
        }
        throw new Error(`unexpected query: ${text}`);
      },
    },
  };
}

/** The plugin's hook of `kind`, or a thrown error when it has none. */
function hook(db: ReturnType<typeof fakeDb>["db"], kind: "before" | "after") {
  const plugin = ssoProviderCapPlugin(db);
  expect(plugin.id).toBe(SSO_PROVIDER_CAP_PLUGIN_ID);
  const found = plugin.hooks?.[kind]?.[0];
  if (!found) throw new Error(`the plugin registers no ${kind}-hook`);
  return found;
}

/** Runs a hook handler with the request context, as better-auth's dispatcher does. */
async function run(handler: object, context: unknown): Promise<void> {
  if (typeof handler !== "function") throw new Error("the hook handler is not callable");
  await Reflect.apply(handler, undefined, [context]);
}

/** The APIError `promise` rejected with. */
async function refusal(promise: Promise<unknown>): Promise<APIError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof APIError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

const body = (providerId = "new-idp") => ({ organizationId: ORG, providerId });

describe("ssoProviderCapPlugin", () => {
  it("guards /sso/register and no other path", () => {
    const { db } = fakeDb(0);
    for (const kind of ["before", "after"] as const) {
      const matches = (path: string): unknown =>
        Reflect.apply(hook(db, kind).matcher, undefined, [{ path }]);
      expect(matches("/sso/register")).toBe(true);
      expect(matches("/sso/update-provider")).toBe(false);
      expect(matches("/sso/callback/:providerId")).toBe(false);
    }
  });

  it("lets a registration through below the cap", async () => {
    const { db } = fakeDb(SSO_PROVIDERS_MAX - 1);
    await expect(run(hook(db, "before").handler, { body: body(), context: {} })).resolves.toBeUndefined();
  });

  it("refuses a registration before it is written once the organization is at the cap", async () => {
    const { db } = fakeDb(SSO_PROVIDERS_MAX);
    const err = await refusal(run(hook(db, "before").handler, { body: body(), context: {} }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe(SSO_PROVIDERS_FULL_MESSAGE);
  });

  it("keeps a registration that left the organization at the cap", async () => {
    const h = fakeDb(SSO_PROVIDERS_MAX);
    await expect(
      run(hook(h.db, "after").handler, { body: body("p-000"), context: { returned: { ok: true } } }),
    ).resolves.toBeUndefined();
    expect(h.providers).toHaveLength(SSO_PROVIDERS_MAX);
  });

  it("removes a registration that raced past the cap, and refuses it", async () => {
    const h = fakeDb(SSO_PROVIDERS_MAX + 1);
    const raced = h.providers[SSO_PROVIDERS_MAX];
    const err = await refusal(
      run(hook(h.db, "after").handler, { body: body(raced), context: { returned: { ok: true } } }),
    );
    expect(err.statusCode).toBe(409);
    expect(h.providers).toHaveLength(SSO_PROVIDERS_MAX);
    expect(h.providers).not.toContain(raced);
  });

  it("does nothing after a registration that was already refused", async () => {
    const h = fakeDb(SSO_PROVIDERS_MAX + 1);
    await expect(
      run(hook(h.db, "after").handler, {
        body: body("p-000"),
        context: { returned: new APIError("FORBIDDEN") },
      }),
    ).resolves.toBeUndefined();
    expect(h.providers).toHaveLength(SSO_PROVIDERS_MAX + 1);
  });
});
