// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The consent screen's rules as data (AGT-L2, SPEC §5b), with no React, so each is a unit test away:
// which organization starts chosen, which permissions start ticked, what blocks Allow, what the
// button says, and the re-consent diff against the connection the person already has.
//
// None of this grants anything. The server action (`answerAgentConsent`) checks the org's kill switch
// and allow-list, what the role allows and which projects the person may use again on submit; the
// rules here only decide what the screen OFFERS, so that what is shown is exactly what can be granted.

import type { ConsentContext, ConsentOrg } from "@/lib/agents/consent-context";
import { AGENT_SCOPES, type AgentScope } from "@/lib/approvals/types";

/** One organization on the screen: the read's answer plus the role's display name. */
export interface ConsentOrgView extends ConsentOrg {
	/** The person's role there as people read it ("Admin", "Viewer", or a custom role's name). */
	roleLabel: string;
}

/** The ready half of the read, with display role names. */
export type ReadyConsent = Omit<Extract<ConsentContext, { state: "ready" }>, "orgs"> & { orgs: ConsentOrgView[] };

/** What the screen renders from: a request it cannot answer, or one ready to decide. */
export type ConsentView = Exclude<ConsentContext, { state: "ready" }> | ReadyConsent;

/** Above this many organizations the picker gets a search field and scrolls (SPEC §5b, case 2). */
export const MANY_ORGS = 5;

/** Above this many projects "Only these projects" gets a search field and scrolls (case 10). */
export const MANY_PROJECTS = 6;

/** The person's project choice: every project (present and future), or only the ones listed. */
export interface ProjectChoice {
	mode: "all" | "some";
	ids: string[];
}

/**
 * The organization that starts chosen: the first one that does not refuse the app, so the screen
 * opens on something the person can allow; the first one when every org refuses; null when none.
 */
export function defaultOrgId(orgs: readonly ConsentOrgView[]): string | null {
	return (orgs.find((o) => o.refusal === null) ?? orgs[0])?.id ?? null;
}

/**
 * The permissions that start ticked in `org`: every requested one the role can use, except Ask to
 * destroy, which the person opts into. Nothing starts ticked in an org that refuses the app.
 */
export function defaultScopes(org: ConsentOrgView | undefined): AgentScope[] {
	if (!org || org.refusal) return [];
	return org.grantable.filter((s) => s !== "destroy");
}

/**
 * The project choice that starts selected in `org`. A first connection starts on "All projects";
 * a re-consent starts on the projects the existing connection already has (those the person can
 * still see), so reconnecting never widens the projects without the person choosing it.
 */
export function defaultProjects(org: ConsentOrgView | undefined): ProjectChoice {
	const existing = org?.existing;
	if (!org || !existing || existing.projectIds === null) return { mode: "all", ids: [] };
	const visible = new Set(org.projects.map((p) => p.id));
	return { mode: "some", ids: existing.projectIds.filter((id) => visible.has(id)) };
}

/** The requested agent permissions, in the order the screen lists them. */
export function requestedRows(requested: readonly AgentScope[]): AgentScope[] {
	return AGENT_SCOPES.filter((s) => requested.includes(s));
}

/** True when `scope` can be ticked in `org`: requested, and the role there allows it. */
export function isOffered(org: ConsentOrgView, scope: AgentScope): boolean {
	return org.grantable.includes(scope);
}

/**
 * The ticked permissions that may actually be sent: only those offered in `org`. A tick left over
 * from another organization (whose role allowed more) never reaches the server.
 */
export function offeredChoice(org: ConsentOrgView, scopes: readonly AgentScope[]): AgentScope[] {
	return requestedRows(scopes.filter((s) => isOffered(org, s)));
}

/** A re-consent row's mark: the permission is new, is being removed, or is unchanged. */
export function reconsentMark(existing: ConsentOrg["existing"], ticked: boolean, scope: AgentScope): "new" | "removing" | null {
	if (!existing) return null;
	const had = existing.scopes.includes(scope);
	if (ticked && !had) return "new";
	if (!ticked && had) return "removing";
	return null;
}

/** The re-consent diff ("What changes"). */
export interface ConsentChanges {
	adds: AgentScope[];
	removes: AgentScope[];
	/** Whether the projects stay as they are, and what they will be. */
	projects: { same: boolean; label: string };
}

