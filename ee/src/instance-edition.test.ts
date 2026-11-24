// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// #7016 — the enterprise build reports its edition, and the two entitlement gates in the entry
// file read the same entitlements an organization's scope carries.
//
// Three layers:
//   1. `licensedEntitlements` and `editionReport`, the pure decision, at fixed clocks;
//   2. the module `register(core)` returns, under a real signed licence in the environment: its
//      `instanceEdition()` report and its `resolveEntitlements`;
//   3. the two gates AS `register(core)` MOUNTS THEM, in a real better-auth instance driven over
//      HTTP — creating a team, and registering a single sign-on provider — for each cell of
//      {hosted with a plan, hosted without, self-managed licensed with no billing record,
//      self-managed unlicensed}.
//
// What "hosted" and "self-managed" mean here: this package does not read the deployment mode. A
// hosted organization is one whose billing record answers; a licensed self-managed instance is one
// with a verified licence in its environment and no billing record for anyone. The licence is
// minted by `issueLicense` and verified by the real `resolveInstanceLicense`; nothing stands in for
// either. core's `canOrgCreateTeams` is the real function, over a mocked billing read.
//
// Expected values are written out by hand, never derived from the module under test.

import { parseEnterpriseEditionReport } from "@alethia/enterprise-api";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthEndpoint } from "better-auth/api";
import { createAccessControl } from "better-auth/plugins/access";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orgAc, orgRoles } from "@/lib/authz/org-access-control";
import type { Entitlements } from "@/lib/authz/types";
import type { CoreContext } from "@/lib/enterprise";
import { reservedOrgSlugRefusal } from "@/lib/routing";
import { orgSlugShapeRefusal } from "@repo/org-slug";

/** The organization's billing record, as core's billing read answers it in the case under test. */
const billing = vi.hoisted(() => ({
  resolveOrgEntitlements: vi.fn<(orgId: string) => Promise<unknown>>(),
}));

// core's billing module reaches the database; only its entitlement read is needed, and each case
// states what it answers. `canOrgCreateTeams` itself is NOT mocked.
vi.mock("@/lib/billing/queries", () => ({
  getOrgBilling: vi.fn(),
  resolveOrgEntitlements: billing.resolveOrgEntitlements,
}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: () => false }));

import { canOrgCreateTeams } from "@/lib/billing/collaboration";
import { ENTERPRISE_FEATURES, editionReport, licensedEntitlements, register } from "./index";
import { __resetLicenseCache, type InstanceLicense } from "./license";
import { generateLicenseKeypair, issueLicense } from "./license-issue";

/** The fixed clock the pure cases are read at: 2026-12-01T00:00:00Z. */
const NOW = new Date("2026-12-01T00:00:00.000Z");
const NOW_SECONDS = 1_796_083_200;

/** The ten capability names, written out. */
const ALL_CAPABILITIES = [
  "activityExport",
  "advancedAlerting",
  "agentPolicy",
  "alerting",
  "byoRunners",
  "customRoles",
  "managedPools",
  "organizations",
  "sso",
  "teams",
];

/** The registry as the build names it today: two built modules, five planned. */
const FEATURES = [
  { id: "sso-provisioning", built: true },
  { id: "enforced-sso", built: false },
  { id: "group-mapping", built: false },
  { id: "scim", built: false },
  { id: "audit-stream", built: false },
  { id: "session-policy", built: false },
  { id: "agent-policy", built: true },
];

/** Every switch off: what an organization with no billing record has. */
const NO_PLAN: Entitlements = {
  organizations: false,
  teams: false,
  sso: false,
  customRoles: false,
  activityExport: false,
  alerting: false,
  advancedAlerting: false,
  byoRunners: false,
  managedPools: false,
  agentPolicy: false,
  quotas: {
    maxConcurrentJobs: 2,
    priorityLevel: 0,
    includedRunnerMinutes: 200,
    activityRetentionDays: 7,
  },
};

/** The enterprise plan's switches: what a hosted organization on that plan has. */
const ENTERPRISE_PLAN: Entitlements = {
  ...NO_PLAN,
  organizations: true,
  teams: true,
  sso: true,
  customRoles: true,
  activityExport: true,
  alerting: true,
  advancedAlerting: true,
  byoRunners: true,
  managedPools: true,
  agentPolicy: true,
};

