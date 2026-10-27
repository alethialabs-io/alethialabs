// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE READ ROUTER'S TENANCY PROOF (#6113, ADR 0005 §10 Q4) — the body both edition files run.
//
// `rpc-tenancy.enterprise.test.ts` and `rpc-tenancy.community.test.ts` are two thin wrappers that
// pin `ALETHIA_EDITION` and install the three mocks below; everything they assert is HERE, so the
// two editions cannot drift apart. `vi.mock` has to live in the test file itself (it is hoisted per
// file), so the wrappers repeat three short mock factories — and `beforeAll` below checks that the
// wiring they installed is the wiring this body expects, so a wrapper that drifts goes red rather
// than proving something else.
//
// WHAT IS REAL. Postgres with RLS (the read runs as the app role), the PDP, `urlScopedOrgId`,
// `currentActor`, `getActiveScope`, the enterprise module (when the edition loads it), the oRPC
// client, handler and router. WHAT IS MOCKED, and only this:
//   · `next/headers` → `x-alethia-path` from `h.path`: the address the proxy publishes;
//   · `getOwnerScope` (the session lookup) → `{ userId: h.user, activeOrgId: h.sessionOrg }`: the
//     session is the INPUT under test, not the unit;
//   · `hasAcceptedCurrentDocuments` → true: the Terms gate has its own unit test (route.test.ts).
//
// WHAT IT PROVES, for EVERY procedure in `router` (enumerated from the router object — never a
// hand list), through BOTH entry points — the `/{org}/~/rpc` route handler, driven by a real
// `RPCLink` whose `fetch` is the handler, and the in-process server caller `serverOrpc()`:
//   1. ADDRESS BEATS SESSION. U (member of X and Y) with the session on X and the address on Y gets
//      exactly what U gets with the session on Y. In the enterprise edition that answer contains Y's
//      marker row and not X's.
//   2. A NON-MEMBER IS A 404. V (member of X only) addressing Y gets HTTP 404 from the handler and a
//      404 from the server caller — never Y's rows, and never X's.
//   3. WHAT IS AND IS NOT CLAIMED ABOUT THE SESSION. `getOwnerScope()` — the function that reads
//      `session.activeOrganizationId` (`readActiveOrgId`, `lib/auth/owner.ts`, NOT exported) — IS
//      called on these paths: `currentActor()` reads the whole owner scope before it asks the
//      address. So the session's org IS READ and then IGNORED wherever the address names an org
//      (`lib/authz/guard.ts`, `urlOrgId !== null` → `getActiveScope(userId, urlOrgId)`). That is
//      what invariant 1's equality measures; a stronger "never read" property does not hold and is
//      not asserted.
//
// THE SERVER-CALLER HALF MEASURES ITS OWN CONTEXT. The `query` base (`lib/rpc/base.ts`) binds
// `context.actor` around every procedure, so a reader's `authorize()` answers with the actor the
// entry point resolved. Before that binding, `serverOrpc()` computed `context.actor` and nothing
// read it — `jobs.page`'s reader re-resolved from the address — so a server caller whose context
// came from the SESSION (`getActiveScope(userId, activeOrgId)`) passed this suite (#6113 review,
// mutation 3). With the binding, that mutation is red.
//
// `serverOrpc()` IS CALLED AS SHIPPED. `react`'s `cache()` outside a server render is a pass-through
// (a fresh client per call), so no stand-in for `lib/rpc/server.ts` was needed.
//
// THE FIXTURE MAP IS THE EXTENSION POINT. A procedure in the router with no entry in `FIXTURES`
// fails the suite by name: lanes #6114–#6131 add procedures to the router, and each one must prove
// its tenancy here before it lands. An entry with no procedure behind it fails too.
//
// MARKER ROWS ARE AUTHORED BY W, NOT U. The `jobs` RLS policy has an owner arm (`user_id = owner`),
// so a row U authored would be visible on every one of U's pages and would mask the org arm this
// suite is about. W is a member of both orgs and never the caller.

import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ORPCError } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { headers } from "next/headers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/(private)/[org]/~/rpc/[[...rest]]/route";
import { getOwnerScope } from "@/lib/auth/owner";
import { ORG_PATH_HEADER } from "@/lib/authz/org-path";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import {
	alertChannels,
	alertDeliveries,
	alertRules,
	authzActivityLog,
	cloudIdentities,
	cloudRegions,
	grants,
	invoice,
	jobs,
	member,
	organization,
	organizationBilling,
	projectCluster,
	projectEnvironments,
	projectFabrics,
	projects,
	runners,
	role,
	supportCases,
	team,
	user,
} from "@/lib/db/schema";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { editionState } from "@/lib/enterprise";
import { errorDigest } from "@/lib/errors";
import { procedurePaths } from "@/lib/rpc/procedure-paths";
import { router } from "@/lib/rpc/router";
import { serverOrpc } from "@/lib/rpc/server";
import { describeIfDb, purgeAuthzActivityLog, seedJob } from "./db";

/** The request the mocks describe: the address, the signed-in user, and the session's org. */
export interface RpcTenancyRequest {
	path: string;
	user: string;
	sessionOrg: string | undefined;
}

/** The seeded world a fixture's markers are read against. */
export interface Seeded {
	orgX: string;
	orgY: string;
	jobX: string;
	jobY: string;
	/** One project per org, both under the SAME slug (`PROJECT_SLUG`) — slugs are unique per org. */
	projectX: string;
	projectY: string;
	/** One support case per org, opened by the CALLER U (see `caseX` in the seeding below). */
	caseX: string;
	caseY: string;
	/** One alert delivery in each org's ledger (#6118). */
	deliveryX: string;
	deliveryY: string;
	/** One alert policy and one alert channel per org, W-authored (#6125). */
	ruleX: string;
	ruleY: string;
	channelX: string;
	channelY: string;
	/** Each project's default environment (#6119's board reads name the environment they answer for). */
	envX: string;
	envY: string;
	/** One ORG-scoped cloud identity per org, W-authored, each with one inventory region (#6119). */
	identityX: string;
	identityY: string;
	/** A job on each org's project (the addressed `jobs.project` read). */
	projectJobX: string;
	projectJobY: string;
	/** One cluster under management in each org — on its project's default environment (#6122). */
	clusterX: string;
	clusterY: string;
	/** One self runner in each org, registered by W (#6123). */
	runnerX: string;
	runnerY: string;
	/** One ANALYZE_REPO job per org, with no digest yet (#6131's scan reads address a SCAN job). */
	scanJobX: string;
	scanJobY: string;
	/** People & access markers (#6129): one team and one custom role per org, and a grant to each team. */
	teamX: string;
	teamY: string;
	roleX: string;
	roleY: string;
}

/** One of the two seeded orgs. */
export type Org = "x" | "y";

/** The inventory region seeded on `org`'s cloud identity — unique per org, so it marks which one answered. */
function regionOf(org: Org): string {
	return `it-6119-region-${org}`;
}

/** The project slug seeded in BOTH orgs, so one fixture input can address either org's project. */
const PROJECT_SLUG = "it-6114-shared-slug";

/**
 * One procedure's tenancy fixture. Two kinds, because not every read is org-scoped, and a read that
 * is not cannot honestly report X/Y markers — a lane forced to write some would write ones that do
 * not inspect the output.
 *
 * - `org-scoped`: an input that reaches the reader, and how to find each org's marker row in its
 *   output. Enterprise must answer `{ x: false, y: true }` for an address on Y.
 * - `not-org-scoped` (the caller's own profile, the list of the caller's orgs, …): `reason` says
 *   why the answer does not depend on the org. Its assertion is that it does NOT: the output for an
 *   address on X deep-equals the output for an address on Y, in both editions. A non-member is
 *   STILL a 404 at Y — the handler refuses the address before any procedure runs, so a read's kind
 *   cannot change that, and asserting otherwise would assert a property the code does not have.
 * - `by-id` (#6119's board reads, each addressed by a project or an identity id; #6130's support
 *   case; #6121's job reads, addressed by a job or a project id): its input names a row, so there is
 *   no org-wide output to look for markers in. Its claim is about the row: at an address on Y, Y's
 *   row is revealed and X's is not (enterprise), neither is revealed (community), and the session
 *   never changes the outcome — a refusal included, by its code.
 */
