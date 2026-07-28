// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared userEvent interactions for the @repo/ui component tests.
//
// Lives here rather than being copied per file: `pasteQuery` started as a local helper in
// phone-input.test.tsx (#1452) and country-select.test.tsx now needs the identical thing. A four-line
// helper duplicated across sibling files is the same drift seed that let `has_closing_pr` diverge
// between two scripts with one copy carrying a broken regex — and the REASON for using it is the part
// worth writing once.

import type userEvent from "@testing-library/user-event";

/**
 * Enters a search query as ONE input event instead of one per character.
 *
 * `user.type` fires a keystroke at a time, and each keystroke re-runs cmdk's filter over the whole
 * option list and re-renders the matches. A paste drives that filter exactly once. What these tests
 * assert is the FILTERED RESULT, not per-character behaviour, so the cheaper input is also the
 * honest one.
 *
 * Deliberately contains NO RTL wait (`waitFor` / `findBy*`). tests/timeouts.test.ts enforces
 * MAX_SEQUENTIAL_WAITS by statically counting awaited waits inside each `it()` block; a wait hidden
 * in here would be invisible to that scan and make the count lie. Keep waits in the test body.
 */
export async function pasteQuery(
	user: ReturnType<typeof userEvent.setup>,
	box: HTMLElement,
	query: string,
): Promise<void> {
	await user.click(box);
	await user.paste(query);
}