/** The team plan's switches: a paid hosted plan that carries neither teams nor single sign-on. */
const TEAM_PLAN: Entitlements = {
  ...NO_PLAN,
  organizations: true,
  alerting: true,
  byoRunners: true,
};

const keys = generateLicenseKeypair();

/** Installs a licence signed by this file's key, verifiable by the installed public key. */
async function installLicense(
  input: { expiresInDays?: number; nowSeconds?: number; entitlements?: Entitlements } = {},
): Promise<void> {
  process.env.ALETHIA_LICENSE_KEY = await issueLicense({
    privateKeyB64: keys.privateKeyB64,
    subject: "acme-corp",
    ...input,
  });
  process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
}

/** Snapshot and restore the environment, so one case's licence is never another's. */
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.ALETHIA_LICENSE_ACTIVE;
  delete process.env.ALETHIA_LICENSE_KEY;
  delete process.env.ALETHIA_LICENSE_PUBLIC_KEY;
  __resetLicenseCache();
  billing.resolveOrgEntitlements.mockReset();
  billing.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.env = savedEnv;
  __resetLicenseCache();
});

/**
 * A verified licence as `resolveInstanceLicense` returns it. `graceDays` defaults to 0 so a case
 * about the licence's end reads that end directly; the grace cases pass their own.
 */
function verified(
  expiresAt: number | null,
  entitlements?: Entitlements,
  graceDays = 0,
): InstanceLicense {
  return {
    verified: true,
    license: { subject: "acme-corp", tier: "enterprise", expiresAt, entitlements, graceDays },
  };
}

/**
 * Reads an unknown value as an entitlements claim the way the licence reader does: any object is
 * taken as one, whatever its members hold.
 */
function isClaimObject(value: unknown): value is Entitlements {
  return typeof value === "object" && value !== null;
}

describe("licensedEntitlements — when the instance licence grants", () => {
  it("grants every switch for a verified licence with no end", () => {
    const granted = licensedEntitlements(verified(null), NOW);
    expect(granted).toMatchObject({ teams: true, sso: true, organizations: true });
  });

  it("grants for a verified licence whose end has not passed", () => {
    expect(licensedEntitlements(verified(NOW_SECONDS + 1), NOW)).not.toBeNull();
  });

  it("grants nothing at the instant the licence ends, and nothing after", () => {
    expect(licensedEntitlements(verified(NOW_SECONDS), NOW)).toBeNull();
    expect(licensedEntitlements(verified(NOW_SECONDS - 86_400), NOW)).toBeNull();
  });

  it("grants nothing when the end is not a number that can be compared", () => {
    expect(licensedEntitlements(verified(Number.NaN), NOW)).toBeNull();
  });

  it("grants nothing for a licence that was not verified", () => {
    expect(licensedEntitlements({ verified: false, reason: "no licence" }, NOW)).toBeNull();
  });

  it("grants nothing when the state says verified and carries no licence", () => {
    expect(licensedEntitlements({ verified: true }, NOW)).toBeNull();
  });

  it("grants exactly the entitlements a licence names, when it names them", () => {
    const narrowed: Entitlements = { ...NO_PLAN, teams: true };
    expect(licensedEntitlements(verified(null, narrowed), NOW)).toEqual(narrowed);
  });
});

