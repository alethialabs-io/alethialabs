// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Access for a member who arrives through single sign-on (./sso-provisioning, #6892).
//
// These cases drive the decision against a stubbed core, so each one can state the member it
// starts from. The stub's `ensureMemberGrant` is what moves the member from "no grant" to "one
// grant" — the second read in `ensureSsoMemberAccess` and every later call see that — so "a second
// sign-in writes nothing" is asserted against state the first call changed, not against a fixture
// that says so. The real grant row, the real PDP and the real seat count are
// apps/console/tests/integration/sso-provisioning.test.ts, against Postgres.

import { sso } from "@better-auth/sso";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  ensureSsoMemberAccess,
  isSsoSignInPath,
  provisionSsoSignIn,
  SSO_GRANT_REASON,
  SSO_PROVISIONED_ROLE,
  SSO_PROVISIONING_PLUGIN_ID,
  SSO_SIGN_IN_PATHS,
  type SsoProvisioningCore,
  ssoProvisioningPlugin,
} from "./sso-provisioning";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";

/** One member's row as the membership query returns it. */
interface MemberRow {
  role: string;
  status: string;
  user_grants: number;
  revocations_since_join: number;
}

/**
 * Every string inside a built `SQL` — its literal text and its bound string values — joined:
 * enough to tell the two queries apart without asserting on drizzle's chunk shape. Walked rather than JSON-stringified: a built query
 * holds parameter objects with circular references.
 */
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

/**
 * A stubbed core holding one member per organization.
 *
 * `members` maps an organization id to that member's row, or to null for "no member row".
 * `ensureMemberGrant` gives the member of the organization it is called for one grant — unless
 * `grantWrites` is false, which models core declining to write. `organizations` is what the
 * reached-through-SSO query answers.
 */
function harness(opts: {
  members: Record<string, Partial<MemberRow> | null>;
  organizations?: string[];
  grantWrites?: boolean;
  membershipRows?: unknown[];
}) {
  const members = new Map<string, MemberRow | null>();
  for (const [orgId, row] of Object.entries(opts.members)) {
    members.set(
      orgId,
      row === null
        ? null
        : {
            role: SSO_PROVISIONED_ROLE,
            status: "active",
            user_grants: 0,
            revocations_since_join: 0,
            ...row,
          },
    );
  }
  const queries: string[] = [];
  const ensureMemberGrant = vi.fn<SsoProvisioningCore["ensureMemberGrant"]>(
    async (orgId: string) => {
      const row = members.get(orgId);
      if (row && opts.grantWrites !== false) members.set(orgId, { ...row, user_grants: 1 });
    },
  );
  const syncOrgSeats = vi.fn<SsoProvisioningCore["syncOrgSeats"]>(async () => undefined);
  const recordActivity = vi.fn<SsoProvisioningCore["recordActivity"]>(() => undefined);
  const emitAlertEvent = vi.fn<SsoProvisioningCore["emitAlertEvent"]>(() => undefined);
  const core: SsoProvisioningCore = {
    db: {
      execute: async (query: SQL): Promise<unknown[]> => {
        const text = queryText(query);
        queries.push(text);
        if (text.includes("sso_provider")) {
          return (opts.organizations ?? []).map((id) => ({ organization_id: id }));
        }
        if (opts.membershipRows) return opts.membershipRows;
        // The membership query binds the organization id, and the walk above collects bound
        // strings too; find which organization this call named.
        const named = [...members.keys()].find((orgId) => text.includes(orgId));
        const row = named === undefined ? null : (members.get(named) ?? null);
        return row === null ? [] : [row];
      },
    },
    ensureMemberGrant,
    syncOrgSeats,
    recordActivity,
    emitAlertEvent,
  };
  return { core, queries, ensureMemberGrant, syncOrgSeats, recordActivity, emitAlertEvent };
}

/** `path` of a mounted better-auth endpoint, or null when the value carries none. */
function endpointPath(endpoint: unknown): string | null {
  if (typeof endpoint !== "function" && (typeof endpoint !== "object" || endpoint === null)) {
    return null;
  }
  const path: unknown = Reflect.get(endpoint, "path");
  return typeof path === "string" ? path : null;
}

