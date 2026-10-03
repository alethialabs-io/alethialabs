// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// #5445 — a reserved slug is refused by the SERVER, not only by the console's forms.
//
// Three layers, because each answers a different question:
//   1. the hooks themselves, driven with core's REAL rule (the vitest `@` alias resolves
//      lib/routing.ts, which is pure), so "reserved" means exactly what the console means by it;
//   2. a real better-auth instance on its in-memory adapter, with an organization plugin this file
//      builds around these hooks, called the way a client that skipped the form would call it;
//   3. the organization plugin AS `register(core)` RETURNS IT, mounted in the same kind of instance
//      and driven over HTTP. Layers 1 and 2 never touch index.ts, so only layer 3 fails when the
//      `slugHooks` calls there are deleted — checked by deleting them: both layer-3 slug cases fail
//      and every other case still passes.

import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { describe, expect, it, vi } from "vitest";
import { orgAc, orgRoles } from "@/lib/authz/org-access-control";
import type { CoreContext } from "@/lib/enterprise";
import {
  ORG_SLUG_RESERVED_CODE,
  ORG_SLUG_RESERVED_MESSAGE,
  reservedOrgSlugRefusal,
} from "@/lib/routing";
import { register } from "./index";
import { orgSlugHooks } from "./org-slug-hooks";

const hooks = orgSlugHooks(reservedOrgSlugRefusal);

/** The APIError a hook threw, or a failure naming what it did instead. */
async function refusalOf(run: () => Promise<unknown>): Promise<APIError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof APIError) return err;
    throw err;
  }
  throw new Error("expected the hook to refuse, and it returned");
}

describe("orgSlugHooks — the rule", () => {
  it.each(["docs", "login", "api", "~", "Docs", " pricing "])(
    "refuses %j on create AND on update, with core's code and sentence",
    async (slug) => {
      for (const hook of [hooks.beforeCreateOrganization, hooks.beforeUpdateOrganization]) {
        const err = await refusalOf(() => hook({ organization: { slug } }));
        expect(err.statusCode).toBe(400);
        expect(err.body).toMatchObject({
          code: ORG_SLUG_RESERVED_CODE,
          message: ORG_SLUG_RESERVED_MESSAGE,
        });
      }
    },
  );

  it("lets an ordinary slug through, and an update that does not touch the slug", async () => {
    await expect(
      hooks.beforeCreateOrganization({ organization: { slug: "acme" } }),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeUpdateOrganization({ organization: { slug: "acme-2" } }),
    ).resolves.toBeUndefined();
    await expect(hooks.beforeUpdateOrganization({ organization: {} })).resolves.toBeUndefined();
  });
});