describe("editionReport — what the build reports", () => {
  it("reports `none`, no capabilities and the whole registry when no licence is installed", () => {
    const report = editionReport({ verified: false, reason: "none" }, ENTERPRISE_FEATURES, NOW, false);
    expect(report).toEqual({
      license: { state: "none", subject: null, tier: null, expiresAt: null, graceEndsAt: null },
      capabilities: [],
      features: FEATURES,
    });
  });

  it("reports `invalid` and no capabilities for an installed licence that was not verified", () => {
    const report = editionReport({ verified: false, reason: "bad" }, ENTERPRISE_FEATURES, NOW, true);
    expect(report.license).toEqual({
      state: "invalid",
      subject: null,
      tier: null,
      expiresAt: null,
      graceEndsAt: null,
    });
    expect(report.capabilities).toEqual([]);
  });

  it("reports `active`, the licence's claims and all ten capabilities for a licence with no end", () => {
    const report = editionReport(verified(null), ENTERPRISE_FEATURES, NOW, true);
    expect(report.license).toEqual({
      state: "active",
      subject: "acme-corp",
      tier: "enterprise",
      expiresAt: null,
      graceEndsAt: null,
    });
    expect([...report.capabilities].sort()).toEqual(ALL_CAPABILITIES);
    expect(report.features).toEqual(FEATURES);
  });

  it("reports the end of a licence that has one, and its grace end, as ISO instants", () => {
    const report = editionReport(
      verified(NOW_SECONDS + 60 * 86_400, undefined, 30),
      ENTERPRISE_FEATURES,
      NOW,
      true,
    );
    expect(report.license.state).toBe("active");
    expect(report.license.expiresAt).toBe("2027-01-30T00:00:00.000Z");
    expect(report.license.graceEndsAt).toBe("2027-03-01T00:00:00.000Z");
  });

  it("reports `expiring` with every capability when 30 days or fewer are left", () => {
    const report = editionReport(verified(NOW_SECONDS + 86_400), ENTERPRISE_FEATURES, NOW, true);
    expect(report.license.state).toBe("expiring");
    expect([...report.capabilities].sort()).toEqual(ALL_CAPABILITIES);
  });

  it("reports `grace` with every capability after the end and inside the grace period", () => {
    const report = editionReport(
      verified(NOW_SECONDS - 86_400, undefined, 30),
      ENTERPRISE_FEATURES,
      NOW,
      true,
    );
    expect(report.license).toEqual({
      state: "grace",
      subject: "acme-corp",
      tier: "enterprise",
      expiresAt: "2026-11-30T00:00:00.000Z",
      graceEndsAt: "2026-12-30T00:00:00.000Z",
    });
    expect([...report.capabilities].sort()).toEqual(ALL_CAPABILITIES);
  });

  it("reports `expired` and no capabilities once a verified licence's end has passed", () => {
    const report = editionReport(verified(NOW_SECONDS - 1), ENTERPRISE_FEATURES, NOW, true);
    expect(report.license.state).toBe("expired");
    expect(report.license.expiresAt).toBe("2026-11-30T23:59:59.000Z");
    expect(report.capabilities).toEqual([]);
  });

  it("reports only the capabilities a narrowed licence names, and never a quota as one", () => {
    const narrowed: Entitlements = { ...NO_PLAN, teams: true, sso: true };
    const report = editionReport(verified(null, narrowed), ENTERPRISE_FEATURES, NOW, true);
    expect([...report.capabilities].sort()).toEqual(["sso", "teams"]);
  });

  it("does not report a switch whose claim is not the boolean true", () => {
    const odd: unknown = { teams: "yes", sso: 1, organizations: true };
    if (!isClaimObject(odd)) throw new Error("the fixture is not an object");
    const report = editionReport(verified(null, odd), ENTERPRISE_FEATURES, NOW, true);
    expect(report.capabilities).toEqual(["organizations"]);
  });

  it("is accepted whole by the edition protocol's validator in every state", () => {
    const states: InstanceLicense[] = [
      { verified: false, reason: "none" },
      verified(null),
      verified(NOW_SECONDS + 86_400),
      verified(NOW_SECONDS - 1),
      { verified: true },
    ];
    const rejected: number[] = [];
    states.forEach((state, index) => {
      for (const installed of [true, false]) {
        const report = editionReport(state, ENTERPRISE_FEATURES, NOW, installed);
        const parsed = parseEnterpriseEditionReport(JSON.parse(JSON.stringify(report)));
        if (parsed === null || JSON.stringify(parsed) !== JSON.stringify(report)) rejected.push(index);
      }
    });
    expect(rejected).toEqual([]);
  });

  it("names every registry entry once, and marks a module built only when it mounts something", () => {
    const report = editionReport({ verified: false }, ENTERPRISE_FEATURES, NOW, false);
    expect(report.features.map((feature) => feature.id)).toEqual(FEATURES.map((f) => f.id));
    const mismatched = ENTERPRISE_FEATURES.filter(
      (feature) =>
        feature.built !== (feature.authPlugins(stubCore()).length > 0 || feature.agentPolicy !== undefined),
    ).map((feature) => feature.id);
    expect(mismatched).toEqual([]);
  });
});