export type Fixture =
	| {
			kind: "org-scoped";
			input: unknown;
			markers(out: unknown, seeded: Seeded): { x: boolean; y: boolean };
	  }
	| { kind: "not-org-scoped"; reason: string; input: unknown }
	| {
			kind: "by-id";
			/** The input that addresses `org`'s seeded row (a project, an environment, an identity, a job). */
			input(seeded: Seeded, org: Org): unknown;
			/** Whether the output IS that row's answer — a refusal or an empty answer reveals nothing. */
			reveals(out: unknown, seeded: Seeded, org: Org): boolean;
	  }
	| {
			kind: "gated";
			/** Why the caller's answer may be a REFUSAL rather than rows (a permission, a plan, an edition). */
			reason: string;
			input: unknown;
			/** When the read answers with data, how to find each org's marker in it (enterprise only). */
			markers?(out: unknown, seeded: Seeded): { x: boolean; y: boolean };
			/** The outcome at each address in the enterprise edition: "ok", or the refusal's code. */
			enterprise?: { x: string; y: string };
			/**
			 * Run this read with U holding `manage_billing` in X (owner there) — granted for THIS read's
			 * calls only and put back to viewer after, so no other fixture sees U as anything but a
			 * viewer (#6209 review).
			 */
			billingAdminInX?: true;
	  };

/** The seeded support case of `org` (opened by the caller U). */
const caseOf = (s: Seeded, org: Org) => (org === "x" ? s.caseX : s.caseY);

/** Whether a case read's output is the case with this id (`{ case: { id } }`). */
function isCase(out: unknown, id: string): boolean {
	if (typeof out !== "object" || out === null || !("case" in out)) return false;
	const row: unknown = out.case;
	return typeof row === "object" && row !== null && "id" in row && row.id === id;
}

/** Whether an output is the one job with this id (`{ id }`, a detail read). */
function isJob(out: unknown, id: string): boolean {
	return typeof out === "object" && out !== null && "id" in out && out.id === id;
}

/** Whether a list output (`[{ id }]`) carries a row with this id. */
function listHas(out: unknown, id: string): boolean {
	return (
		Array.isArray(out) &&
		out.some((row: unknown) => typeof row === "object" && row !== null && "id" in row && row.id === id)
	);
}

/** Whether a log-head output (`{ lines }`) answered at all — the seeded jobs have no lines. */
function isLogHead(out: unknown): boolean {
	return typeof out === "object" && out !== null && "lines" in out && Array.isArray(out.lines);
}

/** Whether a status-shaped output (`{ status }`) answered at all. */
function hasStatus(out: unknown): boolean {
	return typeof out === "object" && out !== null && "status" in out && typeof out.status === "string";
}

/** The seeded job of `org`. */
const jobOf = (s: Seeded, org: Org) => (org === "x" ? s.jobX : s.jobY);
/**
 * The `gated` kind (#6127). Some reads refuse THIS caller — U is a viewer, and the billing-admin
 * reads need `manage_billing`; the usage reads refuse the personal scope (community's answer for
 * every org address); the hosted-only reads refuse a deployment with no Stripe. A refusal is still
 * an answer the ADDRESS decides, so the claim is the same one the other kinds make, about the whole
 * outcome: the session never changes it — the value, or the refusal's code. Where the read does
 * answer with data, `markers` names whose data it is.
 */
function outcomeOf(outcome: Outcome): unknown {
	if (outcome.ok) return { ok: true, value: outcome.value };
	const code =
		outcome.error instanceof ORPCError
			? outcome.error.code
			: isNotFound(outcome.error)
				? "NOT_FOUND"
				: String(outcome.error);
	return { ok: false, code, status: outcome.status };
}


/** A project of X the usage project reads address (seeded in `beforeAll`, authored by W). */
const USAGE_PROJECT_X = randomUUID();

/**
 * Each org's seeded PAID period: distinct, both STARTED in the past and both still RUNNING — a paid
 * period that has ended lapses the plan's entitlements (lib/billing/plan.ts), which would switch
 * off #6118's alerting marker. The starts are what the usage reads must answer with.
 */
const X_PERIOD = { start: new Date("2020-01-15T00:00:00.000Z"), end: new Date("2099-01-15T00:00:00.000Z") };
const Y_PERIOD = { start: new Date("2020-06-07T00:00:00.000Z"), end: new Date("2099-06-07T00:00:00.000Z") };

/** A hosted-only read's outcome where U may make it: answered with Stripe wired, else plan-gated. */
function hostedOr(code: string): string {
	return process.env.STRIPE_SECRET_KEY ? "ok" : code;
}

/** "ok", or the refusal code an outcome carries (as {@link outcomeOf} reports it). */
function codeOf(outcome: Outcome): string {
	if (outcome.ok) return "ok";
	if (outcome.error instanceof ORPCError) return outcome.error.code;
	return isNotFound(outcome.error) ? "NOT_FOUND" : String(outcome.error);
}


/** Whether a page-shaped output (`{ rows: [{ id }] }`) carries a row with this id. */
function hasRow(out: unknown, id: string): boolean {
	if (typeof out !== "object" || out === null || !("rows" in out)) return false;
	const rows: unknown = out.rows;
	if (!Array.isArray(rows)) return false;
	return rows.some(
		(row: unknown) => typeof row === "object" && row !== null && "id" in row && row.id === id,
	);
}

/** Whether an array output carries an element whose `field` equals `value`. */
function hasElement(out: unknown, field: string, value: string): boolean {
	if (!Array.isArray(out)) return false;
	return out.some(
		(el: unknown) => typeof el === "object" && el !== null && field in el && Reflect.get(el, field) === value,
	);
}

/** A numeric field of an object output, or undefined. */
function numberField(out: unknown, field: string): number | undefined {
	if (typeof out !== "object" || out === null || !(field in out)) return undefined;
	const value: unknown = Reflect.get(out, field);
	return typeof value === "number" ? value : undefined;
}

/** Whether an object output's `field` array carries an item with this id. */
function hasItem(out: unknown, field: string, id: string): boolean {
	if (typeof out !== "object" || out === null || !(field in out)) return false;
	return hasElement(Reflect.get(out, field), "id", id);
}

/** Whether a clusters-list output carries the cluster whose row id is `id` (#6122). */
function hasCluster(out: unknown, id: string): boolean {
	if (!Array.isArray(out)) return false;
	return out.some((el: unknown) => {
		if (typeof el !== "object" || el === null || !("project_cluster" in el)) return false;
		const cluster: unknown = el.project_cluster;
		return typeof cluster === "object" && cluster !== null && "id" in cluster && cluster.id === id;
	});
}

/** A string field of an object output, or undefined. */
function stringField(out: unknown, field: string): string | undefined {
	if (typeof out !== "object" || out === null || !(field in out)) return undefined;
	const value: unknown = Reflect.get(out, field);
	return typeof value === "string" ? value : undefined;
}

/** Whether an evidence page (`{ groups: [{ rows: [{ environmentId }] }] }`) lists this environment. */
function listsEnvironment(out: unknown, environmentId: string): boolean {
	const groups = field(out, "groups");
	if (!Array.isArray(groups)) return false;
	return groups.some((g: unknown) => hasElement(field(g, "rows"), "environmentId", environmentId));
}

/** The seeded project of `org`. */
const projectOf = (s: Seeded, org: Org) => (org === "x" ? s.projectX : s.projectY);
/** The seeded default environment of `org`'s project. */
const envOf = (s: Seeded, org: Org) => (org === "x" ? s.envX : s.envY);
/** The seeded cloud identity of `org`. */
const identityOf = (s: Seeded, org: Org) => (org === "x" ? s.identityX : s.identityY);
/** The board's environment-scoped input for `org`'s project, on its default environment. */
const boardInput = (s: Seeded, org: Org) => ({ projectId: projectOf(s, org), environmentId: null });

/**
 * The display name the suite seeds on `org`'s project (`seedProject` in `beforeAll`). Unlike the slug
 * it differs per org, so a name-addressed read (#6131's `projects.nameAvailability`) can address
 * exactly one org's project.
 */
const projectNameOf = (s: Seeded, org: Org) => `it-6114-${(org === "x" ? s.orgX : s.orgY).slice(0, 8)}`;

/** A string field of an object output (`out.<field>`), or undefined. */
function field(out: unknown, name: string): unknown {
	return typeof out === "object" && out !== null && name in out ? Reflect.get(out, name) : undefined;
}

/**
 * EVERY procedure in `router`, keyed by its dotted path. A new read procedure must add its entry
 * here — an input that reaches its reader, and a marker test that names X's and Y's seeded rows —
 * or this suite fails naming it.
 */
