// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Central public status for the name, mark, and downloadable brand kit. */
export const BRAND_STATUS = {
	name: "Alethia",
	markName: "Bracketed point",
	state: "interim",
	label: "Interim asset · clearance in progress",
	downloadsEnabled: false,
	note: "The name and mark are being reviewed for trademark clearance. They may be displayed in Alethia-owned surfaces, but third-party reuse and registration are not authorized yet.",
} as const;
