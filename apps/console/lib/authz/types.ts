// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The authorization contract (dataroom/spec/mvp/07-auth-rbac-sso.md Part B). One Policy
// Decision Point (PDP) interface backs every access decision; the engine behind it
// is swappable (community PostgresRbacPDP → enterprise OpenFgaPDP) with no call-site
// changes. Resource/Action are exhaustive unions (registry.ts) so a new capability
// is a single typed edit.

import type { AgentScope } from "@/lib/approvals/types";
import type { Action, Resource } from "./registry";

/**
 * What a non-interactive credential is limited to, on top of its user's own grants (agent surface
 * §4.4): the verbs it may use and the projects it may touch. A ceiling, never a grant — a decision
 * under it is the PDP's answer AND this limit's, so the credential never exceeds its user.
 *
 * - `scopes` — never empty. A credential whose scopes cannot be read carries no actor at all.
 * - `projectIds` — `null` means every project in the actor's org; otherwise never empty.
 *
 * Applied by the PDP that `getPdp` returns (lib/authz/scope-ceiling.ts), so every route and tool
 * that asks the PDP inherits it.
 */
export interface ScopeCeiling {
	readonly scopes: readonly AgentScope[];
	readonly projectIds: readonly string[] | null;
}

/**
 * The five kinds of credential an actor can be built from. See {@link Actor.credential}.
 *
 * | Kind            | Meant for                                |
 * |-----------------|------------------------------------------|
 * | `session`       | a console browser session                |
 * | `cli_session`   | a CLI device-login token stored on disk  |
 * | `agent_oauth`   | an MCP OAuth access token                |
 * | `agent_in_app`  | an in-product agent turn                 |
 * | `service_token` | a `cli_service_tokens` row               |
 *
 * WHAT IS ACTUALLY BOUND TODAY IS NARROWER THAN THE TABLE, in two places. Nothing in the type
 * enforces which builder binds which kind, so read this before relying on a member:
 *
 * - `cli_session` is bound by `POST /api/jobs` only (app/api/jobs/route.ts). Every other CLI
 *   route goes through `authorizeCli` (lib/authz/guard.ts), which still binds a device login as
 *   `session`. So `session` does not yet mean "a person present in a browser" everywhere.
 * - `agent_in_app` is bound by nothing yet.
 */
export const CREDENTIAL_KINDS = [
	"session",
	"cli_session",
	"agent_oauth",
	"agent_in_app",
	"service_token",
] as const;

/** One of {@link CREDENTIAL_KINDS}. */
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * The two kinds a CLI bearer token is classified as — the members of `CliCredential`
 * (lib/authz/guard.ts), which is this type under another name. It is NOT the type of
 * {@link Actor.credential}; that is {@link CredentialKind}.
 *
 * It keeps its two members because every `switch` over a CLI bearer (guard.ts, runner-org.ts,
 * lib/cli/providers.ts, app/api/jobs/route.ts) is closed over exactly these, and a CLI bearer can
 * be nothing else: `credentialOf` (lib/cli/providers.ts) returns one of the two or refuses.
 */
export type ActorCredential = Extract<CredentialKind, "session" | "service_token">;

/** The principal making a request, resolved once per request via getActiveScope(). */
export interface Actor {
	userId: string;
	/** Active tenancy scope. Community = the user's personal org (orgId === userId). */
	orgId: string;
	/**
	 * Feature entitlements for this actor's active org, resolved once (async) when the
	 * scope is built so call sites can read them synchronously via getEntitlements().
	 * Optional on the type because enterprise resolveScope returns the {userId, orgId}
	 * pair; getActiveScope is the single place that guarantees this is populated.
	 */
	entitlements?: Entitlements;
	/**
	 * The kind of credential this actor was built from. REQUIRED, so every place that builds an
	 * actor has to say which it is: a scope resolved by `getActiveScope` carries no credential
	 * (`ResolvedScope`) and becomes an `Actor` only through `actorWithCredential`
	 * (lib/authz/actor-credential.ts).
	 *
	 * - `session` — a person at the console. `userId` is the caller.
	 * - `cli_session`, `agent_oauth`, `agent_in_app` — a person's own grant, held by a program.
	 *   `userId` is still the person the grant belongs to, so an identity rule treats these as it
	 *   treats `session`; what differs is that nobody need be present.
	 * - `service_token` — a CLI machine credential pinned to `orgId`. `userId` is the profile that
	 *   MINTED it, not a caller, so a rule keyed on "the person asking" must not read `userId` as
	 *   that person. Server actions see only the `Actor` (the CLI routes reach them through
	 *   `runWithActor`), which is why the kind travels on it.
	 *
	 * Read it through the helpers in lib/authz/actor-credential.ts, not directly.
	 */
	credential: CredentialKind;
	/**
	 * The scope and project limit of the credential this actor was built from, when it has one. Set
	 * by the builders that verify a limited credential (`authorizeCli` and `resolveCliProvider` for
	 * a service token); absent means the actor's own grants are the whole answer.
	 */
	ceiling?: ScopeCeiling;
	/**
	 * Which credential of its kind this actor was built from, when the kind has more than one per
	 * person: the `cli_service_tokens.id` of a service token. Set beside {@link ceiling} by
	 * `withServiceTokenCeiling` (lib/authz/guard.ts). The approval engine (lib/approvals) binds an
	 * approval to it and reads the token's automatic-deploy environments by it.
	 */
	credentialRef?: string;
}

/**
 * A resolved tenancy scope before it is bound to a credential: what `getActiveScope` returns.
 * `actorWithCredential` turns it into an {@link Actor}.
 */
