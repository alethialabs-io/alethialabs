// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Why a board tool cannot be used right now (#6832). One sentence per reason, written once, so the
// toolbar, the add picker, the context menu and the command palette cannot give two answers to the
// same question.

/** Why nothing can be added while a bring-your-own IaC module governs the environment. */
export const GOVERNED_REASON =
	"A bring-your-own IaC module governs this environment, so its component design is not what gets deployed. Detach the module to add components.";

/** The same reason at the length of a picker row; the picker shows the full sentence once, above. */
export const GOVERNED_ROW_REASON = "Not while an IaC module governs this environment.";

/** Why the Connect tool is off when the selection is not exactly one service. */
export const CONNECT_NEEDS_SERVICE = "Select one service first. A connection starts from a service.";

/** Why Undo is off. */
export const NOTHING_TO_UNDO = "Nothing to undo";

/** Why Redo is off. */
export const NOTHING_TO_REDO = "Nothing to redo";

/**
 * Why Fit view is off on a board that draws nothing. The same sentence as `NOTHING_TO_FIT`
 * (`../use-has-drawn-nodes.ts`), which every other fit entry point shows; a test holds the two
 * equal. It is written again here because that module is replaced by a stub in the board's own
 * tests, and a constant read through a stub is not there to read.
 */
export const NOTHING_TO_FIT_REASON = "Nothing on the board to fit";

/** Why Tidy layout is off on a board that draws nothing. */
export const NOTHING_TO_TIDY = "Nothing on the board to tidy";

/** Why Run is off when the page has no environment to run a job on. */
export const NO_ENVIRONMENT = "No environment is selected, so there is nothing to run a job on.";

/** Why a kind the project's cloud cannot back is listed but cannot be added. */
export function notOnCloud(cloudName: string): string {
	return `Not available on ${cloudName}.`;
}