describe("ensureSsoMemberAccess", () => {
  it("grants a new SSO member the provisioned role once: one grant, one seat sync, one record", async () => {
    const h = harness({ members: { [ORG]: {} } });

    const outcome = await ensureSsoMemberAccess(h.core, {
      userId: USER,
      organizationId: ORG,
      email: "new@example.test",
    });

    expect(outcome).toBe("granted");
    expect(h.ensureMemberGrant).toHaveBeenCalledTimes(1);
    expect(h.ensureMemberGrant).toHaveBeenCalledWith(ORG, USER, SSO_PROVISIONED_ROLE);
    expect(h.syncOrgSeats).toHaveBeenCalledTimes(1);
    expect(h.syncOrgSeats).toHaveBeenCalledWith(ORG);
    expect(h.recordActivity).toHaveBeenCalledTimes(1);
    expect(h.recordActivity).toHaveBeenCalledWith(
      { userId: USER, orgId: ORG },
      "join",
      { type: "member", id: USER },
      { reason: SSO_GRANT_REASON },
    );
    expect(h.emitAlertEvent).toHaveBeenCalledTimes(1);
    expect(h.emitAlertEvent).toHaveBeenCalledWith(
      ORG,
      "system.member.joined",
      expect.objectContaining({ title: "Member joined: new@example.test", actor_id: USER }),
    );
  });

  it("a second sign-in writes nothing: no grant, no seat sync, no record", async () => {
    const h = harness({ members: { [ORG]: {} } });
    await ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG });

    const again = await ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG });

    expect(again).toBe("already-granted");
    expect(h.ensureMemberGrant).toHaveBeenCalledTimes(1);
    expect(h.syncOrgSeats).toHaveBeenCalledTimes(1);
    expect(h.recordActivity).toHaveBeenCalledTimes(1);
    expect(h.emitAlertEvent).toHaveBeenCalledTimes(1);
  });

  it("labels the event with the user id when no email is given", async () => {
    const h = harness({ members: { [ORG]: {} } });
    await ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG });
    expect(h.emitAlertEvent).toHaveBeenCalledWith(
      ORG,
      "system.member.joined",
      expect.objectContaining({ title: `Member joined: ${USER}` }),
    );
  });

  it.each([
    ["admin"],
    ["owner"],
    ["operator"],
    ["viewer"],
    ["member,admin"],
    [""],
  ])("never grants a stored role other than the provisioned one (%j)", async (role) => {
    const h = harness({ members: { [ORG]: { role } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const outcome = await ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG });

    expect(outcome).toBe("other-role");
    expect(h.ensureMemberGrant).not.toHaveBeenCalled();
    expect(h.syncOrgSeats).not.toHaveBeenCalled();
    expect(h.recordActivity).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("holds a member of an organization that revoked a grant since they joined", async () => {
    const h = harness({ members: { [ORG]: { revocations_since_join: 1 } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const outcome = await ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG });

    expect(outcome).toBe("held");
    expect(h.ensureMemberGrant).not.toHaveBeenCalled();
    expect(h.recordActivity).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves a member who already holds a grant alone, whatever their role", async () => {
    const h = harness({ members: { [ORG]: { role: "admin", user_grants: 2 } } });
    expect(await ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG })).toBe(
      "already-granted",
    );
    expect(h.ensureMemberGrant).not.toHaveBeenCalled();
  });

  it("does not grant a suspended member", async () => {
    const h = harness({ members: { [ORG]: { status: "suspended" } } });
    expect(await ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG })).toBe(
      "not-active",
    );
    expect(h.ensureMemberGrant).not.toHaveBeenCalled();
  });

  it("does not grant a user with no member row", async () => {
    const h = harness({ members: { [ORG]: null } });
    expect(await ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG })).toBe(
      "not-a-member",
    );
    expect(h.ensureMemberGrant).not.toHaveBeenCalled();
  });

  it("records nothing when core wrote no grant", async () => {
    const h = harness({ members: { [ORG]: {} }, grantWrites: false });

    const outcome = await ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG });

    expect(outcome).toBe("refused");
    expect(h.ensureMemberGrant).toHaveBeenCalledTimes(1);
    expect(h.syncOrgSeats).not.toHaveBeenCalled();
    expect(h.recordActivity).not.toHaveBeenCalled();
    expect(h.emitAlertEvent).not.toHaveBeenCalled();
  });

  /** Membership query results of a shape the module must refuse to interpret. */
  const UNREADABLE: [string, unknown[]][] = [
    ["a row with no grant count", [{ role: "member", status: "active", revocations_since_join: 0 }]],
    [
      "a row whose count is text",
      [{ role: "member", status: "active", user_grants: "0", revocations_since_join: 0 }],
    ],
    ["a row with no role", [{ status: "active", user_grants: 0, revocations_since_join: 0 }]],
    ["a row that is not an object", ["member"]],
  ];

  it.each(UNREADABLE)("throws on %s rather than reading it as 'no grants'", async (_name, membershipRows) => {
    const h = harness({ members: { [ORG]: {} }, membershipRows });
    await expect(
      ensureSsoMemberAccess(h.core, { userId: USER, organizationId: ORG }),
    ).rejects.toThrow(/sso-provisioning/);
    expect(h.ensureMemberGrant).not.toHaveBeenCalled();
  });
});