export type ResolvedScope = Omit<Actor, "credential">;

/** What an action targets. `id` is omitted for create/list; `orgId` for cross-checks. */
export interface ResourceRef {
	type: Resource;
	id?: string;
	/** The org that owns the resource (for the coarse scope check). */
	orgId?: string;
}

export interface Decision {
	allowed: boolean;
	/** Machine-readable reason (logged to authz_audit_log), e.g. "no_grant". */
	reason?: string;
}

export interface BulkCheck {
	action: Action;
	resource: ResourceRef;
}

/**
 * The single place an access decision is made. Call sites use `enforce()` (throws
 * 403) or `listAccessible()` (the ListObjects equivalent for list views) — never
 * their own `.eq(user_id)` checks. `bulkCheck` batches; never loop `can()`.
 */
export interface Pdp {
	// A `ResolvedScope`, not an `Actor`: a permission is decided by who and where, never by which
	// kind of credential carried the request, so a decision needs no credential bound.
	can(actor: ResolvedScope, action: Action, resource: ResourceRef): Promise<Decision>;
	enforce(actor: ResolvedScope, action: Action, resource: ResourceRef): Promise<void>;
	bulkCheck(actor: ResolvedScope, checks: BulkCheck[]): Promise<Decision[]>;
	/** The ids of resources of `resourceType` the actor may take `action` on. */
	listAccessible(
		actor: ResolvedScope,
		action: Action,
		resourceType: Resource,
	): Promise<string[]>;
}

/** Feature entitlements for a scope. Community = all false; ee/ flips per license. */
export interface Entitlements {
	organizations: boolean;
	/** Team (access-group) management — create teams and scope grants to them. Enterprise. */
	teams: boolean;
	sso: boolean;
	customRoles: boolean;
	/** CSV export of the Activity log. Viewing is free; export is Enterprise. */
	activityExport: boolean;
	/**
	 * The alerting surface as a whole (dataroom/spec/mvp/25-alerting-notifications.md): policies,
	 * channels and the delivery activity log. Granular notification routing is a paid feature —
	 * granted on team (Pro) and up. Community sees the upsell instead of the surface.
	 */
	alerting: boolean;
	/**
	 * Security/governance alerting: alert rules sourced from PDP Activity events (denials,
	 * recorded actions, grant/role changes). Sits ON TOP of `alerting` — the operational
	 * (system.*) half is unlocked at Pro; this flag only gates the PDP-sourced (authz.*) half,
	 * which stays Enterprise.
	 */
	advancedAlerting: boolean;
	/**
	 * Bring-your-own runners — the runner list + Add Runner (deploy into your cloud / register your
	 * own). Granted on team (Pro) and up; community sees the upsell. Self-managed operators always
	 * have it (gated by deployment mode, not this flag).
	 */
	byoRunners: boolean;
	/**
	 * Managed warm-pool fleet operations (pools / versions / economics). Reserved for Enterprise;
	 * not yet surfaced on hosted (the managed fleet is a global platform table — per-org hosted
	 * pools are a future project). Self-managed operators manage pools regardless of this flag.
	 */
	managedPools: boolean;
	/**
	 * The enterprise agent-policy toggles (agent surface §4.9, AGT-L14): "require a different
	 * approver" — which also makes a person's own console deploy to production, and every destroy,
	 * need a second person — and the OAuth client allow-list. The columns live in core and are read
	 * only while this is `true`; the kill switch and "agents may not apply to production" are core
	 * safety controls and are never gated by it. A licence whose entitlements claim does not name it
	 * does not grant it (every reader tests for the boolean `true`).
	 */
	agentPolicy: boolean;
	/**
	 * Runner-scheduling quotas (ADR 20). Mirrors the authoritative SQL mapping in
	 * programmables.sql (plan_max_concurrency / plan_priority) for UI + insert-time
	 * "at your limit" UX. The claim_next_job RPC is the source of truth.
	 */
	quotas: {
		/** Max in-flight jobs on the shared managed pool; null = unlimited. */
		maxConcurrentJobs: number | null;
		/** Base claim priority band (community 0 … enterprise 30). */
		priorityLevel: number;
		/**
		 * Included managed-runner **job-minutes** per billing period (ADR 17/20 §5).
		 * Usage above this bills overage on paid tiers; community hard-stops here.
		 * Self-hosted runners are never metered.
		 */
		includedRunnerMinutes: number;
		/**
		 * How far back the Activity (authz-decision) feed is queryable, in days. Gates the
		 * time-range presets in the UI (a window older than this prompts an upgrade);
		 * community 7 · team 30 · enterprise 365.
		 */
		activityRetentionDays: number;
	};
	// NOTE: AI is NO LONGER an org-plan entitlement. It is a STANDALONE metered product
	// with its own tier ladder (lib/billing/ai-plan.ts — `ai_free`/`ai_plus`/`ai_max`),
	// resolved per-org via resolveAiTier() and enforced by lib/billing/ai-guard.ts —
	// orthogonal to the Hobby/Pro/Enterprise org plan above.
}

/** Thrown by enforce() on denial; mapped to 403 at route/action boundaries. */
export class ForbiddenError extends Error {
	constructor(
		readonly action: Action,
		readonly resource: ResourceRef,
		readonly reason?: string,
	) {
		super(
			`Forbidden: ${action} on ${resource.type}${resource.id ? ` ${resource.id}` : ""}${reason ? ` (${reason})` : ""}`,
		);
		this.name = "ForbiddenError";
	}
}
