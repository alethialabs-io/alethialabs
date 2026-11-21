// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas page around the two BYO wizards, for their component tests: a query string held in a
// store (so the engine's `push` and `replace` re-render the dialog the way the router does) and a
// fixed signed-in viewer. A test replaces the engine's environment with this one, keeping the rest
// of the module:
//
//   vi.mock("@/lib/wizard/location", async (importOriginal) => {
//     const harness = await import("@/tests/components/design-project/byo/byo-wizard-harness");
//     return { ...(await importOriginal()), useWizardEnvironment: harness.useTestWizardEnvironment };
//   });
//
// and calls `resetTestPage()` before each test, which also removes every stored wizard draft.
// The query string survives an unmount, which is what makes "render again" a reload — or the
// return from a git provider, which comes back to the same URL.
//
// This module must not import the dialogs: it is loaded from inside the mock of
// `@/lib/wizard/location`, which they import.

import { useSyncExternalStore } from "react";
import { applyParamPatch } from "@/lib/query/view-url-params";
import { clearAllWizardDrafts } from "@/lib/wizard/draft";
import type { WizardEnvironment } from "@/lib/wizard/types";

/** The signed-in viewer every test runs as. */
export const TEST_VIEWER = "user-1";

let search = "";
const listeners = new Set<() => void>();

/** Replaces the page's query string and re-renders whatever reads it. */
export function setTestSearch(next: string): void {
	search = next;
	for (const listener of listeners) listener();
}

/** The page's query string as it stands. */
export function testSearch(): string {
	return search;
}

/** One param of the page's query string, or `null`. */
export function testParam(name: string): string | null {
	return new URLSearchParams(search).get(name);
}

/** A clean page: no query string, no stored draft. */
export function resetTestPage(): void {
	setTestSearch("");
	clearAllWizardDrafts();
}

/** Subscribes to query-string changes. */
function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The wizard engine's environment on the test page. */
export function useTestWizardEnvironment(): WizardEnvironment {
	const current = useSyncExternalStore(subscribe, testSearch, testSearch);
	return {
		location: {
			read: (name) => new URLSearchParams(current).get(name),
			push: (patch) => setTestSearch(applyParamPatch(search, patch)),
			replace: (patch) => setTestSearch(applyParamPatch(search, patch)),
			leave: () => undefined,
		},
		viewerId: TEST_VIEWER,
	};
}
