// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The authorization contract (dataroom/spec/mvp/07-auth-rbac-sso.md Part B). One Policy
// Decision Point (PDP) interface backs every access decision; the engine behind it
// is swappable (community PostgresRbacPDP → enterprise OpenFgaPDP) with no call-site
// changes. Resource/Action are exhaustive unions (registry.ts) so a new capability
// is a single typed edit.

import type { Action, Resource } from "./registry";

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
}

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
	can(actor: Actor, action: Action, resource: ResourceRef): Promise<Decision>;
	enforce(actor: Actor, action: Action, resource: ResourceRef): Promise<void>;
	bulkCheck(actor: Actor, checks: BulkCheck[]): Promise<Decision[]>;
	/** The ids of resources of `resourceType` the actor may take `action` on. */
	listAccessible(
		actor: Actor,
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
	/**
	 * AI entitlements (repo-scanner + agent + Ask AI). All AI spends **AI credits** from
	 * one budget (a scan is heavy, a message is light). Two fixed windows scaled by the
	 * plan's multiplier `tier`: a short **window** (burn-it-all-then-wait) and a **weekly**
	 * cap. Burn freely until empty, then upgrade or buy top-up credits (NO silent overage).
	 * Numbers are never shown to users — only a usage bar + the multiplier tier. Enforced
	 * only when hosted billing is configured; self-host with a BYO gateway key is unlimited
	 * (the operator pays their own model tokens — the open-core deal).
	 */
	ai: {
		enabled: boolean;
		/** Display multiplier tier — never raw numbers (trial / standard / 5× / 20×). */
		tier: "trial" | "standard" | "plus" | "max";
		/** Included credits per short window. */
		windowCredits: number;
		/** Length of the short window, hours. */
		windowHours: number;
		/** Included credits per 7-day week (the headline cap). */
		weeklyCredits: number;
	};
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