export const FIXTURES: Record<string, Fixture> = {
	"jobs.page": {
		kind: "org-scoped",
		input: { range: { preset: "12mo" } },
		markers: (out, s) => ({ x: hasRow(out, s.jobX), y: hasRow(out, s.jobY) }),
	},
	// The app shell's reads (#6114).
	"workspace.context": {
		// The org list is the CALLER's (the same at X and Y); `activeOrgId` and the entitlements are
		// the addressed org's — so the marker is which org the context says the request is on.
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => ({
			x: stringField(out, "activeOrgId") === s.orgX,
			y: stringField(out, "activeOrgId") === s.orgY,
		}),
	},
	"workspace.projects": {
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => ({ x: hasElement(out, "id", s.projectX), y: hasElement(out, "id", s.projectY) }),
	},
	"workspace.jobs": {
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => ({ x: hasElement(out, "id", s.jobX), y: hasElement(out, "id", s.jobY) }),
	},
	"workspace.recentJobs": {
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => ({ x: hasElement(out, "id", s.jobX), y: hasElement(out, "id", s.jobY) }),
	},
	"workspace.supportCases": {
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => ({ x: hasElement(out, "id", s.caseX), y: hasElement(out, "id", s.caseY) }),
	},
	// The support pages' reads (#6130). The list is the caller's cases IN the addressed org; the case
	// read is addressed by id, and only the addressed org's case is revealed.
	"support.cases": {
		kind: "org-scoped",
		input: { bucket: "all" },
		markers: (out, s) => ({ x: hasElement(out, "id", s.caseX), y: hasElement(out, "id", s.caseY) }),
	},
	"support.case": {
		kind: "by-id",
		input: (s, org) => ({ id: caseOf(s, org) }),
		reveals: (out, s, org) => isCase(out, caseOf(s, org)),
	},
	"workspace.setupGuide": {
		// Its counts are the addressed org's: X has three members (U, V, W), Y has two (U, W).
		kind: "org-scoped",
		input: undefined,
		markers: (out) => ({ x: numberField(out, "memberCount") === 3, y: numberField(out, "memberCount") === 2 }),
	},
	"workspace.environments": {
		// The same slug names a project in each org; the answer must be the ADDRESSED org's project's.
		kind: "org-scoped",
		input: { project: PROJECT_SLUG },
		markers: (out, s) => ({
			x: hasElement(out, "project_id", s.projectX),
			y: hasElement(out, "project_id", s.projectY),
		}),
	},
	// #6118. The seat count IS the org's marker: X has three members (U, V, W), Y has two (U, W).
	// The personal scope (community) has none, so it answers 0 — neither marker.
	"overview.usage": {
		kind: "org-scoped",
		input: undefined,
		markers: (out) => ({ x: numberField(out, "memberCount") === 3, y: numberField(out, "memberCount") === 2 }),
	},
	"overview.alerts": {
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => ({ x: hasItem(out, "deliveries", s.deliveryX), y: hasItem(out, "deliveries", s.deliveryY) }),
	},
	// The Alerts hub's reads (#6125). Each list's PRISTINE page is the org's whole list, so the marker
	// is that org's seeded row; the settings read's condition options list the ADDRESSED org's projects.
	"alerts.settings": {
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => {
			const projects = field(field(out, "conditionOptions"), "projects");
			return { x: hasElement(projects, "value", s.projectX), y: hasElement(projects, "value", s.projectY) };
		},
	},
	"alerts.policies": {
		kind: "org-scoped",
		input: {},
		markers: (out, s) => ({ x: hasRow(out, s.ruleX), y: hasRow(out, s.ruleY) }),
	},
	"alerts.channels": {
		kind: "org-scoped",
		input: {},
		markers: (out, s) => ({ x: hasRow(out, s.channelX), y: hasRow(out, s.channelY) }),
	},
	"alerts.deliveries": {
		kind: "org-scoped",
		input: {},
		markers: (out, s) => ({ x: hasRow(out, s.deliveryX), y: hasRow(out, s.deliveryY) }),
	},
	// The Architecture board's reads (#6119). Each answers for ONE environment and names it, so the
	// reveal is "the answer names that org's environment" — an empty status or a refusal names none.
	"canvas.environmentStatus": {
		kind: "by-id",
		input: boardInput,
		reveals: (out, s, org) => field(field(out, "environment"), "id") === envOf(s, org),
	},
	"canvas.addons": {
		kind: "by-id",
		input: boardInput,
		reveals: (out, s, org) => field(out, "environmentId") === envOf(s, org),
	},
	"canvas.byoCharts": {
		kind: "by-id",
		input: boardInput,
		reveals: (out, s, org) => field(out, "environmentId") === envOf(s, org),
	},
	"canvas.chartWorkloads": {
		kind: "by-id",
		input: boardInput,
		reveals: (out, s, org) => field(out, "environmentId") === envOf(s, org),
	},
	"canvas.iacSource": {
		kind: "by-id",
		input: boardInput,
		reveals: (out, s, org) => field(out, "environmentId") === envOf(s, org),
	},
	"canvas.environmentJobs": {
		// The seeded environments have no jobs, so the reveal is that the read ANSWERED (a page) —
		// another org's environment is refused before any row is read.
		kind: "by-id",
		input: (s, org) => ({ projectId: projectOf(s, org), environmentId: envOf(s, org) }),
		reveals: (out) => Array.isArray(field(out, "jobs")),
	},
	"canvas.capabilities": {
		kind: "by-id",
		input: (s, org) => ({ identityId: identityOf(s, org), region: null }),
		reveals: (out, s, org) => field(out, "identityId") === identityOf(s, org),
	},
	// The Evidence page's read (#6126): every environment of the ADDRESSED org's projects.
	"evidence.page": {
		kind: "org-scoped",
		input: {},
		markers: (out, s) => ({ x: listsEnvironment(out, s.envX), y: listsEnvironment(out, s.envY) }),
	},
	"canvas.cloudInventory": {
		kind: "by-id",
		input: (s, org) => ({ identityId: identityOf(s, org) }),
		reveals: (out, _s, org) => {
			const regions = field(out, "regions");
			return Array.isArray(regions) && regions.includes(regionOf(org));
		},
	},
	// The Environments page's reads (#6120). `overview` addresses the project by its SLUG — the same
	// slug names a project in each org — so the answer must be the ADDRESSED org's project; in the
	// personal scope (community's answer for every org address) the slug names no project at all.
	// The two dialog reads are addressed by ids: another org's project is a NOT_FOUND, never its rows.
	"environments.overview": {
		kind: "gated",
		reason: "addresses a project by slug: the addressed org's project, NOT_FOUND in the personal scope",
		input: { project: PROJECT_SLUG },
		enterprise: { x: "ok", y: "ok" },
		markers: (out, s) => ({
			x: field(out, "projectId") === s.projectX,
			y: field(out, "projectId") === s.projectY,
		}),
	},
	"environments.protectionRules": {
		kind: "by-id",
		input: (s, org) => ({ projectId: projectOf(s, org), environmentId: envOf(s, org) }),
		reveals: (out, s, org) => field(out, "environmentId") === envOf(s, org),
	},
	"environments.promotionPreview": {
		kind: "by-id",
		input: (s, org) => ({
			projectId: projectOf(s, org),
			sourceId: envOf(s, org),
			targetId: envOf(s, org),
			includeRemovals: false,
		}),
		reveals: (out, s, org) => field(out, "sourceId") === envOf(s, org),
	},
	"jobs.detail": {
		kind: "by-id",
		input: (s, org) => ({ id: jobOf(s, org) }),
		reveals: (out, s, org) => isJob(out, jobOf(s, org)),
	},
	"jobs.status": {
		kind: "by-id",
		input: (s, org) => ({ id: jobOf(s, org) }),
		reveals: (out) => hasStatus(out),
	},
	"jobs.planResult": {
		kind: "by-id",
		input: (s, org) => ({ id: jobOf(s, org) }),
		reveals: (out) => hasStatus(out),
	},
	"jobs.logsHead": {
		kind: "by-id",
		input: (s, org) => ({ id: jobOf(s, org) }),
		reveals: (out) => isLogHead(out),
	},
	"jobs.project": {
		kind: "by-id",
		input: (s, org) => ({ projectId: org === "x" ? s.projectX : s.projectY }),
		reveals: (out, s, org) => listHas(out, org === "x" ? s.projectJobX : s.projectJobY),
	},
	// ── #6131: the create flow and the duplicate dialog. ─────────────────────────────────────────
	"projects.linkedGitProviders": {
		// The git accounts linked to the CALLER's login (Better Auth's account rows): a property of
		// the person, so the same at every org address. With no session cookie here the reader sees
		// no signed-in person and answers [] at both — the claim is only that the address does not
		// change it.
		kind: "not-org-scoped",
		reason: "the caller's own linked git accounts, which belong to the person, not to an org",
		input: undefined,
	},
	// The scan reads are addressed by a SCAN job's id (an ANALYZE_REPO job; any other kind answers
	// NOT_FOUND) and read it under RLS and the jobs visibility rule. The seeded scans carry no repo
	// digest, so the addressed org's answers PENDING (and never reaches the model inference) and the
	// other org's answers NOT_FOUND — the reveal is "this scan was found".
	"projects.scanStatus": {
		kind: "by-id",
		input: (s, org) => ({ jobId: org === "x" ? s.scanJobX : s.scanJobY }),
		reveals: (out) => field(out, "status") === "PENDING",
	},
	"projects.scanProposal": {
		kind: "by-id",
		input: (s, org) => ({ jobId: org === "x" ? s.scanJobX : s.scanJobY }),
		reveals: (out) => field(out, "status") === "PENDING",
	},
	// Addressed by a NAME: each org's project carries a distinct one, so "taken" reveals that the
	// addressed org holds a project of that name — and only the addressed org's name may read taken.
	"projects.nameAvailability": {
		kind: "by-id",
		input: (s, org) => ({ name: projectNameOf(s, org) }),
		reveals: (out) => field(out, "available") === false,
	},
	"projects.duplicateTargets": {
		kind: "by-id",
		input: (s, org) => ({ projectId: projectOf(s, org) }),
		reveals: (out, s, org) => field(out, "projectName") === projectNameOf(s, org),
	},
	// ── #6127: billing and usage. The seeded world (see `beforeAll`):
	//   · both orgs are on Team (#6118's seed); X has AI cap 1111 credits and a paid period from
	//     2020-01-15, Y cap 2222 and one from 2020-06-07 — DISTINCT starts, both still running, so a
	//     period read from the wrong org (or from the clock) shows in the output;
	//   · for the billing-admin reads ONLY, U holds `manage_billing` in X (owner there, for those
	//     calls; viewer in Y), so they ANSWER at X and refuse at Y — not refused in every cell;
	//   · one invoice per org (IT-6127-X / IT-6127-Y); X has two projects (#6114's and #6127's), Y one.
	// `enterprise` pins each gated read's outcome per address in the enterprise edition (the
	// multi-tenant one), so a gated fixture cannot pass by refusing everywhere. The hosted-only reads
	// answer ENTITLEMENT_REQUIRED where Stripe is not configured (CI) — past the permission check,
	// which is the point — and FORBIDDEN at Y. ─────────────────────────────────────────────────────
	"billing.summary": {
		kind: "org-scoped",
		input: undefined,
		markers: (out) => ({ x: field(out, "memberCount") === 3, y: field(out, "memberCount") === 2 }),
	},
	"billing.paymentMethods": {
		kind: "gated",
		billingAdminInX: true,
		reason: "manage_billing (U holds it in X only), and hosted billing",
		input: undefined,
		enterprise: { x: hostedOr("ENTITLEMENT_REQUIRED"), y: "FORBIDDEN" },
	},
	"billing.invoices": {
		kind: "gated",
		billingAdminInX: true,
		reason: "manage_billing (U holds it in X only)",
		input: {},
		enterprise: { x: "ok", y: "FORBIDDEN" },
		markers: (out) => ({
			x: hasElement(out, "number", "IT-6127-X"),
			y: hasElement(out, "number", "IT-6127-Y"),
		}),
	},
	"billing.transactions": {
		kind: "gated",
		billingAdminInX: true,
		reason: "manage_billing (U holds it in X only), and hosted billing",
		input: undefined,
		enterprise: { x: hostedOr("ENTITLEMENT_REQUIRED"), y: "FORBIDDEN" },
	},
	"billing.planHistory": {
		kind: "gated",
		billingAdminInX: true,
		reason: "manage_billing (U holds it in X only), and hosted billing",
		input: undefined,
		enterprise: { x: hostedOr("ENTITLEMENT_REQUIRED"), y: "FORBIDDEN" },
	},
	"billing.liveAiPrices": {
		kind: "not-org-scoped",
		reason: "the AI tiers' price list is the same for every org",
		input: undefined,
	},
	"usage.org": {
		kind: "org-scoped",
		input: undefined,
		markers: (out) => ({
			x: field(out, "periodStart") === X_PERIOD.start.toISOString(),
			y: field(out, "periodStart") === Y_PERIOD.start.toISOString(),
		}),
	},
	"usage.resources": {
		kind: "gated",
		reason: "refuses the personal scope, which is community's answer for every org address",
		input: undefined,
		enterprise: { x: "ok", y: "ok" },
		markers: (out) => ({ x: field(out, "projects") === 2, y: field(out, "projects") === 1 }),
	},
	"usage.overTime": {
		kind: "gated",
		reason: "refuses the personal scope, which is community's answer for every org address",
		input: { range: { preset: "12mo" } },
		enterprise: { x: "ok", y: "ok" },
	},
	"usage.ai": {
		kind: "org-scoped",
		input: undefined,
		markers: (out) => ({
			x: field(out, "orgWeeklyCapCredits") === 1111,
			y: field(out, "orgWeeklyCapCredits") === 2222,
		}),
	},
	"usage.project": {
		kind: "gated",
		reason: "addresses X's project: answered at X, NOT_FOUND at Y and in the personal scope",
		input: { projectId: USAGE_PROJECT_X },
		enterprise: { x: "ok", y: "NOT_FOUND" },
		// Answered at X with X's PAID period — the project meter's window is its org's.
		markers: (out) => ({ x: field(out, "periodStart") === X_PERIOD.start.toISOString(), y: false }),
	},
	"usage.projectResources": {
		kind: "gated",
		reason: "addresses X's project: answered at X, NOT_FOUND at Y and in the personal scope",
		input: { projectId: USAGE_PROJECT_X },
		enterprise: { x: "ok", y: "NOT_FOUND" },
	},
	"usage.projectAi": {
		kind: "gated",
		reason: "addresses X's project: answered at X, NOT_FOUND at Y and in the personal scope",
		input: { projectId: USAGE_PROJECT_X },
		enterprise: { x: "ok", y: "NOT_FOUND" },
		markers: (out) => ({ x: field(out, "periodStart") === X_PERIOD.start.toISOString(), y: false }),
	},
	"usage.projectOverTime": {
		kind: "gated",
		reason: "addresses X's project: answered at X, NOT_FOUND at Y and in the personal scope",
		input: { projectId: USAGE_PROJECT_X, range: { preset: "12mo" } },
		enterprise: { x: "ok", y: "NOT_FOUND" },
	},
	// #6122. Each org's cluster is under management (its environment has deployed), so a list that
	// served the wrong org — or both — names the other org's cluster by its row id.
	"clusters.list": {
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => ({ x: hasCluster(out, s.clusterX), y: hasCluster(out, s.clusterY) }),
	},
	// General settings (#6128).
	"settings.org": {
		// The org's own row: its slug is the marker (seeded as `it-6113-<first 8 of its id>`). The
		// personal scope — community's answer for every org address — is `{ scope: "personal" }`.
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => {
			const settings: unknown =
				typeof out === "object" && out !== null && "settings" in out ? out.settings : undefined;
			const slug = stringField(settings, "slug");
			return { x: slug === `it-6113-${s.orgX.slice(0, 8)}`, y: slug === `it-6113-${s.orgY.slice(0, 8)}` };
		},
	},
	"settings.preview": {
		// Same slug in each org; the answer names the ADDRESSED org's project. `null` in community.
		kind: "org-scoped",
		input: { project: PROJECT_SLUG },
		markers: (out, s) => ({
			x: stringField(out, "projectId") === s.projectX,
			y: stringField(out, "projectId") === s.projectY,
		}),
	},
	"settings.project": {
		// The same slug names a project in each org; the answer must be the ADDRESSED org's project.
		// `null` (no such project here) is community's answer: the personal scope holds neither.
		kind: "org-scoped",
		input: { project: PROJECT_SLUG },
		markers: (out, s) => ({
			x: stringField(out, "id") === s.projectX,
			y: stringField(out, "id") === s.projectY,
		}),
	},
	// #6123. Runner reads take no runner id — each is the actor's whole visible set — so the markers
	// are each org's seeded runner in that set: another org's runner is not there to be asked for.
	"runners.list": {
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => ({ x: hasItem(out, "runners", s.runnerX), y: hasItem(out, "runners", s.runnerY) }),
	},
	"runners.page": {
		kind: "org-scoped",
		input: {},
		markers: (out, s) => ({ x: hasRow(out, s.runnerX), y: hasRow(out, s.runnerY) }),
	},
	"runners.fleet": {
		kind: "not-org-scoped",
		reason: "warm pools are platform rows with no org (self-managed only); the answer is the deployment's fleet",
		input: undefined,
	},
	"runners.fleetEconomics": {
		// The pools' month-to-date cost: pools and their usage sessions are platform rows with no org,
		// so a manager on any org of a self-managed deployment reads the same figures, and everyone else
		// (and every caller on hosted) reads null. With the clock frozen, both answers are deterministic.
		kind: "not-org-scoped",
		reason: "warm-pool economics are computed over platform rows with no org; the answer is the deployment's, or null for a non-manager",
		input: undefined,
	},
	"runners.releaseNotes": {
		kind: "not-org-scoped",
		reason: "runner releases are global; every org reads the same changelog",
		input: { version: "0.0.0-it-6123-none" },
	},
	// The people & access reads (#6129). Members, teams and the invite context answer any member;
	// roles and grants answer `member:view`, which the caller U (a viewer) holds. X has three members
	// (U, V, W), Y two (U, W); the community personal scope has the caller alone.
	"members.page": {
		kind: "org-scoped",
		input: {},
		markers: (out) => {
			const members = field(out, "members");
			const n = Array.isArray(members) ? members.length : -1;
			return { x: n === 3, y: n === 2 };
		},
	},
	"members.list": {
		kind: "org-scoped",
		input: undefined,
		markers: (out) => ({ x: Array.isArray(out) && out.length === 3, y: Array.isArray(out) && out.length === 2 }),
	},
	"members.gate": {
		// Both seeded orgs are on the same live Team plan (#6118), so the gate's answer is the SAME at
		// X and Y by construction; what is asserted is that the address — never the session — decides
		// it, and that a non-member of Y is refused. It is not a claim that the gate ignores the org.
		kind: "not-org-scoped",
		reason: "both seeded orgs are on the same live plan, so their gates are identical",
		input: undefined,
	},
	"members.inviteContext": {
		kind: "org-scoped",
		input: undefined,
		markers: (out) => {
			const emails = field(out, "existingEmails");
			const n = Array.isArray(emails) ? emails.length : -1;
			return { x: n === 3, y: n === 2 };
		},
	},
	"members.teams": {
		kind: "org-scoped",
		input: {},
		markers: (out, s) => ({ x: hasRow(out, s.teamX), y: hasRow(out, s.teamY) }),
	},
	"members.roles": {
		kind: "org-scoped",
		input: {},
		markers: (out, s) => ({ x: hasElement(out, "id", s.roleX), y: hasElement(out, "id", s.roleY) }),
	},
	"members.roleCatalog": {
		// The built-in viewer's distinct-user grant count IS the org's marker: U and V in X, U in Y.
		kind: "org-scoped",
		input: undefined,
		markers: (out) => {
			const builtin = field(out, "builtin");
			const viewer = Array.isArray(builtin) ? builtin.find((r: unknown) => field(r, "name") === "viewer") : undefined;
			const n = numberField(viewer, "grantCount");
			return { x: n === 2, y: n === 1 };
		},
	},
	"members.grants": {
		kind: "org-scoped",
		input: {},
		markers: (out, s) => {
			const rows = field(out, "rows");
			const names = (id: string) => Array.isArray(rows) && rows.some((r: unknown) => field(r, "principalId") === id);
			return { x: names(s.teamX), y: names(s.teamY) };
		},
	},
	"members.grantOptions": {
		kind: "org-scoped",
		input: undefined,
		markers: (out, s) => ({ x: hasItem(out, "principals", s.teamX), y: hasItem(out, "principals", s.teamY) }),
	},
};

