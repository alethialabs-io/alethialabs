// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org General page's fixed copy: the section titles, each row's label and hint, the Save
// bands' notes and the Danger zone's rows. The form (`org-general.tsx`) and its skeleton
// (`org-general-skeleton.tsx`) both render from here (#6352). A row's height is set by its label
// column, where a hint wraps at 200px to two or three lines, and a danger row's by its description,
// which wraps at 52ch — so the skeleton has to carry the same words to be the same height. Two
// copies of a hint would drift apart one edit at a time.

/** The section headings, top to bottom. */
export const ORG_GENERAL_SECTIONS = {
	profile: "Organization profile",
	defaults: "Defaults",
	danger: "Danger zone",
} as const;

/** The Organization profile panel's five rows and its Save band's note. */
export const ORG_PROFILE_ROWS = {
	logo: {
		label: "Logo",
		hint: "A square avatar, generated from the name until you upload one.",
	},
	name: {
		label: "Organization name",
		hint: "Shown across the console and in invitations.",
	},
	slug: {
		label: "Organization URL",
		hint: "The slug for your organization's URL.",
	},
	description: {
		label: "Description",
		hint: "Optional. A short line for teammates and audit context.",
	},
	address: {
		label: "Primary address",
		hint: "Set from billing checkout when you opt to reuse the billing address.",
	},
} as const;

/**
 * The fixed notes under two controls. The control column is under 200px wide in the two-column
 * layout, so a note can wrap to a second line, which makes the row taller than its label column.
 */
export const ORG_CONTROL_NOTES = {
	slug: "Lowercase, numbers and hyphens.",
	region: "Region migration requires a support request.",
} as const;

/** The note in the Organization profile panel's Save band. */
export const ORG_PROFILE_SAVE_NOTE = "Applies across the console";

/** The Defaults panel's three rows and its Save band's note. */
export const ORG_DEFAULTS_ROWS = {
	region: {
		label: "Data region",
		hint: "Residency for the control plane and Project state.",
	},
	defaultEnv: {
		label: "Default Project environment",
		hint: "Pre-selected stage for newly planted Projects.",
	},
	terraformVersion: {
		label: "Terraform version",
		hint: "Pinned across runners unless a Project overrides it.",
	},
} as const;

/** The note in the Defaults panel's Save band. */
export const ORG_DEFAULTS_SAVE_NOTE = "Applies to new resources only";

/**
 * The Danger zone's two rows. The delete row's description names the org between `before` and
 * `after`, so it is two strings around the name rather than one.
 */
export const ORG_DANGER_ROWS = {
	transfer: {
		title: "Transfer ownership",
		description:
			"Move this organization to another owner. They take over billing and the Owner role.",
	},
	delete: {
		title: "Delete organization",
		before: "Permanently delete",
		after:
			"and all its Projects. This destroys no cloud resources — run destroy first. Cannot be undone.",
	},
} as const;
