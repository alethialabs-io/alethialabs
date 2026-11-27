"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// C2 slug resolution. The `/{org}/{project}/{env}` route layers resolve each
// slug → entity id here (tenant-scoped via withActorScope / membership checks),
// then render the existing id-based views. `resolveOrgScope` also syncs the
// session's active organization so the rest of the request is scoped to the URL org.

import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getOwnerScope } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { getServiceDb } from "@/lib/db";
import {
	member,
	organization,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { PERSONAL_ORG_SLUG } from "@/lib/routing";
import { setActiveOrganization } from "./workspace";

export interface ResolvedOrg {
	orgId: string;
	isPersonal: boolean;
}

/**
 * Resolves the URL org segment to a scope and syncs the session's active org so the
 * rest of the request runs under it. `~` = the personal scope (orgId = userId). A
 * real slug must belong to an org the user is a member of, else it throws.
 *
 * ## This is a session mutation on a GET, on BOTH branches (#4089)
 *
 * `[org]/layout.tsx` calls this on every render of every `/{org}/…` route, and it
 * WRITES `session.active_organization_id` — the `~` branch clears a stale org, the
 * real-slug branch sets the URL's. That write is durable, cross-request and
 * cross-tab. A patch that gates only the `~` branch leaves half the defect standing.
 *
 * A GET that mutates the session is dangerous because **Next issues GETs the user
 * never made**: `<Link>` prefetches every link in the viewport, and each prefetch
 * renders this layout. In #4089 a hydration-window bug painted `/~/~/…` hrefs, Next
 * prefetched them, and the session moved to the personal org while the address bar
 * still said `/acme/…` — so the next write landed in the wrong tenant, silently.
 *
 * **The write cannot be gated on the request being a prefetch.** `next-router-prefetch`
 * is on the wire, but Next 16.3.3 does not let userland see it. It is a member of
 * `FLIGHT_HEADERS` (`next/dist/client/components/app-router-headers.js`), which
 * `next/dist/server/async-storage/request-store.js` folds into `HIDDEN_REQUEST_HEADERS`
 * — "Internal request headers that userland `headers()` must not expose" — and seals
 * out of the view `headers()` returns, so `.get()` answers `null` and `.has()` answers
 * `false` on a real prefetch. `proxy.ts` cannot see it either: `server/web/adapter.js`
 * DELETES every flight header from the request before constructing the `NextRequest`
 * middleware receives. `rsc` is hidden the same way, and the `_rsc` query parameter
 * does not distinguish a prefetch from a soft navigation. There is no server-side
 * prefetch signal in this version; do not add a `headers()` check believing there is.
 *
 * So what keeps this safe is an invariant one layer up, not a guard here: **every
 * prefetchable href names the org the address bar already names.** `useActiveOrgSlug`
 * reads `useParams().org` for exactly that reason (see its doc comment). Under that
 * invariant a speculative resolve can only re-assert the org the user is already in
 * — the same value a real navigation to that page would write — so it is idempotent.
 * Breaking the invariant, by painting a link to some OTHER org's slug, reopens the
 * defect: prefetching it silently switches the tenant. Such a link needs
 * `prefetch={false}`.
 *
 * Note also that this module is `"use server"`, so every export is additionally a
 * POST-able action endpoint. Were a request-shape check added here, it would read the
 * ACTION's request when invoked that way, not the render's.
 *
 * The remaining correctness gap is deliberately NOT fixed here: readers downstream
 * resolve their tenant from the session rather than from the `[org]` route param, so
 * a session on tenant A renders A's data under B's address instead of refusing. That
 * is what makes a mis-scoped write silent rather than loud. Tracked separately —
 * threading the route param into the readers is a different-sized change.
 */
export async function resolveOrgScope(orgSlug: string): Promise<ResolvedOrg> {
	const { userId, activeOrgId } = await getOwnerScope();

	if (orgSlug === PERSONAL_ORG_SLUG) {
		// Personal scope: orgId === userId. Clear any active org if one is set.
		// WRITE ON A GET — see the invariant in this function's doc comment.
		if (activeOrgId && activeOrgId !== userId) {
			await setActiveOrganization(userId);
		}
		return { orgId: userId, isPersonal: true };
	}

	const db = getServiceDb();
	const [org] = await db
		.select({ id: organization.id })
		.from(organization)
		.innerJoin(
			member,
			and(eq(member.organizationId, organization.id), eq(member.userId, userId)),
		)
		.where(eq(organization.slug, orgSlug))
		.limit(1);

	// A URL slug that doesn't resolve to a member org is a 404, not a bug — render the not-found page
	// (notFound() throws NEXT_NOT_FOUND, which the onRequestError filter treats as expected) rather
	// than a raw Error that floods error tracking with stale-link/crawler hits.
	if (!org) notFound();

	// WRITE ON A GET — the second of the two branches; see this function's doc comment.
	if (activeOrgId !== org.id) {
		await setActiveOrganization(org.id);
	}
	return { orgId: org.id, isPersonal: false };
}

/**
 * The id of the project `projectSlug` names under the scope `(userId, orgId)`, or `null` when it
 * names none there. Memoised PER REQUEST with React `cache()`: the `[project]` layout, the page
 * below it and the topbar's environment switcher read (`getEnvironmentsForSlug`) each ask this
 * question about the same slug in one render, and it is now one query instead of three (#7736).
 *
 * WHY THE SCOPE IS IN THE KEY, NOT ONLY THE SLUG. `cache()` keys on its arguments, and the answer
 * depends on the actor as much as on the slug: RLS (`withActorScope`) is what scopes the lookup to
 * the active org, and slugs are unique per org only. `currentActor()` is resolved by the CALLER on
 * every call — never memoised here — so a call made under a different actor (an injected actor, an
 * org the address names differently) is a different key and a fresh, correctly scoped query. Two
 * strings and a slug are compared by value, so equal scopes share one entry.
 *
 * The switcher's GET read (`readEnvironmentsForSlug`, lib/rpc/procedures/environments.ts) reaches
 * it through `resolveProjectId`, so the `[project]` layout's switcher seed shares it too (#7877).
 *
 * NOT EXPORTED, deliberately: this module is `"use server"`, so every export is also a POST-able
 * action endpoint, and one taking a caller-chosen `(userId, orgId)` would let a client name any
 * scope. Only the actor-deriving exports below reach it.
 *
 * Outside a React server render (a server action's POST, a route handler) `cache()` memoises
 * nothing and this simply runs the query, which is the behaviour every caller had before.
 */
const lookupProjectIdInScope = cache(
	async (userId: string, orgId: string, projectSlug: string): Promise<string | null> =>
		withActorScope({ userId, orgId }, async (tx) => {
			const [project] = await tx
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.slug, projectSlug))
				.limit(1);
			return project?.id ?? null;
		}),
);

