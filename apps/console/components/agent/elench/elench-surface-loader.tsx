"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import dynamic from "next/dynamic";
import { useState } from "react";
import { useElenchStore } from "@/lib/stores/use-elench-store";

/**
 * Fetch and evaluate the Elench surface and everything under it — the conversation, the chat
 * transcript, the markdown and code-highlighting stack, the tool renderers and their canvas
 * previews.
 */
function loadSurface() {
	return import("./elench-surface").then((m) => m.ElenchSurface);
}

const ElenchSurface = dynamic(loadSurface, { ssr: false });

/**
 * Start loading the surface before it is opened — called on the launcher's hover and focus, so
 * the first open does not wait for the chunk. Safe to call repeatedly: the module loader caches
 * the import.
 */
export function preloadElenchSurface(): void {
	void loadSurface();
}

/**
 * The app shell's mount point for the Elench surface: nothing until the assistant is first opened,
 * then the surface, kept mounted from then on.
 *
 * WHY THE SHELL DOES NOT IMPORT THE SURFACE (#5849). The shell is on every private route, so a
 * static import put the surface's whole graph — about 150 modules, among them streamdown, shiki,
 * @xyflow/react, motion and @ai-sdk/react — in front of the first hydration of EVERY page, while
 * the surface renders nothing until someone opens the assistant. On a cold load in CI, evaluating
 * the shell's modules was one 378–480 ms task, and until it ended React could neither hydrate nor
 * listen for a click: a click on a filter-bar control in that window was lost (release-gate run
 * 37917147461). The store opens closed and is not persisted, so the server never rendered a
 * surface, and loading it on the client changes no server HTML.
 *
 * THE LATCH. The surface used to be mounted from the start and simply render `null` while closed.
 * Its thread hook does nothing while closed (its load effect is gated on `open`, and closing resets
 * it), so mounting it at first open is the same surface; keeping it mounted after that keeps every
 * later open exactly as it was.
 */
export function ElenchSurfaceLoader() {
	const open = useElenchStore((s) => s.open);
	const [wanted, setWanted] = useState(open);
	if (open && !wanted) setWanted(true);
	return wanted ? <ElenchSurface /> : null;
}
