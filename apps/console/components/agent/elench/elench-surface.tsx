"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useElenchStore } from "@/lib/stores/use-elench-store";
import { ElenchConversation } from "./elench-conversation";
import { useElenchThreads } from "./use-elench-threads";

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
