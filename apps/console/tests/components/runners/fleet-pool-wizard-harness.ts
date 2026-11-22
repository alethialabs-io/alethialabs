// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The page around the warm-pool wizard, for its component tests: a query string held in a store (so
// the engine's `push` and `replace` re-render the sheet the way the router does) and a fixed
// signed-in viewer. A test replaces the engine's environment with this one:
//
//   vi.mock("@/lib/wizard/location", async () => {
//     const harness = await import("@/tests/components/runners/fleet-pool-wizard-harness");
//     return { useWizardEnvironment: harness.useTestWizardEnvironment };
//   });
//
// and calls `resetTestPage()` before each test, which also removes every stored wizard draft.
// The query string survives an unmount, which is what makes "render again" a reload.
//
// This module must not import the wizard's components: it is loaded from inside the mock of
// `@/lib/wizard/location`, which those components import.

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

/** One param of the page's query string. */
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
