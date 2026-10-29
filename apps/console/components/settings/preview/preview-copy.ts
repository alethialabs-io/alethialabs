// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Preview environments section's fixed copy: the section title, each row's label and hint, and
// the Save band's note. The form (`preview-settings.tsx`) and its skeleton
// (`preview-settings-skeleton.tsx`) both render from here. A row's height is set by its label
// column, and a 200px hint column wraps to two or three lines, so the skeleton has to carry the same
// words to be the same height. Two copies of a hint would drift apart one edit at a time.

/** The section heading over the form. */
export const PREVIEW_SECTION_TITLE = "Preview environments";

/** The note in the Save band. */
export const PREVIEW_SAVE_NOTE = "Saved changes apply on the next preview reconciliation";

/** The form's four rows, top to bottom. */
export const PREVIEW_ROWS = {
	enable: {
		label: "Enable",
		hint: "Saved settings render the pull request preview generator.",
	},
	source: {
		label: "Source",
		hint: "The repository whose pull requests create preview environments.",
	},
	placement: {
		label: "Placement",
		hint: "How each pull request is isolated on the selected fabric.",
	},
	credentials: {
		label: "Credentials",
		hint: "Optional ArgoCD credential for polling private repositories.",
	},
} as const;
