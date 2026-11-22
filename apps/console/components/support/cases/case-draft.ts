// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The unsent reply of one case, kept in this tab's session storage (G-26). The composer unmounts the
// moment the case is closed — by staff, while the customer is typing — and its text went with it.
// Now what was typed is kept per case and comes back when the composer does (the case reopened, the
// page reloaded). A per-viewer convenience: it never leaves this browser tab, and every read and
// write tolerates storage that is missing or refuses (a private window, blocked site data).

/** The storage key of `caseId`'s draft. */
function draftKey(caseId: string): string {
	return `alethia:support-case-draft:${caseId}`;
}

/** The kept draft of `caseId`, or "" when there is none or storage cannot be read. */
export function readCaseDraft(caseId: string): string {
	try {
		return window.sessionStorage.getItem(draftKey(caseId)) ?? "";
	} catch {
		return "";
	}
}

/** Keeps `body` as `caseId`'s draft; an empty or blank body removes it. */
export function writeCaseDraft(caseId: string, body: string): void {
	try {
		if (body.trim() === "") window.sessionStorage.removeItem(draftKey(caseId));
		else window.sessionStorage.setItem(draftKey(caseId), body);
	} catch {
		// Storage refused: the draft is simply not kept, as before.
	}
}
