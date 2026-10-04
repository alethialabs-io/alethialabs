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
function stubCore(
  newOrgSetup: CoreContext["newOrgSetup"] = passThroughSetup(),
  isOrgMember: CoreContext["isOrgMember"] = vi.fn(async () => false),
  roleChangeOwnerRefusal: CoreContext["roleChangeOwnerRefusal"] = vi.fn(async () => null),
  removalOwnerRefusal: CoreContext["removalOwnerRefusal"] = vi.fn(async () => null),
  isNonActiveMember: CoreContext["isNonActiveMember"] = vi.fn(async () => false),
): CoreContext {
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
    isOrgMember,
    roleChangeOwnerRefusal,
    removalOwnerRefusal,
    isNonActiveMember,
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
  async function setup(
    newOrgSetup?: CoreContext["newOrgSetup"],
    roleChangeOwnerRefusal?: CoreContext["roleChangeOwnerRefusal"],
    removalOwnerRefusal?: CoreContext["removalOwnerRefusal"],
    isNonActiveMember?: CoreContext["isNonActiveMember"],
  ) {
    // core's membership read, over this instance's own store.
    const isOrgMember = async (orgId: string, userId: string): Promise<boolean> =>
      db.member.some((m) => m.organizationId === orgId && m.userId === userId);
    const mod = register(
      stubCore(
        newOrgSetup,
        isOrgMember,
        roleChangeOwnerRefusal,
        removalOwnerRefusal,
        isNonActiveMember,
      ),
    );
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
    /** POSTs a JSON body to a better-auth endpoint as the user `as` names, the way a client would. */
    const postAs = (as: string, path: string, body: unknown): Promise<Response> =>
      auth.handler(
        new Request(`${baseURL}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: as, origin: baseURL },
          body: JSON.stringify(body),
        }),
      );
    /** POSTs as the signed-in owner. */
    const post = (path: string, body: unknown): Promise<Response> => postAs(cookie, path, body);
    /** Signs up another user and returns their session cookie and id. */
    const signUp = async (email: string): Promise<{ cookie: string; id: unknown }> => {
      const r = await auth.api.signUpEmail({
        body: { email, password: "a-long-password-1", name: email },
        returnHeaders: true,
      });
      const id = db.user.find((u) => u.email === email)?.id;
      return { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "", id };
    };
    return { db, post, postAs, signUp, userId: db.user[0]?.id };
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

  // #5445: `member` is unique on (organization, user), and better-auth's accept does not check for
  // an existing membership. A member who accepted a stale second invitation got a raw unique violation
  // (before the index: a second member row, a second billable seat). Against the previous head this
  // accept answers 200 and stores a second row for the same person.
  it("refuses an invitation accepted by someone already in the team, with a reason, and adds no row", async () => {
    const { db, post, postAs, signUp } = await setup();
    const created = await post("/organization/create", { name: "Acme", slug: "acme" });
    expect(created.status).toBe(200);
    const orgId = db.organization[0]?.id;
    const invitee = await signUp("member@example.com");
    db.member.push({
      id: "member-existing",
      organizationId: orgId,
      userId: invitee.id,
      role: "viewer",
      createdAt: new Date(),
    });
    db.invitation.push({
      id: "invite-stale",
      organizationId: orgId,
      email: "member@example.com",
      role: "admin",
      status: "pending",
      inviterId: db.user[0]?.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    });

    const res = await postAs(invitee.cookie, "/organization/accept-invitation", {
      invitationId: "invite-stale",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
      message: expect.stringMatching(/already a member/),
    });
    expect(db.member.filter((m) => m.userId === invitee.id)).toHaveLength(1);
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

  // #5465: a role change that would leave the org with no ACTIVE owner is refused inside
  // better-auth's own endpoint, with core's sentence. better-auth's built-in check counts suspended
  // owners and sees only self-demotion, so against the previous head this answers 200 and stores
  // the new role.
  it("refuses POST /organization/update-member-role when core says it leaves no active owner, and keeps the role", async () => {
    const refuse = vi.fn(async (_org: string, memberId: string, _role: string) =>
      memberId === "member-last-owner" ? "only active owner" : null,
    );
    const { db, post, signUp } = await setup(undefined, refuse);
    const created = await post("/organization/create", { name: "Acme", slug: "acme" });
    expect(created.status).toBe(200);
    const orgId = db.organization[0]?.id;
    // Both users are signed up before any row is pushed: written interleaved with the sign-ups, the
    // pushed rows were missing from the in-memory store when the endpoint read it.
    const secondOwner = await signUp("second-owner@example.com");
    const admin = await signUp("admin@example.com");
    db.member.push(
      {
        id: "member-last-owner",
        organizationId: orgId,
        userId: secondOwner.id,
        role: "owner",
        createdAt: new Date(),
      },
      {
        id: "member-admin",
        organizationId: orgId,
        userId: admin.id,
        role: "admin",
        createdAt: new Date(),
      },
    );

    // The control: the same endpoint and plugin, a change core does not refuse, is stored.
    const ok = await post("/organization/update-member-role", {
      organizationId: orgId,
      memberId: "member-admin",
      role: "viewer",
    });
    expect(ok.status).toBe(200);
    expect(db.member.find((m) => m.id === "member-admin")?.role).toBe("viewer");

    const res = await post("/organization/update-member-role", {
      organizationId: orgId,
      memberId: "member-last-owner",
      role: "viewer",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "ORGANIZATION_NEEDS_AN_ACTIVE_OWNER",
      message: "only active owner",
    });
    expect(refuse).toHaveBeenCalledWith(orgId, "member-last-owner", "viewer");
    expect(db.member.find((m) => m.id === "member-last-owner")?.role).toBe("owner");
  });

  // #5472: a removal that would leave the org with no ACTIVE owner is refused inside better-auth's
  // own endpoint, with core's sentence. better-auth's built-in check counts suspended owners as
  // owners, so against the previous head this answers 200 and deletes the member.
  it("refuses POST /organization/remove-member when core says it leaves no active owner, and keeps the member", async () => {
    const refuse = vi.fn(async (_org: string, memberId: string) =>
      memberId === "member-last-active-owner" ? "only active owner" : null,
    );
    const { db, post, signUp } = await setup(undefined, undefined, refuse);
    const created = await post("/organization/create", { name: "Acme", slug: "acme" });
    expect(created.status).toBe(200);
    const orgId = db.organization[0]?.id;
    const secondOwner = await signUp("second-owner@example.com");
    const viewer = await signUp("viewer@example.com");
    db.member.push(
      {
        id: "member-last-active-owner",
        organizationId: orgId,
        userId: secondOwner.id,
        role: "owner",
        createdAt: new Date(),
      },
      {
        id: "member-viewer",
        organizationId: orgId,
        userId: viewer.id,
        role: "viewer",
        createdAt: new Date(),
      },
    );

    // The control: a removal core does not refuse goes through the same endpoint and plugin.
    const ok = await post("/organization/remove-member", {
      organizationId: orgId,
      memberIdOrEmail: "member-viewer",
    });
    expect(ok.status).toBe(200);
    expect(db.member.some((m) => m.id === "member-viewer")).toBe(false);

    const res = await post("/organization/remove-member", {
      organizationId: orgId,
      memberIdOrEmail: "member-last-active-owner",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "ORGANIZATION_NEEDS_AN_ACTIVE_OWNER",
      message: "only active owner",
    });
    expect(refuse).toHaveBeenCalledWith(orgId, "member-last-active-owner");
    expect(db.member.some((m) => m.id === "member-last-active-owner")).toBe(true);
  });

  // #5472: an inviter whose membership is not active is refused inside better-auth's own endpoint.
  // better-auth authorizes the invitation from `member.role` alone, so against the previous head a
  // suspended owner's invitation is stored.
  it("refuses POST /organization/invite-member from an inviter core reports as not active, and stores no invitation", async () => {
    let suspended = true;
    const nonActive = vi.fn(async (_org: string, _user: string) => suspended);
    const { db, post, userId } = await setup(undefined, undefined, undefined, nonActive);
    const created = await post("/organization/create", { name: "Acme", slug: "acme" });
    expect(created.status).toBe(200);
    const orgId = db.organization[0]?.id;

    const res = await post("/organization/invite-member", {
      organizationId: orgId,
      email: "second@example.com",
      role: "admin",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "MEMBER_NOT_ACTIVE" });
    expect(nonActive).toHaveBeenCalledWith(orgId, userId);
    expect(db.invitation).toHaveLength(0);

    // The control: the same inviter, active, invites.
    suspended = false;
    const ok = await post("/organization/invite-member", {
      organizationId: orgId,
      email: "second@example.com",
      role: "admin",
    });
    expect(ok.status).toBe(200);
    expect(db.invitation).toHaveLength(1);
  });
});