/** The projects as a phrase: "all projects", or the chosen projects' names. */
function projectsPhrase(choice: ProjectChoice | null, projects: readonly { id: string; name: string }[]): string {
	if (!choice || choice.mode === "all") return "all projects";
	const names = new Map(projects.map((p) => [p.id, p.name]));
	return choice.ids.map((id) => names.get(id) ?? id).join(", ");
}

/** The existing grant's projects as a choice, for comparing against the person's. */
function existingChoice(existing: NonNullable<ConsentOrg["existing"]>): ProjectChoice {
	return existing.projectIds === null ? { mode: "all", ids: [] } : { mode: "some", ids: existing.projectIds };
}

/** True when two project choices grant the same projects. */
function sameProjects(a: ProjectChoice, b: ProjectChoice): boolean {
	if (a.mode !== b.mode) return false;
	if (a.mode === "all") return true;
	const left = new Set(a.ids);
	return a.ids.length === b.ids.length && b.ids.every((id) => left.has(id)) && left.size === new Set(b.ids).size;
}

/** What allowing would change against `existing`; null for a first connection. */
export function consentChanges(
	org: ConsentOrgView,
	scopes: readonly AgentScope[],
	projects: ProjectChoice,
): ConsentChanges | null {
	const existing = org.existing;
	if (!existing) return null;
	const chosen = offeredChoice(org, scopes);
	return {
		adds: chosen.filter((s) => !existing.scopes.includes(s)),
		removes: requestedRows(existing.scopes.filter((s) => !chosen.includes(s))),
		projects: { same: sameProjects(existingChoice(existing), projects), label: projectsPhrase(projects, org.projects) },
	};
}

/** The existing grant's projects as a phrase ("Currently: …"). */
export function existingProjectsPhrase(org: ConsentOrgView): string {
	return org.existing ? projectsPhrase(existingChoice(org.existing), org.projects) : "";
}

/** Why Allow is disabled, or none. Deny is always available. */
export interface AllowBlockers {
	/** The chosen org refuses the app (kill switch off, or not on its allow-list). */
	refused: boolean;
	/** Nothing is ticked: "Choose at least one, or deny." */
	noneTicked: boolean;
	/** "Only these projects" with none chosen: "Choose at least one project, or allow all." */
	noProject: boolean;
	/** No organization is chosen. */
	noOrg: boolean;
}

/** What blocks Allow for the person's current choices. */
export function allowBlockers(org: ConsentOrgView | undefined, scopes: readonly AgentScope[], projects: ProjectChoice): AllowBlockers {
	if (!org) return { refused: false, noneTicked: false, noProject: false, noOrg: true };
	const refused = org.refusal !== null;
	return {
		refused,
		noneTicked: !refused && offeredChoice(org, scopes).length === 0,
		noProject: !refused && org.projects.length > 0 && projects.mode === "some" && projects.ids.length === 0,
		noOrg: false,
	};
}

/** True when any blocker holds. */
export function isAllowBlocked(b: AllowBlockers): boolean {
	return b.refused || b.noneTicked || b.noProject || b.noOrg;
}

/** The Allow button's words. */
export function allowLabel(o: { verified: boolean; reconsent: boolean; submitting: boolean }): string {
	if (o.submitting) return "Allowing…";
	if (!o.verified) return "Allow unverified app";
	if (o.reconsent) return "Update connection";
	return "Allow";
}

/** "a", "a and b", "a, b and c". */
export function joinWithAnd(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The signed-query marker parameters Better Auth adds (`@better-auth/oauth-provider`, signed-query.ts). */
const SIGNED_PARAM_NAMES = "ba_param";

/**
 * The query string to hand back to Better Auth on submit, from the page's search params: the
 * parameters it signed and the signature, nothing else — the same selection its own browser client
 * makes (`buildSignedOAuthQuery`). A query that does not list its signed parameters is passed whole.
 * Better Auth canonicalises the order before checking the signature, so the order here is free.
 */
export function signedOAuthQuery(searchParams: Readonly<Record<string, string | string[] | undefined>>): string {
	const all = new URLSearchParams();
	for (const [key, value] of Object.entries(searchParams)) {
		if (value === undefined) continue;
		for (const v of Array.isArray(value) ? value : [value]) all.append(key, v);
	}
	const signed = new Set(all.getAll(SIGNED_PARAM_NAMES));
	if (signed.size === 0) return all.toString();
	const out = new URLSearchParams();
	for (const [key, value] of all.entries()) {
		if (key === "sig" || key === SIGNED_PARAM_NAMES || signed.has(key)) out.append(key, value);
	}
	return out.toString();
}