/** The input a fixture sends when it addresses `org` (an org-wide read sends the same either way). */
function inputFor(fixture: Fixture | undefined, seeded: Seeded, org: Org): unknown {
	if (!fixture) return undefined;
	return fixture.kind === "by-id" ? fixture.input(seeded, org) : fixture.input;
}

/** An outcome reduced to what a caller can tell apart: the value, or the refusal's code. */
function summary(outcome: Outcome): unknown {
	if (outcome.ok) return { ok: true, value: outcome.value };
	const code =
		outcome.error instanceof ORPCError ? outcome.error.code : isNotFound(outcome.error) ? "NOT_FOUND" : String(outcome.error);
	return { ok: false, code };
}

/** Walks a proxy-shaped client (oRPC's) down a dotted path, without a cast. */
function walk(root: unknown, path: string): unknown {
	let node = root;
	for (const segment of path.split(".")) {
		if ((typeof node !== "object" && typeof node !== "function") || node === null) return undefined;
		node = Reflect.get(node, segment);
	}
	return node;
}

/** Calls a function reached by `walk`, failing loudly if the path did not lead to one. */
async function invoke(fn: unknown, input: unknown, label: string): Promise<unknown> {
	if (typeof fn !== "function") throw new Error(`${label} is not callable`);
	return fn(input);
}

