// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org General page's fixed copy: the section titles, each row's label and hint, the Save
// band's note and the Danger zone's rows. The form (`org-general.tsx`) and its skeleton
// (`org-general-skeleton.tsx`) both render from here (#6352). A row's height depends on how its
// hint wraps — at 200px beside the control from the panel's 32rem container step, at the panel's
// full width stacked above the control below it (#6135) — and a danger row's on its description,
// which wraps at 52ch. Either way the skeleton has to carry the same words to be the same height.
// Two copies of a hint would drift apart one edit at a time.

/** The section headings, top to bottom. */
export const ORG_GENERAL_SECTIONS = {
	profile: "Organization profile",
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
 * The fixed note under the slug control. Where the row is side by side in a narrow panel (just
 * above the 32rem container step, in the two-column layout) the control column can be under 200px
 * wide, so the note can wrap to a second line, which makes the row taller than its label column.
 */
export const ORG_CONTROL_NOTES = {
	slug: "Lowercase, numbers and hyphens.",
} as const;

/** The note in the Organization profile panel's Save band. */
export const ORG_PROFILE_SAVE_NOTE = "Applies across the console";

/** The Save band's note while the profile has edits that are not saved (R6 E-17), as Preview's says. */
export const ORG_PROFILE_UNSAVED_NOTE = "You have unsaved changes";


/**
 * The Danger zone's three rows. The delete row's description names the org between `before` and
 * `after`, so it is two strings around the name rather than one. It says what the delete does NOT
 * do (destroy anything in the cloud) and what the server therefore refuses (`deleteOrganization`
 * answers `conflict` while an environment is live or in flight, #6752). The leave row states the
 * rule the auth route applies to `/organization/leave`: the org's last active owner cannot leave
 * (#5472, #7204).
 */
export const ORG_DANGER_ROWS = {
	transfer: {
		title: "Transfer ownership",
		description:
			"Move this organization to another owner. They take over billing and the Owner role.",
	},
	leave: {
		title: "Leave organization",
		description:
			"Remove yourself from this organization. You lose access to its Projects until someone invites you again. Its only active owner cannot leave.",
	},
	delete: {
		title: "Delete organization",
		before: "Permanently delete",
		after:
			"and all its Projects. Deleting destroys no cloud resources, so it is refused while any environment is live or in flight — destroy those first. Cannot be undone.",
	},
} as const;
