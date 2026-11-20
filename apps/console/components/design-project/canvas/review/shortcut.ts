// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's "Review plan" key, as a row of the console's one shortcut registry
// (`lib/shortcuts/registry.ts`). The bar answers it with `useShortcut`; a shortcut list renders it
// from the same row. There is no listener here.
//
// It is not allowed while typing: ⌘↵ in a text field belongs to the field (the assistant's
// composer sends on it). Nothing is bound to Deploy, on purpose.

import { registerShortcuts } from "@/lib/shortcuts/registry";

/** Open the review-and-deploy view. */
export const SHORTCUT_REVIEW_PLAN = "canvas.review-plan";

registerShortcuts([
	{
		id: SHORTCUT_REVIEW_PLAN,
		chord: { key: "enter", mod: true, shift: false },
		scope: "canvas",
		label: "Review plan",
	},
]);
