// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's vocabulary: one word per concept, exported from one place (CON-SM9, #6760).
//
// A UI string that names one of these concepts imports the label from here instead of typing it.
// Typed per screen, the words drift: when this file was written the access grant builder offered
// "A cloud identity", the duplicate-project dialog sent the user to "Integrations" for one, and
// the preview settings wrote a bare "Default fabric". A user reading those is being told they
// are different things. No screen was changed by the unit that added this file.
//
// TWO VOCABULARIES MEET HERE, AND THEY ARE ALLOWED TO DIFFER IN EXACTLY ONE WAY. The docs
// glossary (`apps/docs/content/docs/reference/glossary.mdx`) is the source of truth for what each
// concept IS and for its precise term. The console uses the glossary's term for every concept
// but one: a connected cloud account is a **cloud identity** in the glossary and a **cloud
// account** in the console (decision CON-M3 — "identity" reads as jargon on the path a new user
// takes). Every row of `VOCABULARY` records the glossary term beside the console's, so that
// difference is written down once rather than rediscovered.
//
// WHAT ENFORCES THIS, AND WHAT DOES NOT. `tests/lib/copy/vocabulary.test.ts` holds the table to
// itself: no label is also a rejected word, exactly one row differs from its glossary term, and
// the three labels the jobs catalog (`lib/jobs/format.ts`) already prints are the ones here.
// Nothing in this unit reads the console's JSX for a rejected word — that is the vocabulary
// guard's unit (#6957) — and nothing reads the glossary to check a `glossary:` value below
// against it. Until something does, a renamed glossary term goes stale here silently.
//
// KEEP THIS FILE IMPORT-FREE AND TYPE-ERASABLE (no `enum`, no parameter properties). Node's type
// stripping can then load it as it stands, so a dependency-free script need not parse it as text.

/** The record a user designs, plans and deploys. */
export const PROJECT = { one: "project", many: "projects" } as const;

/**
 * A connected cloud account. The docs glossary's precise term is "cloud identity"; the console
 * says "cloud account" (CON-M3).
 */
export const CLOUD_ACCOUNT = { one: "cloud account", many: "cloud accounts" } as const;

/** A provider type in the catalog, and the page that lists them. Never a connected account. */
export const CONNECTOR = { one: "connector", many: "connectors", page: "Connectors" } as const;

/** The tenancy boundary. "Team" is only ever the Teams object inside an organization. */
export const ORGANIZATION = { one: "organization", many: "organizations" } as const;

/** The project's design surface: the page where its components are laid out and connected. */
export const ARCHITECTURE = "Architecture";

/** The in-console assistant. */
export const ASSISTANT = "Elench";

/**
 * The shared cluster layer. "Fabric" is not a word a new user arrives with, so the console never
 * prints the label without `definition` beside it (a description line, a tooltip, a help text).
 */
export const FABRIC = {
	label: "Fabric",
	definition: "The cluster, network and shared add-ons that one or more environments run on.",
} as const;

/** The three things a user queues against an environment. */
export const JOB_ACTION = { plan: "Plan", deploy: "Deploy", destroy: "Destroy" } as const;

/**
 * What an environment or a job is called while one of those is under way: waiting its turn, or
 * with a deploy or a destroy running. Keyed by the ACTION under way, like `JOB_ACTION`, and not by
 * a status value: which status values exist and how each one looks is `@repo/ui/status-badge`'s
 * to say, and `pnpm check:shared-surface` refuses a second table keyed on them.
 */
export const IN_FLIGHT = { queued: "Queued", deploy: "Deploying", destroy: "Destroying" } as const;

/** The two authentication verbs. */
export const AUTH = { signIn: "Sign in", signOut: "Sign out" } as const;

/** The label as it starts a sentence or stands alone: its first letter in upper case. */
export function sentenceStart(label: string): string {
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/** One row of the vocabulary: a concept, the console's words for it, and the words it rejects. */
export interface VocabularyRow {
	/** A stable key for the row. */
	id: string;
	/** What is being named, in plain words. */
	concept: string;
	/** Every form the console writes for this concept. */
	labels: readonly string[];
	/**
	 * The docs glossary's canonical term for the same concept, or `null` when the glossary defines
	 * no single term for it (the row is a set of labels, not an entry).
	 */
	glossary: string | null;
	/**
	 * Words the console does not use FOR THIS CONCEPT. Several are ordinary words with other,
	 * correct uses ("configuration", "team", "identity"), so a match is a question, not a verdict.
	 */
	not: readonly string[];
}

/** The whole vocabulary, one row per concept. */
export const VOCABULARY = [
	{
		id: "project",
		concept: "The record",
		labels: [PROJECT.one, PROJECT.many],
		glossary: "project",
		not: ["infrastructure", "configuration"],
	},
	{
		id: "cloud-account",
		concept: "A connected cloud account",
		labels: [CLOUD_ACCOUNT.one, CLOUD_ACCOUNT.many],
		glossary: "cloud identity",
		not: ["identity", "integration"],
	},
	{
		id: "connector",
		concept: "The catalog page and its types",
		labels: [CONNECTOR.one, CONNECTOR.many, CONNECTOR.page],
		glossary: "connector",
		not: ["Integrations"],
	},
	{
		id: "architecture",
		concept: "The design surface",
		labels: [ARCHITECTURE],
		glossary: "Architecture",
		not: ["canvas", "Open in Elench"],
	},
	{
		id: "assistant",
		concept: "The assistant",
		labels: [ASSISTANT],
		// The glossary heads this entry "Elench (assistant)" to tell it from the engine of the same name.
		glossary: "Elench",
		not: [],
	},
	{
		id: "job-action",
		concept: "Queue plan / apply / teardown",
		labels: [JOB_ACTION.plan, JOB_ACTION.deploy, JOB_ACTION.destroy],
		glossary: null,
		not: ["Apply", "Provision"],
	},
	{
		id: "in-flight",
		concept: "In-flight states",
		labels: [IN_FLIGHT.queued, IN_FLIGHT.deploy, IN_FLIGHT.destroy],
		glossary: null,
		not: ["Processing", "Provisioning"],
	},
	{
		id: "fabric",
		concept: "The shared cluster layer",
		labels: [FABRIC.label],
		glossary: "Fabric",
		not: ["fabric"],
	},
	{
		id: "auth",
		concept: "Auth verbs",
		labels: [AUTH.signIn, AUTH.signOut],
		glossary: null,
		not: ["Log in", "Log Out"],
	},
	{
		id: "tenancy",
		concept: "Tenancy",
		labels: [ORGANIZATION.one, ORGANIZATION.many],
		glossary: "organization",
		not: ["workspace", "team"],
	},
] as const satisfies readonly VocabularyRow[];