/** Resolves a project (project) slug → project id within the active scope (404 → throws). Projects
 * are unique per org, so the slug resolves directly (RLS scopes to the active org). The lookup is
 * memoised per request and per scope (`lookupProjectIdInScope`), so the layout and the page below it
 * resolve the slug with ONE query. */
export async function resolveProjectId(projectSlug: string): Promise<string> {
	// Actor scope: a project is org-shared, so RLS must carry the real active org —
	// withOwnerScope(userId) was personal-scoped, so a teammate couldn't resolve a
	// project another member owns (matches resolveActiveEnvironmentId's org scoping).
	// The actor is read on EVERY call, outside the memo — it is half of the memo's key.
	const actor = await currentActor();
	const projectId = await lookupProjectIdInScope(actor.userId, actor.orgId, projectSlug);
	// Unresolvable slug = a 404 (stale link / crawler), not a bug — see resolveOrgScope above.
	if (projectId === null) notFound();
	return projectId;
}

/**
 * The canvas's active environment id: the env identified by `envId` (validated to belong to the
 * project), or — when `envId` is absent (the bare `/{org}/{project}` canvas) or doesn't resolve —
 * the project's DEFAULT environment. Config is environment-scoped, so every load/stage/apply needs
 * a concrete environment id.
 */
export async function resolveActiveEnvironmentId(
	projectId: string,
	envId?: string | null,
): Promise<string> {
	// Scoped to the caller's ORG, not the owner user: join to the parent project and filter on
	// actor.orgId (mirrors the drift/addons reads). The old withOwnerScope(userId) was personal-
	// scoped — wrong for Teams (a teammate couldn't resolve a project owned by ANOTHER member, so
	// every addon/BYO read+write threw for them) AND it left those write paths only INCIDENTALLY
	// cross-tenant-safe (they leaned on this helper throwing for a foreign project). Org scoping is
	// the real tenancy wall: a foreign project's environment never resolves for this actor.
	const actor = await currentActor();
	const db = getServiceDb();
	if (envId) {
		const [named] = await db
			.select({ id: projectEnvironments.id })
			.from(projectEnvironments)
			.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
			.where(
				and(
					eq(projectEnvironments.project_id, projectId),
					eq(projectEnvironments.id, envId),
					eq(projects.org_id, actor.orgId),
				),
			)
			.limit(1);
		if (named) return named.id;
	}
	const [def] = await db
		.select({ id: projectEnvironments.id })
		.from(projectEnvironments)
		.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
		.where(
			and(
				eq(projectEnvironments.project_id, projectId),
				eq(projectEnvironments.is_default, true),
				eq(projects.org_id, actor.orgId),
			),
		)
		.limit(1);
	if (!def) throw new Error("Project has no default environment");
	return def.id;
}

