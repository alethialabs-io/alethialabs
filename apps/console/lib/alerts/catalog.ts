// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The curated event catalog (dataroom/spec/mvp/25-alerting-notifications.md), modelled on the
// Claude alerts design: human-friendly events grouped into categories, each mapped to a
// real underlying emit KEY (or `*`-glob pattern) that a policy stores and emit matches.
// Keys are TEXT, not a DB enum, so the alertable surface grows with the product — no
// migration per event. Two key families under the hood:
//   authz.<resource>.<action>.<allowed|denied>  — every PDP decision (emitted from the
//                                                  single enforceDecision chokepoint)
//   system.<domain>.<event>                      — lifecycle events
// `live: false` events are configurable now but won't fire until their emitter ships
// (Phase 2/3+). `authz.*` keys are the security/governance half (advancedAlerting-gated).

import type { Action, Resource } from "@/lib/authz/registry";
import type { AlertSeverity } from "@/lib/db/schema/enums";

/** lucide icon names the UI resolves (data stays JSX-free). */
export type CategoryIcon =
	| "Boxes"
	| "ShieldCheck"
	| "KeyRound"
	| "Users"
	| "Fingerprint"
	| "CircleDollarSign"
	| "Cpu"
	| "LogIn"
	| "LifeBuoy";

export interface CatalogEvent {
	/** Stable display id (e.g. "deploy.failed"). */
	id: string;
	/** Underlying emit key/pattern a policy stores and emit matches. */
	key: string;
	label: string;
	/** The project's 3-tier severity — the category conveys the domain. */
	severity: AlertSeverity;
	/** Whether an emitter exists today; false = selectable but inert for now. */
	live: boolean;
}

export interface CatalogCategory {
	id: string;
	label: string;
	icon: CategoryIcon;
	events: CatalogEvent[];
}

const ev = (
	id: string,
	key: string,
	label: string,
	severity: AlertSeverity,
	live = false,
): CatalogEvent => ({ id, key, label, severity, live });