describe("provisionSsoSignIn", () => {
  it("decides each organization the user reaches through single sign-on separately", async () => {
    const h = harness({
      members: { [ORG]: {}, [OTHER_ORG]: { user_grants: 1 } },
      organizations: [ORG, OTHER_ORG],
    });

    const results = await provisionSsoSignIn(h.core, { id: USER, email: "new@example.test" });

    expect(results).toEqual([
      { organizationId: ORG, outcome: "granted" },
      { organizationId: OTHER_ORG, outcome: "already-granted" },
    ]);
    expect(h.ensureMemberGrant).toHaveBeenCalledTimes(1);
    expect(h.ensureMemberGrant).toHaveBeenCalledWith(ORG, USER, SSO_PROVISIONED_ROLE);
  });

  it("does nothing for a user who reaches no organization through single sign-on", async () => {
    const h = harness({ members: { [ORG]: {} }, organizations: [] });
    expect(await provisionSsoSignIn(h.core, { id: USER })).toEqual([]);
    expect(h.ensureMemberGrant).not.toHaveBeenCalled();
    // Only the organization query ran; no membership was read.
    expect(h.queries).toHaveLength(1);
  });

  it("reads organizations through a verified provider the user holds an account for", async () => {
    const h = harness({ members: {}, organizations: [] });
    await provisionSsoSignIn(h.core, { id: USER });
    const [text] = h.queries;
    expect(text).toContain("join sso_provider sp");
    expect(text).toContain("sp.domain_verified");
    expect(text).toContain("a.provider_id = sp.provider_id");
  });

  it("throws on an organization row it cannot read", async () => {
    const h = harness({ members: {} });
    h.core.db = { execute: async (): Promise<unknown[]> => [{ id: ORG }] };
    await expect(provisionSsoSignIn(h.core, { id: USER })).rejects.toThrow(/organization_id/);
  });
});

describe("the sign-in paths", () => {
  it("are exactly the installed SSO plugin's callback and assertion-consumer endpoints", () => {
    // Derived from the plugin as installed, not from this file's list: an endpoint renamed or
    // added upstream changes the left-hand side and turns this red.
    const mounted: unknown[] = Object.values(sso().endpoints);
    const completing = mounted
      .map(endpointPath)
      .filter((path): path is string => path !== null && /\/callback(\/|$)|\/acs\//.test(path));

    expect(completing.length).toBeGreaterThan(0);
    expect([...completing].sort()).toEqual([...SSO_SIGN_IN_PATHS].sort());
  });

  it("match only those paths", () => {
    for (const path of SSO_SIGN_IN_PATHS) expect(isSsoSignInPath(path)).toBe(true);
    for (const path of ["/sso/register", "/sign-in/sso", "/callback/:id", "/sign-in/email-otp", ""]) {
      expect(isSsoSignInPath(path)).toBe(false);
    }
    expect(isSsoSignInPath(undefined)).toBe(false);
  });
});

describe("ssoProvisioningPlugin", () => {
  /** The plugin's one after-hook, or a thrown error when the plugin has none. */
  function afterHook(core: SsoProvisioningCore) {
    const plugin = ssoProvisioningPlugin(core);
    expect(plugin.id).toBe(SSO_PROVISIONING_PLUGIN_ID);
    const hook = plugin.hooks?.after?.[0];
    if (!hook) throw new Error("the plugin registers no after-hook");
    return hook;
  }

  /** Runs a hook handler the way better-auth's dispatcher does: with the request context. */
  async function run(handler: object, context: unknown): Promise<void> {
    if (typeof handler !== "function") throw new Error("the hook handler is not callable");
    await Reflect.apply(handler, undefined, [context]);
  }

  it("matches the sign-in paths and no other", () => {
    const hook = afterHook(harness({ members: {} }).core);
    const matches = (path: string): unknown => Reflect.apply(hook.matcher, undefined, [{ path }]);
    expect(matches("/sso/callback/:providerId")).toBe(true);
    expect(matches("/sso/saml2/sp/acs/:providerId")).toBe(true);
    expect(matches("/sso/register")).toBe(false);
    expect(matches("/callback/:id")).toBe(false);
  });

  it("grants the member of the session the sign-in created", async () => {
    const h = harness({ members: { [ORG]: {} }, organizations: [ORG] });
    await run(afterHook(h.core).handler, {
      path: "/sso/callback/:providerId",
      context: { newSession: { user: { id: USER, email: "new@example.test" } } },
    });
    expect(h.ensureMemberGrant).toHaveBeenCalledWith(ORG, USER, SSO_PROVISIONED_ROLE);
    expect(h.syncOrgSeats).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the request created no session", async () => {
    const h = harness({ members: { [ORG]: {} }, organizations: [ORG] });
    await run(afterHook(h.core).handler, {
      path: "/sso/callback/:providerId",
      context: { newSession: null },
    });
    expect(h.queries).toHaveLength(0);
    expect(h.ensureMemberGrant).not.toHaveBeenCalled();
  });

  it("logs a failed step and lets the sign-in finish", async () => {
    const h = harness({ members: { [ORG]: {} }, organizations: [ORG] });
    h.core.db = {
      execute: async (): Promise<unknown[]> => {
        throw new Error("database unavailable");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      run(afterHook(h.core).handler, {
        path: "/sso/saml2/sp/acs/:providerId",
        context: { newSession: { user: { id: USER, email: "new@example.test" } } },
      }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(h.ensureMemberGrant).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
