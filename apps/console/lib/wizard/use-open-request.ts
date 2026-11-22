"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An overlay wizard that a parent can also ask for. The parent holds a boolean request (the canvas's
// "open the attach dialog"); the URL (`?wizard=<id>`) is what actually keeps the overlay open. This
// hook keeps the two in step, and the URL decides:
//   - a request that RISES while the URL is closed opens the URL (through `openUrl`, so the caller
//     can drop any one-shot param of its own in the same push);
//   - a URL that opens or closes on its own — Back, a link, the return from a git provider — is
//     reported through `onRequestedChange`, so the parent's request matches what is on screen.
// A request that stays up does not reopen a URL that was closed, and a URL that already matches the
// request is not reported.

import { useEffect, useRef } from "react";
import type { WizardOpener } from "@/lib/wizard/location";

/**
 * Keeps a parent's open request and an overlay wizard's URL in step; the URL decides. Runs after
 * every render and compares against what it saw on the previous one, so it reacts to edges only.
 */
export function useOpenRequest(
	requested: boolean,
	onRequestedChange: (open: boolean) => void,
	opener: WizardOpener,
	openUrl: () => void,
): void {
	const seen = useRef({ requested: false, url: false });
	useEffect(() => {
		const before = seen.current;
		seen.current = { requested, url: opener.open };
		if (requested && !before.requested && !opener.open) {
			openUrl();
			return;
		}
		if (opener.open !== before.url && opener.open !== requested) onRequestedChange(opener.open);
	});
}