export const CATEGORIES: CatalogCategory[] = [
	{
		id: "deploy",
		label: "Deploy & drift",
		icon: "Boxes",
		events: [
			ev("deploy.started", "system.job.started", "Deploy started", "info", true),
			ev("deploy.succeeded", "system.job.succeeded", "Deploy succeeded", "info", true),
			ev("deploy.failed", "system.job.failed", "Deploy failed", "critical", true),
			ev("destroy.requested", "system.job.destroy_requested", "Destroy requested", "warning", true),
			ev("destroy.completed", "system.project.destroyed", "Destroy completed", "warning", true),
			ev("drift.detected", "system.project.drift", "Drift detected", "warning"),
			ev("status.conflict", "system.project.status_conflict", "Environment status conflict", "warning", true),
		],
	},
	{
		id: "policy",
		label: "Policy (PDP)",
		icon: "ShieldCheck",
		events: [
			ev("policy.denied", "authz.*.*.denied", "Action denied", "warning", true),
			ev("policy.sensitive", "authz.*.destroy.allowed", "Sensitive action allowed", "warning", true),
			ev("policy.override", "authz.policy.override", "Policy overridden", "critical"),
			ev("policy.rule_changed", "authz.role.edit", "Role permissions changed", "warning", true),
		],
	},
	{
		id: "access",
		label: "Access & roles (RBAC)",
		icon: "KeyRound",
		events: [
			ev("access.granted", "authz.grant.assign", "Grant added", "info", true),
			ev("access.revoked", "authz.grant.revoke", "Grant revoked", "warning", true),
			ev("role.created", "authz.role.create", "Role created", "info", true),
			ev("role.changed", "authz.role.edit", "Role permissions changed", "warning", true),
			ev("role.deleted", "authz.role.delete", "Role deleted", "warning", true),
		],
	},
	{
		id: "members",
		label: "Members",
		icon: "Users",
		events: [
			ev("member.invited", "system.member.invited", "Member invited", "info", true),
			ev("member.joined", "system.member.joined", "Member joined", "info", true),
			ev("member.removed", "system.member.removed", "Member removed", "warning", true),
			ev("member.suspended", "system.member.suspended", "Member suspended", "warning"),
		],
	},
	{
		id: "identity",
		label: "Cloud identities",
		icon: "Fingerprint",
		events: [
			ev("identity.connected", "system.identity.connected", "Identity connected", "info", true),
			ev("identity.rotated", "system.identity.rotated", "Credentials rotated", "info"),
			ev("identity.revoked", "system.identity.revoked", "Identity revoked", "warning", true),
			ev("credential.expiring", "system.connector.token_failed", "Credential expiring / failed", "warning", true),
		],
	},
	{
		id: "cost",
		label: "Cost",
		icon: "CircleDollarSign",
		events: [
			ev("budget.threshold", "system.cost.budget_threshold", "Budget threshold crossed", "warning"),
			ev("spend.spike", "system.cost.spend_spike", "Spend spike", "warning"),
			ev("overage.started", "system.cost.overage", "Overage started", "info"),
		],
	},
	{
		id: "workers",
		label: "Workers & runners",
		icon: "Cpu",
		events: [
			ev("worker.unhealthy", "system.runner.offline", "Worker unhealthy", "warning", true),
			ev("worker.stalled", "system.runner.stalled", "Worker stalled", "warning"),
			ev("runner.exhausted", "system.runner.exhausted", "Runner minutes exhausted", "warning"),
		],
	},
	{
		id: "auth",
		label: "Authentication",
		icon: "LogIn",
		events: [
			ev("sso.failed", "system.auth.sso_failed", "SSO sign-in failed", "warning"),
			ev("login.new_device", "system.auth.new_device", "New-device sign-in", "info"),
			ev("login.blocked", "system.auth.login_blocked", "Sign-in blocked", "warning"),
		],
	},
	{
		id: "support",
		label: "Support",
		icon: "LifeBuoy",
		events: [
			ev("support.opened", "system.support.case.opened", "Support case opened", "info", true),
			ev("support.replied", "system.support.case.replied", "Support case reply", "info", true),
			ev("support.resolved", "system.support.case.resolved", "Support case resolved", "info", true),
			ev("support.reopened", "system.support.case.reopened", "Support case reopened", "warning", true),
			ev("support.closed", "system.support.case.closed", "Support case closed", "info", true),
			// Emitter ships with the staff assignment write-path (P2).
			ev("support.assigned", "system.support.case.assigned", "Support case assigned", "info"),
		],
	},
];

export const ALL_EVENTS: CatalogEvent[] = CATEGORIES.flatMap((c) => c.events);
const KEY_LABEL = new Map(ALL_EVENTS.map((e) => [e.key, e.label]));

/** Builds the concrete key for a PDP decision (the enforceDecision seam). */
export function authzEventKey(
	resource: Resource,
	action: Action,
	allowed: boolean,
): string {
	return `authz.${resource}.${action}.${allowed ? "allowed" : "denied"}`;
}

/** Security keys (PDP-sourced) are the open-core gate; system keys are free. */
export function isSecurityKey(key: string): boolean {
	return key.startsWith("authz.");
}

/**
 * Matches an event `key` against a policy `pattern`. `*` matches exactly one segment;
 * a trailing `*` matches the remainder (`authz.*` = every authz key, `authz.*.*.denied`
 * = any denial, `system.job.*` = both job outcomes). Exact patterns match only that key.
 */
export function eventMatches(pattern: string, key: string): boolean {
	const p = pattern.split(".");
	const k = key.split(".");
	for (let i = 0; i < p.length; i++) {
		if (p[i] === "*" && i === p.length - 1) return true; // trailing * = rest
		if (i >= k.length) return false;
		if (p[i] === "*") continue; // single-segment wildcard
		if (p[i] !== k[i]) return false;
	}
	return p.length === k.length;
}

/** Friendly label for a concrete key (delivery rows, email subject). */
export function labelForKey(key: string): string {
	const known = KEY_LABEL.get(key);
	if (known) return known;
	const [ns, resource, action, outcome] = key.split(".");
	if (ns === "authz" && resource && action) {
		return `${resource} · ${action}${outcome === "denied" ? " denied" : outcome === "allowed" ? " allowed" : ""}`;
	}
	return key;
}