/** The outcome of one call: what it returned, or what it threw, plus the HTTP status if it crossed one. */
type Outcome = { ok: true; value: unknown; status?: number } | { ok: false; error: unknown; status?: number };

/** Settles a call into an {@link Outcome}. */
async function settle(call: () => Promise<unknown>, status: () => number | undefined): Promise<Outcome> {
	try {
		const value = await call();
		return { ok: true, value, status: status() };
	} catch (error) {
		return { ok: false, error, status: status() };
	}
}

/** Whether a thrown value is the server caller's not-found: Next's 404 signal, or oRPC's NOT_FOUND. */
function isNotFound(error: unknown): boolean {
	if ((errorDigest(error) ?? "").startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return true;
	return error instanceof ORPCError && error.code === "NOT_FOUND";
}

/**
 * Registers the tenancy suite for one edition. `h` is the hoisted request state the calling file's
 * mocks read; `edition` decides what U's answer for an address on Y must contain.
 */
export async function runRpcTenancySuite(opts: {
	edition: "enterprise" | "community";
	h: RpcTenancyRequest;
}): Promise<void> {
	const { edition, h } = opts;
	const ORG_X = randomUUID();
	const ORG_Y = randomUUID();
	const SLUG_X = `it-6113-${ORG_X.slice(0, 8)}`;
	const SLUG_Y = `it-6113-${ORG_Y.slice(0, 8)}`;
	const U = randomUUID(); // member of X and Y — the caller
	const V = randomUUID(); // member of X only — the non-member of Y
	const W = randomUUID(); // member of X and Y — authors the marker rows, never calls
	const USERS = [U, V, W];
	const seeded: Seeded = {
		orgX: ORG_X,
		orgY: ORG_Y,
		jobX: "",
		jobY: "",
		projectX: "",
		projectY: "",
		caseX: "",
		caseY: "",
		deliveryX: "",
		deliveryY: "",
		ruleX: "",
		ruleY: "",
		channelX: "",
		channelY: "",
		envX: "",
		envY: "",
		identityX: "",
		identityY: "",
		projectJobX: "",
		projectJobY: "",
		scanJobX: "",
		scanJobY: "",
		clusterX: "",
		clusterY: "",
		runnerX: "",
		runnerY: "",
		teamX: "",
		teamY: "",
		roleX: "",
		roleY: "",
	};

	/** One call through the ROUTE HANDLER, as the browser makes it, under the given request. */
	async function viaRoute(path: string, req: RpcTenancyRequest, input: unknown): Promise<Outcome> {
		let status: number | undefined;
		const client = createORPCClient(
			new RPCLink({
				url: `http://console.test/${req.path.split("/")[1]}/~/rpc`,
				method: () => "GET",
				fetch: async (request) => {
					h.path = new URL(request.url).pathname;
					h.user = req.user;
					h.sessionOrg = req.sessionOrg;
					const res = request.method === "GET" ? await GET(request) : await POST(request);
					status = res.status;
					return res;
				},
			}),
		);
		return settle(() => invoke(walk(client, path), input, `route client ${path}`), () => status);
	}

	/** One call through the IN-PROCESS SERVER CALLER (`serverOrpc()`), under the given request. */
	async function viaServer(path: string, req: RpcTenancyRequest, input: unknown): Promise<Outcome> {
		h.path = req.path;
		h.user = req.user;
		h.sessionOrg = req.sessionOrg;
		return settle(
			() => invoke(walk(serverOrpc(), `${path}.call`), input, `serverOrpc() ${path}.call`),
			() => undefined,
		);
	}

	const ENTRY_POINTS = [
		["the route handler", viaRoute],
		["the server caller", viaServer],
	] as const;

	/** The address of procedure `path` under org `slug` (what a page under `/{slug}/~/jobs` publishes). */
	const rpcPath = (slug: string, path: string) => `/${slug}/~/rpc/${path.replaceAll(".", "/")}`;

	// Enumerated ONCE, before any test is declared: `it.each` needs the list at collection time, and
	// the walker resolves lazy routers asynchronously (it throws rather than skip one).
	const PATHS = await procedurePaths(router);

	describeIfDb(`#6113 the read router's tenancy — ${edition} edition`, () => {
		beforeAll(async () => {
			// The edition is the premise of every assertion below. Enterprise REQUIRES ee/dist: a
			// module that failed to register must fail this suite, never skip it into community.
			const state = editionState();
			if (edition === "enterprise") {
				expect(
					state,
					"ee/dist/index.js must be built (`pnpm -F @alethia/ee build`) — the enterprise edition did not register",
				).toEqual({ kind: "enterprise" });
			} else {
				expect(state).toEqual({ kind: "community", reason: "configured" });
			}

			// The wrapper's mocks are the ones this body expects (see the header).
			h.path = "/probe/~/rpc";
			h.user = "probe-user";
			h.sessionOrg = "probe-org";
			expect((await headers()).get(ORG_PATH_HEADER)).toBe("/probe/~/rpc");
			expect(await getOwnerScope()).toEqual({ userId: "probe-user", sessionId: "s", activeOrgId: "probe-org" });

			const db = getServiceDb();
			await seedAuthz();
			await db.insert(user).values(USERS.map((id) => ({ id, email: `it-6113-${id}@example.test` })));
			await db.insert(organization).values([
				{ id: ORG_X, name: SLUG_X, slug: SLUG_X },
				{ id: ORG_Y, name: SLUG_Y, slug: SLUG_Y },
			]);
			await db.insert(member).values([
				{ organizationId: ORG_X, userId: U, role: "viewer" },
				{ organizationId: ORG_Y, userId: U, role: "viewer" },
				{ organizationId: ORG_X, userId: V, role: "viewer" },
				{ organizationId: ORG_X, userId: W, role: "admin" },
				{ organizationId: ORG_Y, userId: W, role: "admin" },
			]);
			// What signup writes for every user (`lib/auth/index.ts`): owner of their own personal scope.
			// Community serves every org address from that scope, so without it the PDP refuses there.
			for (const id of USERS) await ensureMemberGrant(id, id, "owner");
			await ensureMemberGrant(ORG_X, U, "viewer");
			await ensureMemberGrant(ORG_Y, U, "viewer");
			await ensureMemberGrant(ORG_X, V, "viewer");
			await ensureMemberGrant(ORG_X, W, "admin");
			await ensureMemberGrant(ORG_Y, W, "admin");

			seeded.jobX = await seedJob(W, ORG_X);
			seeded.jobY = await seedJob(W, ORG_Y);

			// #6118: both orgs on a live Team plan, so `overview.alerts` (which answers no rows to a
			// plan without alerting) has rows to mark, and one delivery in each org's ledger.
			await db.insert(organizationBilling).values([
				{ organizationId: ORG_X, plan: "team", status: "active" },
				{ organizationId: ORG_Y, plan: "team", status: "active" },
			]);
			const deliveries = await db
				.insert(alertDeliveries)
				.values([
					{ org_id: ORG_X, event_key: "job.failed", context: { title: "it-6118 X" }, status: "sent" },
					{ org_id: ORG_Y, event_key: "job.failed", context: { title: "it-6118 Y" }, status: "sent" },
				])
				.returning({ id: alertDeliveries.id, org: alertDeliveries.org_id });
			seeded.deliveryX = deliveries.find((d) => d.org === ORG_X)?.id ?? "";
			seeded.deliveryY = deliveries.find((d) => d.org === ORG_Y)?.id ?? "";
			expect(seeded.deliveryX && seeded.deliveryY).toBeTruthy();

			// #6125: one policy and one channel per org (W authors), the Alerts hub's list markers.
			const seedAlerting = async (orgId: string): Promise<{ rule: string; channel: string }> => {
				const [rule] = await db
					.insert(alertRules)
					.values({ org_id: orgId, name: `it-6125 ${orgId.slice(0, 8)}`, event_patterns: ["system.job.failed"], created_by: W })
					.returning({ id: alertRules.id });
				const [channel] = await db
					.insert(alertChannels)
					.values({ org_id: orgId, type: "email", name: `it-6125 ${orgId.slice(0, 8)}`, created_by: W })
					.returning({ id: alertChannels.id });
				return { rule: rule.id, channel: channel.id };
			};
			({ rule: seeded.ruleX, channel: seeded.channelX } = await seedAlerting(ORG_X));
			({ rule: seeded.ruleY, channel: seeded.channelY } = await seedAlerting(ORG_Y));

			// #6123: one self runner per org, registered by W — U reaches each only through the org arm.
			const seededRunners = await db
				.insert(runners)
				.values([
					{ user_id: W, org_id: ORG_X, name: `it-6123-x-${ORG_X.slice(0, 6)}`, operator: "self", provisioning: "registered", token_hash: `it-6123-${randomUUID()}` },
					{ user_id: W, org_id: ORG_Y, name: `it-6123-y-${ORG_Y.slice(0, 6)}`, operator: "self", provisioning: "registered", token_hash: `it-6123-${randomUUID()}` },
				])
				.returning({ id: runners.id, org: runners.org_id });
			seeded.runnerX = seededRunners.find((r) => r.org === ORG_X)?.id ?? "";
			seeded.runnerY = seededRunners.find((r) => r.org === ORG_Y)?.id ?? "";
			expect(seeded.runnerX && seeded.runnerY).toBeTruthy();

			// One project per org under the same slug, each with its default environment (W authors).
			const seedProject = async (orgId: string): Promise<{ project: string; env: string; cluster: string }> => {
				const [p] = await db
					.insert(projects)
					.values({
						user_id: W,
						org_id: orgId,
						project_name: `it-6114-${orgId.slice(0, 8)}`,
						slug: PROJECT_SLUG,
						region: "eu-west-1",
						iac_version: "1.0.0",
					})
					.returning({ id: projects.id });
				// Placed on a Fabric, as every environment the app creates is (the BYO-IaC read resolves it).
				const [f] = await db
					.insert(projectFabrics)
					.values({ project_id: p.id, user_id: W, org_id: orgId, name: "prod", status: "DRAFT" })
					.returning({ id: projectFabrics.id });
				const [e] = await db
					.insert(projectEnvironments)
					.values({
						project_id: p.id,
						user_id: W,
						name: "prod",
						status: "DRAFT",
						is_default: true,
						fabric_id: f.id,
					})
					.returning({ id: projectEnvironments.id });
				// #6122: a cluster under management — its environment has a live deployment (the stamp a
				// DEPLOY success writes), while a plan holds it in DRAFT.
				await db
					.update(projectEnvironments)
					.set({ last_deployed_at: new Date("2026-01-01T00:00:00Z") })
					.where(eq(projectEnvironments.id, e.id));
				const [c] = await db
					.insert(projectCluster)
					.values({ project_id: p.id, environment_id: e.id, status: "ACTIVE", cluster_name: `it-6122-${orgId.slice(0, 8)}` })
					.returning({ id: projectCluster.id });
				return { project: p.id, env: e.id, cluster: c.id };
			};
			({ project: seeded.projectX, env: seeded.envX, cluster: seeded.clusterX } = await seedProject(ORG_X));
			({ project: seeded.projectY, env: seeded.envY, cluster: seeded.clusterY } = await seedProject(ORG_Y));

			// One ORG-scoped cloud identity per org (W authors; visible to the org, #6119), each with one
			// inventory region whose name marks which org's identity answered.
			const seedIdentity = async (orgId: string, org: Org): Promise<string> => {
				const [ci] = await db
					.insert(cloudIdentities)
					.values({ user_id: W, org_id: orgId, scope: "org", provider: "aws", name: `it-6119-${org}` })
					.returning({ id: cloudIdentities.id });
				await db.insert(cloudRegions).values({ cloud_identity_id: ci.id, provider: "aws", native_id: regionOf(org) });
				return ci.id;
			};
			seeded.identityX = await seedIdentity(ORG_X, "x");
			seeded.identityY = await seedIdentity(ORG_Y, "y");

			// Support cases are the one marker U authors. A viewer sees only cases they opened (the
			// requester arm) — so a W-authored case would be invisible to U at BOTH addresses and prove
			// nothing. The policy is org-scoped FIRST (`org_id = current_org AND (…)`,
			// programmables.sql), so U's case in X must still not appear at Y: that is the org arm.
			const seedCase = async (orgId: string): Promise<string> => {
				const row: typeof supportCases.$inferInsert = {
					user_id: U,
					org_id: orgId,
					type: "technical",
					category: "other",
					severity: "normal",
					status: "open",
					subject: `it-6114 ${orgId.slice(0, 8)}`,
					context: {},
					contact: { notifyEmail: "it-6114@example.test", channel: "email" },
					last_author_type: "customer",
				};
				const [c] = await db.insert(supportCases).values(row).returning({ id: supportCases.id });
				return c.id;
			};
			seeded.caseX = await seedCase(ORG_X);
			seeded.caseY = await seedCase(ORG_Y);

			// A job on each org's project: the addressed `jobs.project` read needs one (#6121).
			seeded.projectJobX = await seedJob(W, ORG_X, { project_id: seeded.projectX });
			seeded.projectJobY = await seedJob(W, ORG_Y, { project_id: seeded.projectY });
			// #6131: a repository scan per org, as `/~/new` queues one — project-less, no digest yet.
			seeded.scanJobX = await seedJob(W, ORG_X, { job_type: "ANALYZE_REPO" });
			seeded.scanJobY = await seedJob(W, ORG_Y, { job_type: "ANALYZE_REPO" });
			// #6129's markers: a team and a custom role in each org, and an org-wide viewer grant to
			// each team — so the teams, roles, grants and grant-option reads each carry a row that
			// names its org. A team grant counts toward no role's member count.
			const seedPeople = async (orgId: string, org: Org): Promise<{ team: string; role: string }> => {
				const [t] = await db
					.insert(team)
					.values({ name: `it-6129-team-${org}`, organizationId: orgId })
					.returning({ id: team.id });
				const [r] = await db
					.insert(role)
					.values({ organization_id: orgId, name: `it-6129-role-${org}`, is_builtin: false })
					.returning({ id: role.id });
				await db.insert(grants).values({
					org_id: orgId,
					principal_type: "team",
					principal_id: t.id,
					effect: "allow",
					role_id: BUILTIN_ROLE_IDS.viewer,
					resource_type: "org",
				});
				return { team: t.id, role: r.id };
			};
			({ team: seeded.teamX, role: seeded.roleX } = await seedPeople(ORG_X, "x"));
			({ team: seeded.teamY, role: seeded.roleY } = await seedPeople(ORG_Y, "y"));
			// #6127's markers, on the billing records #6118 seeded above (both on a live Team plan): an AI
			// cap and a distinct paid period per org; then one invoice per org and one more project in X.
			// U's `manage_billing` in X is granted per read (`billingAdminInX`), never suite-wide.
			await db
				.update(organizationBilling)
				.set({ aiOrgWeeklyCapCredits: 1111, currentPeriodStart: X_PERIOD.start, currentPeriodEnd: X_PERIOD.end })
				.where(eq(organizationBilling.organizationId, ORG_X));
			await db
				.update(organizationBilling)
				.set({ aiOrgWeeklyCapCredits: 2222, currentPeriodStart: Y_PERIOD.start, currentPeriodEnd: Y_PERIOD.end })
				.where(eq(organizationBilling.organizationId, ORG_Y));
			await db.insert(invoice).values([
				{ organizationId: ORG_X, stripeInvoiceId: `in_it6127_x_${ORG_X.slice(0, 8)}`, number: "IT-6127-X", status: "paid", amountTotal: 100, currency: "usd", paidAt: X_PERIOD.start },
				{ organizationId: ORG_Y, stripeInvoiceId: `in_it6127_y_${ORG_Y.slice(0, 8)}`, number: "IT-6127-Y", status: "paid", amountTotal: 200, currency: "usd", paidAt: Y_PERIOD.start },
			]);
			await db.insert(projects).values({
				id: USAGE_PROJECT_X,
				user_id: W,
				org_id: ORG_X,
				project_name: `it-6127-${USAGE_PROJECT_X.slice(0, 8)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			});
			// The stamp is the premise of the markers; read it back rather than trust the insert.
			const stamped = await db
				.select({ id: jobs.id, org: jobs.org_id })
				.from(jobs)
				.where(inArray(jobs.id, [seeded.jobX, seeded.jobY]));
			expect(new Map(stamped.map((r) => [r.id, r.org]))).toEqual(
				new Map([
					[seeded.jobX, ORG_X],
					[seeded.jobY, ORG_Y],
				]),
			);

			// THE CLOCK IS FROZEN for the assertions (only `Date`; timers stay real). Each one deep-equals
			// two reads made a moment apart, and a read that reports "up to now" — the managed runners'
			// provisioned hours bill an open session up to the read (#6123) — would differ between them by
			// the milliseconds in between, whatever another suite left running. Rounding would only move
			// that to a boundary; one instant for the whole suite removes it.
			vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
		});

		afterAll(async () => {
			vi.useRealTimers();
			const db = getServiceDb();
			await db.delete(jobs).where(inArray(jobs.org_id, [ORG_X, ORG_Y]));
			await db.delete(alertDeliveries).where(inArray(alertDeliveries.org_id, [ORG_X, ORG_Y]));
			await db.delete(alertRules).where(inArray(alertRules.org_id, [ORG_X, ORG_Y]));
			await db.delete(alertChannels).where(inArray(alertChannels.org_id, [ORG_X, ORG_Y]));
			await db.delete(runners).where(inArray(runners.org_id, [ORG_X, ORG_Y]));
			await db.delete(organizationBilling).where(inArray(organizationBilling.organizationId, [ORG_X, ORG_Y]));
			await db.delete(supportCases).where(inArray(supportCases.org_id, [ORG_X, ORG_Y]));
			const seededProjects = [seeded.projectX, seeded.projectY].filter((id) => id !== "");
			if (seededProjects.length > 0) {
				await db.delete(projectEnvironments).where(inArray(projectEnvironments.project_id, seededProjects));
				await db.delete(projectFabrics).where(inArray(projectFabrics.project_id, seededProjects));
				await db.delete(projects).where(inArray(projects.id, seededProjects));
			}
			// Inventory rows cascade with their identity.
			await db.delete(cloudIdentities).where(inArray(cloudIdentities.org_id, [ORG_X, ORG_Y]));
			await db.delete(projects).where(eq(projects.id, USAGE_PROJECT_X));
			await db.delete(invoice).where(inArray(invoice.organizationId, [ORG_X, ORG_Y]));
			await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG_X, ORG_Y, ...USERS]));
			await db.delete(grants).where(inArray(grants.org_id, [ORG_X, ORG_Y, ...USERS]));
			await db.delete(team).where(inArray(team.organizationId, [ORG_X, ORG_Y]));
			await db.delete(role).where(inArray(role.organization_id, [ORG_X, ORG_Y]));
			await db.delete(member).where(inArray(member.organizationId, [ORG_X, ORG_Y]));
			await db.delete(organization).where(inArray(organization.id, [ORG_X, ORG_Y]));
			await db.delete(user).where(inArray(user.id, USERS));
			await db.delete(jobs).where(eq(jobs.user_id, W));
		});

		describe("the fixture map covers the router exactly", () => {
			it("every procedure in the router has a tenancy fixture", () => {
				const missing = PATHS.filter((path) => !(path in FIXTURES))
					.map((path) => `${path}: a new read procedure must prove its tenancy here (FIXTURES in rpc-tenancy.shared.ts)`);
				expect(missing).toEqual([]);
			});

			it("every fixture names a procedure that is in the router", () => {
				const paths = new Set(PATHS);
				expect(Object.keys(FIXTURES).filter((path) => !paths.has(path))).toEqual([]);
			});
		});

		/**
		 * A `by-id` read's claim at an address on `address`: whatever the session, the outcome for each
		 * org's row is the same, and only the addressed org's own row is revealed (enterprise) — none in
		 * community, where every org address is the caller's personal scope.
		 */
		async function expectByIdBounded(
			call: (path: string, req: RpcTenancyRequest, input: unknown) => Promise<Outcome>,
			path: string,
			fixture: Extract<Fixture, { kind: "by-id" }>,
			address: Org,
		): Promise<void> {
			const slug = address === "x" ? SLUG_X : SLUG_Y;
			const here = address === "x" ? ORG_X : ORG_Y;
			const elsewhere = address === "x" ? ORG_Y : ORG_X;
			const other: Org = address === "x" ? "y" : "x";
			const revealed: Record<Org, boolean> = { x: false, y: false };
			for (const org of [address, other]) {
				const input = fixture.input(seeded, org);
				const mismatched = await call(path, { path: rpcPath(slug, path), user: U, sessionOrg: elsewhere }, input);
				const matched = await call(path, { path: rpcPath(slug, path), user: U, sessionOrg: here }, input);
				expect(summary(mismatched), `${path} for ${org}'s row: the session changed the outcome`).toEqual(summary(matched));
				revealed[org] = mismatched.ok && fixture.reveals(mismatched.value, seeded, org);
			}
			expect(revealed).toEqual(
				edition === "enterprise" ? { [address]: true, [other]: false } : { x: false, y: false },
			);
		}

		/**
		 * Runs a fixture's calls as its caller: U, or — for a billing-admin read (`billingAdminInX`) — U
		 * as owner of X for THESE calls only, put back to viewer afterwards, so the grant cannot leak
		 * into any other fixture's answer (#6209 review).
		 */
		async function asFixtureCaller<T>(fixture: Fixture, fn: () => Promise<T>): Promise<T> {
			if (fixture.kind !== "gated" || !fixture.billingAdminInX) return fn();
			await ensureMemberGrant(ORG_X, U, "owner");
			try {
				return await fn();
			} finally {
				await ensureMemberGrant(ORG_X, U, "viewer");
			}
		}

		describe.each(ENTRY_POINTS)("through %s", (_label, call) => {
			it.each(PATHS)("%s — the address beats the session (session X, address Y ≡ session Y, address Y)", async (path) => {
				const fixture = FIXTURES[path];
				if (!fixture) throw new Error(`${path} has no fixture`);
				if (fixture.kind === "by-id") return expectByIdBounded(call, path, fixture, "y");
				const [mismatched, matched] = await asFixtureCaller(fixture, async (): Promise<[Outcome, Outcome]> => [
					await call(path, { path: rpcPath(SLUG_Y, path), user: U, sessionOrg: ORG_X }, fixture.input),
					await call(path, { path: rpcPath(SLUG_Y, path), user: U, sessionOrg: ORG_Y }, fixture.input),
				]);
				const gated = fixture;
				if (gated.kind === "gated") {
					expect(outcomeOf(mismatched), `${path} (${gated.reason})`).toEqual(outcomeOf(matched));
					if (gated.enterprise && edition === "enterprise") {
						expect(codeOf(mismatched), `${path} at Y`).toBe(gated.enterprise.y);
					}
					if (gated.markers && edition === "enterprise" && mismatched.ok) {
						expect(gated.markers(mismatched.value, seeded)).toEqual({ x: false, y: gated.enterprise?.y === "ok" });
					}
					return;
				}
				expect(mismatched.ok, `session X / address Y failed: ${String(mismatched.ok ? "" : mismatched.error)}`).toBe(true);
				expect(matched.ok).toBe(true);
				if (!mismatched.ok || !matched.ok) return;
				if (mismatched.status !== undefined) expect(mismatched.status).toBe(200);
				expect(mismatched.value).toEqual(matched.value);

				if (fixture.kind === "not-org-scoped") {
					// Its honest claim: the org in the address does not change the answer either.
					const elsewhere = await call(path, { path: rpcPath(SLUG_X, path), user: U, sessionOrg: ORG_Y }, fixture.input);
					expect(elsewhere.ok).toBe(true);
					if (elsewhere.ok) expect(elsewhere.value, `${path} (${fixture.reason}) differs between X and Y`).toEqual(mismatched.value);
					return;
				}
				if (fixture.kind === "gated") throw new Error(`${path}: a gated fixture is asserted above`);
				const markers = fixture.markers(mismatched.value, seeded);
				if (edition === "enterprise") {
					// The multi-tenant answer: Y's rows, and nothing of X's.
					expect(markers).toEqual({ x: false, y: true });
				} else {
					// What COMMUNITY means: single-tenant. `currentActor()`'s arm 2 (lib/authz/guard.ts)
					// resolves every org address the caller is a member of to the PERSONAL scope, so U's
					// org-arm rows are U's own — and the markers, authored by W, are in neither.
					expect(markers).toEqual({ x: false, y: false });
				}
			});

			it.each(PATHS)("%s — the address beats the session the other way round (session Y, address X)", async (path) => {
				const fixture = FIXTURES[path];
				if (!fixture) throw new Error(`${path} has no fixture`);
				if (fixture.kind === "by-id") return expectByIdBounded(call, path, fixture, "x");
				const [mismatched, matched] = await asFixtureCaller(fixture, async (): Promise<[Outcome, Outcome]> => [
					await call(path, { path: rpcPath(SLUG_X, path), user: U, sessionOrg: ORG_Y }, fixture.input),
					await call(path, { path: rpcPath(SLUG_X, path), user: U, sessionOrg: ORG_X }, fixture.input),
				]);
				const gated = fixture;
				if (gated.kind === "gated") {
					expect(outcomeOf(mismatched), `${path} (${gated.reason})`).toEqual(outcomeOf(matched));
					if (gated.enterprise && edition === "enterprise") {
						expect(codeOf(mismatched), `${path} at X`).toBe(gated.enterprise.x);
					}
					if (gated.markers && edition === "enterprise" && mismatched.ok) {
						expect(gated.markers(mismatched.value, seeded)).toEqual({ x: true, y: false });
					}
					return;
				}
				expect(mismatched.ok && matched.ok).toBe(true);
				if (!mismatched.ok || !matched.ok) return;
				expect(mismatched.value).toEqual(matched.value);
				if (fixture.kind === "not-org-scoped") return; // equality above is its whole claim here
				if (fixture.kind === "gated") throw new Error(`${path}: a gated fixture is asserted above`);
				expect(fixture.markers(mismatched.value, seeded)).toEqual(
					edition === "enterprise" ? { x: true, y: false } : { x: false, y: false },
				);
			});

			it.each(PATHS)("%s — a non-member addressing Y gets a 404, never Y's rows nor X's", async (path) => {
				const outcome = await call(
					path,
					{ path: rpcPath(SLUG_Y, path), user: V, sessionOrg: ORG_X },
					inputFor(FIXTURES[path], seeded, "y"),
				);
				expect(outcome.ok, "a non-member was SERVED").toBe(false);
				if (outcome.ok) return;
				if (call === viaRoute) expect(outcome.status).toBe(404);
				else expect(isNotFound(outcome.error), `not a 404: ${String(outcome.error)}`).toBe(true);
			});
		});

		// #6130 — a support case can carry sensitive customer text, so its by-id read is held to the
		// tiered policy INSIDE an org as well as across orgs: the requester and the org's
		// owners/admins (`manage_support`) read it; a teammate who is neither gets the same NOT_FOUND
		// a case that never existed gets. U opened `caseX`; V is a viewer of X; W is X's admin.
		describe.each(ENTRY_POINTS)("#6130 support.case by id, inside the org — through %s", (_label, call) => {
			const read = (user: string, id: string) =>
				call("support.case", { path: rpcPath(SLUG_X, "support.case"), user, sessionOrg: ORG_X }, { id });

			it("a teammate who did not open the case and cannot manage support gets NOT_FOUND", async () => {
				const outcome = await read(V, seeded.caseX);
				expect(summary(outcome)).toEqual({ ok: false, code: "NOT_FOUND" });
			});

			it("the requester and an admin (manage_support) read it — in the multi-tenant edition", async () => {
				const requester = await read(U, seeded.caseX);
				const admin = await read(W, seeded.caseX);
				if (edition === "enterprise") {
					expect(requester.ok && isCase(requester.value, seeded.caseX)).toBe(true);
					expect(admin.ok && isCase(admin.value, seeded.caseX)).toBe(true);
				} else {
					// Community serves every org address from the caller's personal scope, where no
					// org case is visible to anybody.
					expect(summary(requester)).toEqual({ ok: false, code: "NOT_FOUND" });
					expect(summary(admin)).toEqual({ ok: false, code: "NOT_FOUND" });
				}
			});

			it("an id that is not a case id at all reads the same as a case you cannot see", async () => {
				const outcome = await read(U, randomUUID());
				expect(summary(outcome)).toEqual({ ok: false, code: "NOT_FOUND" });
			});
		});
	});
}
