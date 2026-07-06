// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Turns a raw Activity row into a natural-language line for the feed, plus the event
// taxonomy + matcher that back the event-type filter. Pure (no I/O / React): resource
// names are resolved through a caller-supplied lookup so this stays unit-friendly. The
// Activity log records every recorded action + denial, so the vocabulary here is the
// registry's (lib/authz/registry.ts) plus the ee/ resource types the org plugin writes
// (role / grant / team / member / invitation).

import type { ActivityRow } from "@/app/server/actions/activity";
import { displayName } from "@/lib/user-display";
import type { GroupedFilterGroup } from "@repo/ui/grouped-filter-sheet";

/** A friendly singular noun for a resource type. */
const NOUNS: Record<string, string> = {
	org: "organization",
	project: "project",
	runner: "runner",
	job: "job",
	fleet: "fleet pool",
	cloud_identity: "cloud identity",
	connector: "connector",
	member: "member",
	invitation: "invitation",
	team: "team",
	role: "role",
	grant: "grant",
	billing: "billing",
	alert: "alert",
	activity: "activity log",
};

/** Past-tense verb for the resource-scoped actions (allows). */
const PAST_VERB: Record<string, string> = {
	create: "created",
	edit: "updated",
	destroy: "deleted",
	deploy: "deployed",
	plan: "planned",
	view: "viewed",
	// Access-grant governance (recorded by grants.ts).
	assign: "assigned",
	revoke: "revoked",
};

function noun(resourceType: string): string {
	return NOUNS[resourceType] ?? resourceType.replace(/_/g, " ");
}

/** Context for resolving a resource id to a human name (projects/members/…). */
export interface ActivityContext {
	/** Friendly name for a `(resourceType, resourceId)`, or null when unknown. */
	resolveName: (resourceType: string, resourceId: string | null) => string | null;
}

/** The noun phrase for a row's resource: "project my-api", "runner web", else "a project". */
function resourcePhrase(row: ActivityRow, ctx: ActivityContext): string {
	const n = noun(row.resourceType);
	const name = ctx.resolveName(row.resourceType, row.resourceId);
	if (name) return `${n} ${name}`;
	return /^[aeiou]/.test(n) ? `an ${n}` : `a ${n}`;
}

/**
 * The denied action as a noun phrase ("was denied {…}"): "member management",
 * "an activity-log export", "deploying project my-api". Becomes the bold `target`.
 */
function deniedTarget(row: ActivityRow, ctx: ActivityContext): string {
	switch (row.action) {
		case "manage_members":
			return "member management";
		case "manage_identities":
			return "cloud-identity management";
		case "manage_connectors":
			return "connector management";
		case "manage_billing":
			return "billing management";
		case "export_activity":
			return "an activity-log export";
		case "view_activity":
			return "viewing the activity log";
		case "view_alerts":
			return "viewing alerts";
		case "manage_alerts":
			return "alert management";
		case "test":
			return `testing ${resourcePhrase(row, ctx)}`;
		default:
			return `${row.action.replace(/_/g, " ")} ${resourcePhrase(row, ctx)}`;
	}
}

/** The split between the plain connective (`lead`) and the bold object (`target`). */
interface Predicate {
	lead: string;
	target: string | null;
}

/** The past-tense predicate for an allowed, recorded action, split lead + bold target. */
function pastPredicate(row: ActivityRow, ctx: ActivityContext): Predicate {
	// Member lifecycle (recorded by the ee org-plugin hooks; actor = the affected member).
	if (row.resourceType === "member") {
		switch (row.action) {
			case "join":
				return { lead: "joined", target: "the organization" };
			case "remove":
				return { lead: "was removed from", target: "the organization" };
			case "role_change":
				return { lead: "had their role changed", target: null };
		}
	}
	const verb = PAST_VERB[row.action];
	if (verb) return { lead: verb, target: resourcePhrase(row, ctx) };
	switch (row.action) {
		case "manage_members":
			return { lead: "updated", target: "member access" };
		case "manage_identities":
			return { lead: "updated", target: "cloud identities" };
		case "manage_connectors":
			return { lead: "updated", target: "connectors" };
		case "manage_billing":
			return { lead: "updated", target: "billing" };
		case "export_activity":
			return { lead: "exported", target: "the activity log" };
		case "view_activity":
			return { lead: "viewed", target: "the activity log" };
		case "view_alerts":
			return { lead: "viewed", target: "alert settings" };
		case "manage_alerts":
			return { lead: "updated", target: "alert settings" };
		case "test":
			return { lead: "tested", target: resourcePhrase(row, ctx) };
		default:
			return { lead: row.action.replace(/_/g, " "), target: resourcePhrase(row, ctx) };
	}
}

export interface DescribedEvent {
	/** Who acted (bold) — name → username → email, else a short id. */
	actor: string;
	/** The plain connective between actor and target, e.g. "updated" / "was denied". */
	lead: string;
	/** The object of the action (bold), e.g. "alert settings" / "project my-api"; null if none. */
	target: string | null;
	denied: boolean;
	/** Secondary muted line: the actor email (when not already the label), or a deny reason. */
	detail: string | null;
}

/** Describes one Activity row as a feed entry split into bold-able segments. */
export function describeEvent(row: ActivityRow, ctx: ActivityContext): DescribedEvent {
	const actor =
		displayName({
			name: row.actorName,
			email: row.actorEmail,
			username: row.actorUsername,
		}) || `${row.actorId.slice(0, 8)}…`;
	const denied = !row.decision;
	const { lead, target } = denied
		? { lead: "was denied", target: deniedTarget(row, ctx) }
		: pastPredicate(row, ctx);
	const detail = denied
		? (row.reason ?? null)
		: row.actorEmail && row.actorEmail !== actor
			? row.actorEmail
			: null;
	return { actor, lead, target, denied, detail };
}

// ── Event-type taxonomy (filter) ────────────────────────────────────────────────

/** Category → the resource types it covers, with display labels. */
const CATEGORIES: { label: string; types: [string, string][] }[] = [
	{
		label: "Infrastructure",
		types: [
			["project", "Projects"],
			["runner", "Runners"],
			["job", "Jobs"],
			["fleet", "Fleet"],
		],
	},
	{
		label: "Identity & connectors",
		types: [
			["cloud_identity", "Cloud identities"],
			["connector", "Connectors"],
		],
	},
	{
		label: "Members & teams",
		types: [
			["member", "Members"],
			["invitation", "Invitations"],
			["team", "Teams"],
		],
	},
	{
		label: "Roles & access",
		types: [
			["role", "Roles"],
			["grant", "Grants"],
			["org", "Organization"],
		],
	},
	{ label: "Billing", types: [["billing", "Billing"]] },
	{ label: "Alerts", types: [["alert", "Alerts"]] },
	{ label: "Activity", types: [["activity", "Activity log"]] },
];

/** The grouped, namespaced options for the event-type filter sheet. Type tokens are
 *  `type:<resource>`; the trailing Result group uses `result:allow` / `result:deny`. */
export const EVENT_GROUPS: GroupedFilterGroup[] = [
	...CATEGORIES.map((c) => ({
		label: c.label,
		options: c.types.map(([value, label]) => ({ value: `type:${value}`, label })),
	})),
	{
		label: "Result",
		options: [
			{ value: "result:allow", label: "Allowed" },
			{ value: "result:deny", label: "Denied" },
		],
	},
];