// better-auth asks the member's role for `team: ["create"]` before it runs the organization
// plugin's `beforeCreateTeam` hook, and core's roles name no `team` resource. The entitlement gate
// is what these cases are about, so the instance they run in gives its owner role that one
// resource on top of core's own statements; every other role is core's, unchanged.
const teamAc = createAccessControl({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
} as const);
const teamRoles = {
  ...orgRoles,
  owner: teamAc.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
  }),
};

/**
 * The CoreContext `register` receives: core's real slug rules and team gate, the billing read
 * this file controls, and every other runtime-bound member stubbed. `withTeamPermission` swaps
 * core's org roles for the ones above. OpenFGA is reported off, so `register` builds no FGA client
 * and never touches `db`.
 */
function stubCore(withTeamPermission = false): CoreContext {
  const stub = {
    db: {},
    orgAc: withTeamPermission ? teamAc : orgAc,
    orgRoles: withTeamPermission ? teamRoles : orgRoles,
    reservedOrgSlugRefusal,
    orgSlugShapeRefusal,
    ensureMemberGrant: vi.fn(async () => undefined),
    revokeMemberGrant: vi.fn(async () => undefined),
    sendInviteEmail: vi.fn(async () => undefined),
    canOrgInvite: vi.fn(async () => true),
    canOrgCreateTeams,
    syncOrgSeats: vi.fn(async () => undefined),
    emitAlertEvent: vi.fn(),
    recordActivity: vi.fn(),
    resolveOrgEntitlements: billing.resolveOrgEntitlements,
    newOrgSetup: {
      stampMetadata: vi.fn(async () => null),
      recordCreated: vi.fn(async () => undefined),
      keepStoredMarker: vi.fn(async () => null),
    },
    isOrgMember: vi.fn(async () => false),
    roleChangeOwnerRefusal: vi.fn(async () => null),
    removalOwnerRefusal: vi.fn(async () => null),
    isNonActiveMember: vi.fn(async () => false),
    inviterRefusal: vi.fn(async () => null),
    fga: { isEnabled: () => false },
  };
  // A test-only stub: `db` and most of `fga` are never reached with OpenFGA off (see above).
  return stub as unknown as CoreContext;
}

