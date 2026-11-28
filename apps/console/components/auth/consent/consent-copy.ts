// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The consent screen's words, verbatim from the signed-off design (docs/design/agt-l2/SPEC.md §5b and
// the prototype's consent surface). One place, so a test can hold the screen to the spec and a copy
// change is one diff. What each permission is called comes from the connected-agents board's
// `SCOPE_WORDS`, which carries "the consent screen's words" for the Manage sheet — one wording for
// both, so the screen that grants a permission and the sheet that shows it agree.

import type { AgentScope } from "@/lib/approvals/scopes";

export { SCOPE_WORDS } from "@/components/settings/connected/connected-agents-board";

/** The eyebrow over every heading on the screen. */
export const EYEBROW = "Connect an app";

/** The eyebrow once the person has allowed. */
export const EYEBROW_CONNECTED = "Connected";

/** The verb each permission stands for, in "Your role … can't {verb}" (SPEC §5b, case 8). */
export const SCOPE_VERB_WORD: Readonly<Record<AgentScope, string>> = {
	read: "view",
	design: "edit",
	plan: "plan",
	apply: "deploy",
	destroy: "destroy",
};

/** Every sentence the screen says, keyed by where it appears. */
export const COPY = {
	title: (app: string) => `Let ${app} work in Alethia?`,
	lede: "It will act as you and never do more than you can.",
	switchAccount: "Not you? Switch account",

	verifiedBy: "Verified by",
	verifiedBySuffix: ", which publishes this app's identity.",
	nameGivenByApp: "name given by the app",
	unverified: "Alethia couldn't confirm who publishes this app.",
	unverifiedRedirect: "After you allow, you'll be sent to",
	unverifiedAlertTitle: "Only allow apps you set up yourself",
	unverifiedAlertBody: "If you didn't just start connecting an app, deny this request.",

	orgLegend: "Organization",
	orgSearchLabel: "Search organizations",
	orgSearchPlaceholder: (n: number) => `Search your ${n} organizations`,
	orgNoMatch: "No organization matches.",
	orgHint: (app: string) => `${app} can only see the one you choose. Connect again to use another.`,
	yourRole: (role: string) => `Your role: ${role}`,
	notAllowed: "Not allowed",
	personalLabel: "Where it works",
	personalTitle: "Your personal workspace",
	personalBody: (app: string) => `You aren't in an organization. ${app} works in your personal workspace.`,

	offTitle: (org: string) => `Agents are turned off in ${org}`,
	offBody: (org: string) =>
		`Someone who manages agents in ${org} has turned agent access off. Choose another organization, or ask them.`,
	notAllowedTitle: (org: string, app: string) => `${org} doesn't allow ${app}`,
	notAllowedBody: (org: string, app: string) =>
		`${org} only lets approved apps act as agents. Choose another organization, or ask someone who manages agents in ${org} to add ${app}.`,
	noProdTitle: (org: string) => `${org} keeps agents off production`,
	noProdBody: (app: string) => `${app} can plan production environments, but only a person can deploy or destroy them.`,
	reconsentTitle: (app: string, org: string, date: string) => `You connected ${app} to ${org} on ${date}`,
	reconsentBody: "Allowing replaces that connection with the choices below. Changes are marked.",

	scopesLegend: (app: string) => `${app} asked to`,
	roleCant: (org: string, role: string, verb: string) => `Your role in ${org} (${role}) can't ${verb}, so this isn't offered.`,
	noneTicked: "Choose at least one, or deny.",
	untickHint: "Untick anything you don't want to allow.",
	markNew: "New",
	markRemoving: "Removing",

	unknownTitle: "Not offered by Alethia",
	unknownBody: (app: string) => `${app} also asked for`,
	unknownSuffix: (many: boolean) =>
		many ? ". Alethia has no such permissions, so they won't be granted." : ". Alethia has no such permission, so it won't be granted.",

	projectsLegend: "Projects",
	allProjects: "All projects",
	allProjectsWhy: "Including projects created later.",
	someProjects: "Only these projects",
	projectSearchLabel: "Search projects",
	projectSearchPlaceholder: (n: number) => `Search ${n} projects`,
	projectsChosen: (n: number, names: string) => `${n} chosen: ${names}`,
	noneChosenYet: "None chosen yet.",
	noProjects: (org: string, app: string) => `${org} has no projects yet. ${app} will see the ones you create.`,
	noProjectsPersonal: "Your workspace",
	noProject: "Choose at least one project, or allow all.",
	currently: (projects: string) => `Currently: ${projects}.`,
	noChange: "No change.",

	changesLabel: "What changes",
	adds: "Adds",
	removes: "Removes",
	projectsStay: (projects: string) => `Projects stay: ${projects}`,
	projectsChange: (projects: string) => `Projects change to: ${projects}`,

	nameAndEmail: (app: string) => `${app} also gets your name and email, and stays connected until you disconnect it in`,
	nameAndEmailWhere: "Settings → Connected agents",

	networkTitle: "Couldn't reach Alethia",
	networkBody: "Nothing was granted. Check your connection and try again.",

	deny: "Deny",
	close: "Close this page",
	// Browsers ignore `window.close()` in a tab no script opened, so there the button is replaced by
	// this sentence (maintainer ruling on #7866, item 8).
	closeTab: "You can close this tab now.",
	back: "Back",
	setupGuide: "Setup guide",
} as const;

/** The message pages: the states with nothing to decide (SPEC §5b, cases 13, 14, 17–21). */
export const MESSAGES = {
	none: {
		title: "Nothing to connect",
		body: "This page opens when an app such as Claude Code or Cursor asks to connect to Alethia. Start from that app to continue.",
	},
	expired: {
		title: "This request has expired",
		body: "Connection requests are valid for a few minutes. Go back to the app and connect again.",
	},
	answered: {
		title: "This request was already answered",
		body: "Someone already allowed or denied this request, maybe in another tab. Go back to the app; if it isn't connected, connect again from there.",
	},
	// G17's shared wording, for a request whose signature or shape did not check out — the spec names
	// the heading; the body is the expired state's instruction, which is what the person must do.
	invalid: {
		title: "This request is no longer valid",
		body: "Go back to the app and connect again.",
	},
	noScopes: (app: string) => ({
		title: `${app} didn't ask for any Alethia permissions`,
		body: "It only asked to know who you are, which isn't enough to work in Alethia. Deny this, and check the app's setup guide.",
	}),
	switchAccount: (app: string) => ({
		title: "Sign in with another account",
		body: `You'll come straight back here to finish connecting ${app}. Nothing has been granted yet.`,
		action: "Sign in with another account",
	}),
	denied: (app: string) => ({
		title: `You denied ${app}`,
		body: `${app} was told no and has no access to Alethia. You can close this page.`,
	}),
	allowed: (app: string, org: string) => ({
		title: `Returning to ${app}…`,
		body: `${app} can now work in ${org} with the permissions you chose. If nothing happens in a few seconds, go back to ${app} yourself.`,
		ret: `Return to ${app}`,
		manage: "Manage connections",
	}),
} as const;
