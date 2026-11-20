// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The revision a save produces, for `commitBaseline(revision)` (#6832).
//
// The workbench seeds the board under `<hash of the design>:<hash of the identity list>` and
// re-seeds it when that string moves. A save changes the design, so the server's next render
// carries a new revision — and a board that still remembers the old one takes its OWN save for
// somebody else's change and lays the design out afresh, discarding the arrangement. Recording the
// revision the save produced is what stops that.
//
// The design half is `designRevision` of what was sent; the identity half is unchanged by a save,
// so it is carried over from the seed.
//
// What this does NOT establish: that the design the server reads back hashes the same as the
// design that was sent. If the server normalises a value on the way in, the two differ, the next
// render is treated as a change, and the board behaves exactly as it did before this existed. A
// wrong guess costs nothing; a right one keeps the arrangement.

import { designRevision } from "@/lib/canvas/design-revision";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/**
 * The seed revision after saving `design`, given the revision the board was seeded under. Undefined
 * when the board was never seeded or its revision is not the workbench's two-part form: there is
 * then nothing sound to record.
 */
export function savedRevision(
	seedRevision: string | null | undefined,
	design: ProjectFormData,
): string | undefined {
	if (!seedRevision) return undefined;
	const at = seedRevision.lastIndexOf(":");
	if (at <= 0) return undefined;
	return `${designRevision(design)}${seedRevision.slice(at)}`;
}
