"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import dynamic from "next/dynamic";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { useElenchThreads } from "./use-elench-threads";

/**
 * Fetch and evaluate the conversation's module graph — the chat transcript, the markdown and
 * code-highlighting stack, the tool renderers and their canvas previews.
 *
 * WHY THIS IS NOT A STATIC IMPORT (#5849). This surface is mounted in the app shell on every
 * private route, so a static import put that whole graph — about 150 modules, among them
 * streamdown, shiki, @xyflow/react, motion and @ai-sdk/react — in front of the first hydration of
 * EVERY page, while the surface renders nothing until someone opens the assistant. On a cold load
 * in CI, evaluating the shell's modules was one ~470 ms task, and React could neither hydrate nor
 * even listen for events until it ended: a click on a filter-bar control in that window was lost.
 * The store opens closed and is not persisted, so the server never renders a conversation and
 * loading it on the client changes no server HTML.
 */
function loadConversation() {
	return import("./elench-conversation").then((m) => m.ElenchConversation);
}

const ElenchConversation = dynamic(loadConversation, { ssr: false });

/**
 * Start loading the conversation before it is opened — called on the launcher's hover and focus,
 * so the first open does not wait for the chunk. Safe to call repeatedly: the module loader
 * caches the import.
 */
export function preloadElenchConversation(): void {
	void loadConversation();
}

/**
 * The single global Elench surface — mounted once in the app shell so the assistant is
 * available on every private route and survives navigation. Renders nothing when closed;
 * otherwise ONE `ElenchConversation` that owns the chrome (modal/panel) and swaps its body
 * between skeleton → landing → transcript in place. The chat lineage lives in the store's
 * `epoch` (not a React key), so new-chat / resume recreate only the transcript while the
 * chrome — and its open animation — stay put.
 */
export function ElenchSurface() {
	const open = useElenchStore((s) => s.open);
	const threadApi = useElenchThreads();

	if (!open) return null;

	return <ElenchConversation {...threadApi} />;
}