describe("register(core) — the report and the resolver of the registered module", () => {
  it("reports `none` and resolves from the billing record when no licence is installed", async () => {
    billing.resolveOrgEntitlements.mockResolvedValue(ENTERPRISE_PLAN);
    const mod = register(stubCore());
    const report = await mod.instanceEdition?.();
    expect(report?.license.state).toBe("none");
    expect(report?.capabilities).toEqual([]);
    expect(report?.features).toEqual(FEATURES);
    expect(await mod.resolveEntitlements?.("org_1")).toEqual(ENTERPRISE_PLAN);
    expect(billing.resolveOrgEntitlements).toHaveBeenCalledWith("org_1");
  });

  it("reports `active` with ten capabilities and resolves without a billing record under a signed licence", async () => {
    await installLicense({ expiresInDays: 365 });
    const mod = register(stubCore());
    const report = await mod.instanceEdition?.();
    expect(report?.license).toMatchObject({
      state: "active",
      subject: "acme-corp",
      tier: "enterprise",
    });
    expect(typeof report?.license.expiresAt).toBe("string");
    expect(typeof report?.license.graceEndsAt).toBe("string");
    expect([...(report?.capabilities ?? [])].sort()).toEqual(ALL_CAPABILITIES);
    const entitlements = await mod.resolveEntitlements?.("org_1");
    expect(entitlements).toMatchObject({ teams: true, sso: true });
    expect(billing.resolveOrgEntitlements).not.toHaveBeenCalled();
  });

  it("reports `invalid` and resolves from the billing record for a licence signed by another key", async () => {
    const other = generateLicenseKeypair();
    process.env.ALETHIA_LICENSE_KEY = await issueLicense({
      privateKeyB64: other.privateKeyB64,
      subject: "forged",
    });
    process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
    const mod = register(stubCore());
    const report = await mod.instanceEdition?.();
    expect(report?.license).toEqual({
      state: "invalid",
      subject: null,
      tier: null,
      expiresAt: null,
      graceEndsAt: null,
    });
    expect(report?.capabilities).toEqual([]);
    expect(await mod.resolveEntitlements?.("org_1")).toEqual(NO_PLAN);
  });

  it("keeps granting through grace and stops when grace ends, while the process is running", async () => {
    await installLicense({ expiresInDays: 1 });
    const mod = register(stubCore());
    expect((await mod.instanceEdition?.())?.license.state).toBe("expiring");
    expect(await mod.resolveEntitlements?.("org_1")).toMatchObject({ teams: true, sso: true });

    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    // Two days on: past the end, inside the default 30-day grace period.
    vi.setSystemTime(start + 2 * 86_400_000);
    expect((await mod.instanceEdition?.())?.license.state).toBe("grace");
    expect(await mod.resolveEntitlements?.("org_1")).toMatchObject({ teams: true, sso: true });
    expect(billing.resolveOrgEntitlements).not.toHaveBeenCalled();

    // Thirty-two days on: the end and the grace period have both passed.
    vi.setSystemTime(start + 32 * 86_400_000);
    const report = await mod.instanceEdition?.();
    expect(report?.license.state).toBe("expired");
    expect(report?.capabilities).toEqual([]);
    expect(await mod.resolveEntitlements?.("org_1")).toEqual(NO_PLAN);
    expect(billing.resolveOrgEntitlements).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The gates as production mounts them. The organization plugin and the single sign-on entitlement
// guard are the objects `register` returned. The single sign-on plugin itself is replaced by one
// endpoint at the path the guard matches, which answers 200: a 200 means the guard let the request
// through, a 403 means it refused, and nothing else about registration is under test here.

const SSO_REFUSAL = "Single Sign-On requires an Enterprise plan.";
const TEAMS_REFUSAL = "Teams require an Enterprise plan.";

/** The endpoint the single sign-on guard stands in front of, reduced to "the request arrived". */
const registerEndpointStub: BetterAuthPlugin = {
  id: "sso-register-stub",
  endpoints: {
    registerProvider: createAuthEndpoint("/sso/register", { method: "POST" }, async (ctx) =>
      ctx.json({ registered: true }),
    ),
  },
};

/** A better-auth carrying the plugins `register` returned, a signed-in owner and their organization. */
async function mount() {
  const mod = register(stubCore(true));
  const orgPlugin = mod.authPlugins?.find((p) => p.id === "organization");
  const guard = mod.authPlugins?.find((p) => p.id === "alethia-sso-entitlement-guard");
  if (!orgPlugin || !guard) throw new Error("register() returned no organization plugin or guard");
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
    // The casts are about TYPES only: `authPlugins` is typed through the console's better-auth,
    // while this instance is ee's own copy. The objects are the ones `register` built.
    plugins: [
      orgPlugin as unknown as BetterAuthPlugin,
      guard as unknown as BetterAuthPlugin,
      registerEndpointStub,
    ],
  });
  const res = await auth.api.signUpEmail({
    body: { email: "owner@example.com", password: "a-long-password-1", name: "Owner" },
    returnHeaders: true,
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  /** POSTs a JSON body to a better-auth endpoint as the signed-in owner, the way a client would. */
  const post = (path: string, body: unknown): Promise<Response> =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: baseURL },
        body: JSON.stringify(body),
      }),
    );
  const created = await post("/organization/create", { name: "Acme", slug: "acme" });
  if (created.status !== 200) throw new Error(`organization create answered ${created.status}`);
  const org: unknown = await created.json();
  const orgId =
    typeof org === "object" && org !== null && "id" in org && typeof org.id === "string"
      ? org.id
      : "";
  if (orgId === "") throw new Error("organization create returned no id");
  return { db, post, orgId };
}

/** What one request came to: its status and, for a refusal, its message. */
async function outcome(res: Response): Promise<{ status: number; message: string | null }> {
  const body: unknown = await res.json().catch(() => null);
  const message =
    typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
      ? body.message
      : null;
  return { status: res.status, message: res.status === 200 ? null : message };
}