describe("orgSlugHooks — inside better-auth's own endpoints", () => {
  /** A real better-auth with the organization plugin carrying these hooks, and a signed-in user. */
  async function setup() {
    const db: Record<string, Record<string, unknown>[]> = {
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
      invitation: [],
    };
    const auth = betterAuth({
      secret: "test-secret-test-secret-test-secret-0123",
      baseURL: "http://localhost:3000",
      database: memoryAdapter(db),
      emailAndPassword: { enabled: true },
      plugins: [organization({ organizationHooks: { ...hooks } })],
    });
    const res = await auth.api.signUpEmail({
      body: { email: "owner@example.com", password: "a-long-password-1", name: "Owner" },
      returnHeaders: true,
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    const headers = new Headers({ cookie: cookie.split(";")[0] ?? "" });
    return { auth, db, headers };
  }

  it("refuses a direct create with a reserved slug, and stores no organization", async () => {
    const { auth, db, headers } = await setup();
    const err = await refusalOf(() =>
      auth.api.createOrganization({ body: { name: "Docs", slug: "docs" }, headers }),
    );
    expect(err.body).toMatchObject({ code: ORG_SLUG_RESERVED_CODE });
    expect(db.organization).toHaveLength(0);
  });

  it("refuses a direct rename onto a reserved slug, and keeps the old one", async () => {
    const { auth, db, headers } = await setup();
    const org = await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers,
    });
    expect(org?.slug).toBe("acme");

    const err = await refusalOf(() =>
      auth.api.updateOrganization({
        body: { organizationId: org?.id, data: { slug: "pricing" } },
        headers,
      }),
    );
    expect(err.body).toMatchObject({ code: ORG_SLUG_RESERVED_CODE });
    expect(db.organization[0]).toMatchObject({ slug: "acme" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The two blocks above build their OWN organization plugin from `orgSlugHooks`. Neither goes
// through `register(core)`, so they stay green with the `slugHooks` calls deleted from
// index.ts — the calls that make production refuse `docs`. This block mounts the organization
// plugin exactly as `register` returns it and calls better-auth's HTTP endpoints, so removing those
// calls, or adding a later `beforeCreateOrganization` / `beforeUpdateOrganization` key that overrides
// them, turns these cases red.

/**
 * The CoreContext `register` receives, with core's REAL org roles and reserved-slug rule and every
 * runtime-bound member stubbed. OpenFGA is reported off, so `register` builds no FGA client and
 * never touches `db`; the lifecycle hooks the create path fires resolve without doing anything.
 */
function stubCore(newOrgSetup: CoreContext["newOrgSetup"] = passThroughSetup()): CoreContext {
  const stub = {
    db: {},
    orgAc,
    orgRoles,
    reservedOrgSlugRefusal,
    ensureMemberGrant: vi.fn(async () => undefined),
    revokeMemberGrant: vi.fn(async () => undefined),
    sendInviteEmail: vi.fn(async () => undefined),
    canOrgInvite: vi.fn(async () => true),
    canOrgCreateTeams: vi.fn(async () => true),
    syncOrgSeats: vi.fn(async () => undefined),
    emitAlertEvent: vi.fn(),
    recordActivity: vi.fn(),
    resolveOrgEntitlements: vi.fn(),
    newOrgSetup,
    fga: { isEnabled: () => false },
  };
  // A test-only stub: `db` and most of `fga` are never reached with OpenFGA off (see above).
  return stub as unknown as CoreContext;
}

/** core's paid create-a-team marker capabilities, leaving every payload alone (none carries it). */
function passThroughSetup(): CoreContext["newOrgSetup"] {
  return {
    stampMetadata: vi.fn(async () => null),
    recordCreated: vi.fn(async () => undefined),
    keepStoredMarker: vi.fn(async () => null),
  };
}

/**
 * core's marker capabilities as the #5445 cases below need them: any marker is stamped for the
 * caller, `sub_taken` is refused as already having its org, and an update gets a fixed stored blob.
 */
function stubSetup() {
  return {
    stampMetadata: vi.fn(async (metadata: unknown, userId: string) => {
      if (typeof metadata !== "object" || metadata === null) return null;
      const sub: unknown = Reflect.get(metadata, "newOrgSubscriptionId");
      if (typeof sub !== "string") return null;
      if (sub === "sub_taken") {
        return { refusal: { code: "NEW_ORG_SETUP_ORG_EXISTS", message: "already" } };
      }
      return { metadata: { newOrgSubscriptionId: sub, newOrgCreatedBy: userId } };
    }),
    recordCreated: vi.fn(async () => undefined),
    keepStoredMarker: vi.fn(async (_orgId: string, metadata: unknown) =>
      typeof metadata === "object" && metadata !== null
        ? { metadata: { stored: "marker-kept" } }
        : null,
    ),
  };
}

describe("register(core) — the organization plugin production mounts", () => {
  /** A better-auth carrying the plugin `register` returned, a signed-in user, and an HTTP caller. */
  async function setup(newOrgSetup?: CoreContext["newOrgSetup"]) {
    const mod = register(stubCore(newOrgSetup));
    const orgPlugin = mod.authPlugins?.find((p) => p.id === "organization");
    if (!orgPlugin) throw new Error("register() returned no organization plugin");
    const db: Record<string, Record<string, unknown>[]> = {
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
      invitation: [],
      team: [],
      teamMember: [],
    };
    const baseURL = "http://localhost:3000";
    const auth = betterAuth({
      secret: "test-secret-test-secret-test-secret-0123",
      baseURL,
      database: memoryAdapter(db),
      emailAndPassword: { enabled: true },
      // The cast is about TYPES only. `authPlugins` is typed through `CoreContext`, i.e. the
      // console's better-auth, while this instance is ee's own copy — two installed versions whose
      // plugin types tsc treats as distinct. The object is the one `register` built with ee's
      // `organization()`, the same function this instance is built from.
      plugins: [orgPlugin as unknown as BetterAuthPlugin],
    });
    const res = await auth.api.signUpEmail({
      body: { email: "owner@example.com", password: "a-long-password-1", name: "Owner" },
      returnHeaders: true,
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    /** POSTs a JSON body to a better-auth endpoint as the signed-in user, the way a client would. */
    const post = (path: string, body: unknown): Promise<Response> =>
      auth.handler(
        new Request(`${baseURL}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin: baseURL },
          body: JSON.stringify(body),
        }),
      );
    return { db, post, userId: db.user[0]?.id };
  }

  it("refuses POST /organization/create with slug `docs`, and stores no organization", async () => {
    const { db, post } = await setup();
    const res = await post("/organization/create", { name: "Docs", slug: "docs" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: ORG_SLUG_RESERVED_CODE,
      message: ORG_SLUG_RESERVED_MESSAGE,
    });
    expect(db.organization).toHaveLength(0);
  });

  it("refuses POST /organization/update onto slug `docs`, and keeps the old slug", async () => {
    const { db, post } = await setup();
    // The control: an ordinary slug is accepted through the same mounted plugin, so the refusal
    // below is the slug rule and not a create path that refuses everything.
    const created = await post("/organization/create", { name: "Acme", slug: "acme" });
    expect(created.status).toBe(200);
    const org: unknown = await created.json();
    const orgId =
      typeof org === "object" && org !== null && "id" in org && typeof org.id === "string"
        ? org.id
        : "";
    expect(orgId).not.toBe("");

    const res = await post("/organization/update", {
      organizationId: orgId,
      data: { slug: "docs" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: ORG_SLUG_RESERVED_CODE });
    expect(db.organization[0]).toMatchObject({ slug: "acme" });
  });

  // #5445: the paid create-a-team marker, through the same mounted plugin. Deleting the
  // `setupHooks` calls in index.ts turns these red.
  it("stores the creator the SESSION names beside the marker, over the one the request sent, and records the org", async () => {
    const marker = stubSetup();
    const { db, post, userId } = await setup(marker);
    const res = await post("/organization/create", {
      name: "Acme",
      slug: "acme",
      metadata: { newOrgSubscriptionId: "sub_1", newOrgCreatedBy: "someone-else" },
    });
    expect(res.status).toBe(200);
    const stored = db.organization[0]?.metadata;
    expect(typeof stored === "string" ? JSON.parse(stored) : stored).toEqual({
      newOrgSubscriptionId: "sub_1",
      newOrgCreatedBy: userId,
    });
    expect(marker.recordCreated).toHaveBeenCalledWith(db.organization[0]?.id, expect.anything(), userId);
  });

  it("refuses a create for a charge that already has its org, and stores nothing", async () => {
    const { db, post } = await setup(stubSetup());
    const res = await post("/organization/create", {
      name: "Acme",
      slug: "acme",
      metadata: { newOrgSubscriptionId: "sub_taken" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "NEW_ORG_SETUP_ORG_EXISTS" });
    expect(db.organization).toHaveLength(0);
  });

  it("an update that writes the metadata gets the stored marker from core, not the request's", async () => {
    const marker = stubSetup();
    const { db, post } = await setup(marker);
    const created = await post("/organization/create", { name: "Acme", slug: "acme" });
    expect(created.status).toBe(200);
    const orgId = db.organization[0]?.id;
    const res = await post("/organization/update", {
      organizationId: orgId,
      data: { metadata: { newOrgSubscriptionId: "sub_forged" } },
    });
    expect(res.status).toBe(200);
    expect(marker.keepStoredMarker).toHaveBeenCalledWith(orgId, { newOrgSubscriptionId: "sub_forged" });
    const stored = db.organization[0]?.metadata;
    expect(typeof stored === "string" ? JSON.parse(stored) : stored).toEqual({ stored: "marker-kept" });
  });
});