/**
 * The active org's URL slug (server side). Prefers the session's selected org;
 * otherwise falls back to the user's earliest org membership (so a freshly
 * signed-up user lands on their auto-created org), and finally `~` (personal).
 */
export async function getActiveOrgSlug(): Promise<string> {
	const { userId, activeOrgId } = await getOwnerScope();
	const db = getServiceDb();

	if (activeOrgId && activeOrgId !== userId) {
		const [org] = await db
			.select({ slug: organization.slug })
			.from(organization)
			.where(eq(organization.id, activeOrgId))
			.limit(1);
		if (org?.slug) return org.slug;
	}

	// No explicit selection → land on the user's primary (earliest) org if any.
	const [primary] = await db
		.select({ slug: organization.slug })
		.from(organization)
		.innerJoin(
			member,
			and(eq(member.organizationId, organization.id), eq(member.userId, userId)),
		)
		.orderBy(member.createdAt)
		.limit(1);
	return primary?.slug ?? PERSONAL_ORG_SLUG;
}

/** A project (project) slug by project id (within the active scope), or null. */
export async function getProjectSlug(projectId: string): Promise<string | null> {
	const actor = await currentActor();
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({ projectSlug: projects.slug })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		return row?.projectSlug ?? null;
	});
}

export interface SwitcherEnv {
	id: string;
	project_id: string;
	name: string;
	stage: string;
	is_default: boolean;
}

/**
 * Lists a project's environments resolved by project slug, as a server ACTION — the Elench scope
 * chip calls it from the browser. Returns [] if the slug doesn't resolve in the active scope.
 *
 * The topbar switcher no longer reads through here: its GET read, `workspace.environments`, is the
 * environments domain's canonical read (`readEnvironmentsForSlug`, lib/rpc/procedures/environments.ts,
 * #7877), memoised per request with the Environments page's overview and table. Both answer the same
 * rows in the same order under the same RLS scope; this one stays because an action POST memoises
 * nothing and its callers outside the render keep their call shape.
 */
export async function getEnvironmentsForSlug(
	projectSlug: string,
): Promise<SwitcherEnv[]> {
	const actor = await currentActor();
	// The same per-request lookup `resolveProjectId` uses, so the `[project]` layout's switcher
	// prefetch does not resolve the slug a second time (#7736).
	const projectId = await lookupProjectIdInScope(actor.userId, actor.orgId, projectSlug);
	if (projectId === null) return [];
	return withActorScope(actor, async (tx) =>
		tx
			.select({
				id: projectEnvironments.id,
				project_id: projectEnvironments.project_id,
				name: projectEnvironments.name,
				stage: projectEnvironments.stage,
				is_default: projectEnvironments.is_default,
			})
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId))
			.orderBy(projectEnvironments.created_at),
	);
}