/** Every way an instance can be without a licence that grants: its name, and how it is set up. */
const UNLICENSED: [string, () => Promise<void>][] = [
  ["no licence installed", async () => undefined],
  [
    "a licence signed by another key",
    async () => {
      const other = generateLicenseKeypair();
      process.env.ALETHIA_LICENSE_KEY = await issueLicense({
        privateKeyB64: other.privateKeyB64,
        subject: "forged",
      });
      process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
    },
  ],
  [
    "a licence that ended before the process started",
    async () => installLicense({ expiresInDays: 1, nowSeconds: 1_600_000_000 }),
  ],
  [
    "a licence with no key to verify it against",
    async () => {
      await installLicense();
      delete process.env.ALETHIA_LICENSE_PUBLIC_KEY;
    },
  ],
  [
    "a licence that is not a licence",
    async () => {
      process.env.ALETHIA_LICENSE_KEY = "not-a-licence";
      process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
    },
  ],
  [
    "the development switch in a production process",
    async () => {
      process.env.ALETHIA_LICENSE_ACTIVE = "true";
      vi.stubEnv("NODE_ENV", "production");
    },
  ],
];

describe("register(core) — creating a team and registering single sign-on, per edition", () => {
  it("hosted, organization on the enterprise plan: both are allowed", async () => {
    billing.resolveOrgEntitlements.mockResolvedValue(ENTERPRISE_PLAN);
    const { db, post, orgId } = await mount();

    const team = await outcome(await post("/organization/create-team", { name: "Platform", organizationId: orgId }));
    const sso = await outcome(await post("/sso/register", { organizationId: orgId }));

    expect(team).toEqual({ status: 200, message: null });
    expect(sso).toEqual({ status: 200, message: null });
    expect(db.team.map((row) => row.name)).toEqual(["Platform"]);
    expect(billing.resolveOrgEntitlements).toHaveBeenCalledWith(orgId);
  });

  it.each([
    ["with no plan", NO_PLAN],
    ["on a paid plan that carries neither", TEAM_PLAN],
  ])("hosted, organization %s: both are refused", async (_label, plan) => {
    billing.resolveOrgEntitlements.mockResolvedValue(plan);
    const { db, post, orgId } = await mount();

    const team = await outcome(await post("/organization/create-team", { name: "Platform", organizationId: orgId }));
    const sso = await outcome(await post("/sso/register", { organizationId: orgId }));

    expect(team).toEqual({ status: 403, message: TEAMS_REFUSAL });
    expect(sso).toEqual({ status: 403, message: SSO_REFUSAL });
    expect(db.team).toEqual([]);
  });

  it("self-managed, licensed, no billing record: both are allowed, and the billing record is not what allowed them", async () => {
    await installLicense({ expiresInDays: 30 });
    // No billing record exists on this instance: the billing read answers the all-off baseline.
    billing.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
    const { db, post, orgId } = await mount();

    const team = await outcome(await post("/organization/create-team", { name: "Platform", organizationId: orgId }));
    const sso = await outcome(await post("/sso/register", { organizationId: orgId }));

    expect(team).toEqual({ status: 200, message: null });
    expect(sso).toEqual({ status: 200, message: null });
    expect(db.team.map((row) => row.name)).toEqual(["Platform"]);
    expect(billing.resolveOrgEntitlements).not.toHaveBeenCalled();
  });

  it.each(UNLICENSED)("self-managed, unlicensed (%s), no billing record: both are refused", async (_label, install) => {
    await install();
    billing.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
    const { db, post, orgId } = await mount();

    const team = await outcome(await post("/organization/create-team", { name: "Platform", organizationId: orgId }));
    const sso = await outcome(await post("/sso/register", { organizationId: orgId }));

    expect(team).toEqual({ status: 403, message: TEAMS_REFUSAL });
    expect(sso).toEqual({ status: 403, message: SSO_REFUSAL });
    expect(db.team).toEqual([]);
  });

  it("a licence that names its entitlements allows what it names and refuses what it does not", async () => {
    await installLicense({ entitlements: { ...NO_PLAN, teams: true } });
    const { db, post, orgId } = await mount();

    const team = await outcome(await post("/organization/create-team", { name: "Platform", organizationId: orgId }));
    const sso = await outcome(await post("/sso/register", { organizationId: orgId }));

    expect(team).toEqual({ status: 200, message: null });
    expect(sso).toEqual({ status: 403, message: SSO_REFUSAL });
    expect(db.team.map((row) => row.name)).toEqual(["Platform"]);
  });

  it("refuses a registration that names no organization, on a licensed instance too", async () => {
    await installLicense();
    const { post } = await mount();
    expect(await outcome(await post("/sso/register", {}))).toEqual({ status: 403, message: SSO_REFUSAL });
    expect(await outcome(await post("/sso/register", { organizationId: 7 }))).toEqual({
      status: 403,
      message: SSO_REFUSAL,
    });
  });

  it("refuses both when the entitlements cannot be read", async () => {
    const { db, post, orgId } = await mount();
    billing.resolveOrgEntitlements.mockRejectedValue(new Error("billing read failed"));

    const team = await post("/organization/create-team", { name: "Platform", organizationId: orgId });
    const sso = await post("/sso/register", { organizationId: orgId });

    expect(team.status).not.toBe(200);
    expect(sso.status).not.toBe(200);
    expect(db.team).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AGT-L14 — the agent policy `register` returns, under each licence cell. The toggles are stored ON
// in every case; what changes is whether the organization holds `agentPolicy`. Unlicensed, a licence
// another key signed, and a licence whose entitlements claim does not name the switch must all be
// answered as core answers: no second person, any client, self-approval allowed.
describe("register(core) — the agent policy follows the licence", () => {
  const ON = { requireDifferentApprover: true, allowedOauthClientIds: ["claude-code"] };
  const SELF_APPROVAL =
    "This organization requires a different person to approve a request than the one it was made for.";

  /** The three answers the approval engine asks for, with the toggles on, for org_1. */
  async function answers(mod: ReturnType<typeof register>) {
    const policy = mod.agentPolicy;
    if (!policy) throw new Error("register returned no agent policy");
    return {
      secondPerson: await policy.sessionApplyNeedsSecondPerson("org_1", ON, "deploy", "production"),
      selfApproval: await policy.approverRefusal("org_1", ON, "user_1", "user_1"),
      otherClient: await policy.oauthClientRefusal("org_1", ON, "cursor"),
    };
  }

  it("applies every toggle under a signed licence, with no billing record", async () => {
    await installLicense({ expiresInDays: 365 });
    const got = await answers(register(stubCore()));
    expect(got.secondPerson).toBe(true);
    expect(got.selfApproval).toBe(SELF_APPROVAL);
    expect(got.otherClient).toContain('"cursor"');
    expect(billing.resolveOrgEntitlements).not.toHaveBeenCalled();
  });

  it("answers as core with no licence and no plan", async () => {
    expect(await answers(register(stubCore()))).toEqual({ secondPerson: false, selfApproval: null, otherClient: null });
  });

  it("answers as core for a licence signed by another key", async () => {
    const other = generateLicenseKeypair();
    process.env.ALETHIA_LICENSE_KEY = await issueLicense({ privateKeyB64: other.privateKeyB64, subject: "forged" });
    process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
    expect(await answers(register(stubCore()))).toEqual({ secondPerson: false, selfApproval: null, otherClient: null });
  });

  it("answers as core for a licence whose entitlements claim does not name agentPolicy", async () => {
    await installLicense({ expiresInDays: 365, entitlements: { ...NO_PLAN, teams: true, sso: true } });
    expect(await answers(register(stubCore()))).toEqual({ secondPerson: false, selfApproval: null, otherClient: null });
  });

  it("applies the toggles for an organization on the enterprise plan, unlicensed (hosted)", async () => {
    billing.resolveOrgEntitlements.mockResolvedValue(ENTERPRISE_PLAN);
    const got = await answers(register(stubCore()));
    expect(got.secondPerson).toBe(true);
    expect(got.selfApproval).toBe(SELF_APPROVAL);
  });

  it("answers as core for an organization on the team plan", async () => {
    billing.resolveOrgEntitlements.mockResolvedValue(TEAM_PLAN);
    expect(await answers(register(stubCore()))).toEqual({ secondPerson: false, selfApproval: null, otherClient: null });
  });
});
