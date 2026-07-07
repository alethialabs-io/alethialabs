"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	elenchConversationKey,
	useElenchStore,
} from "@/lib/stores/use-elench-store";
import { ElenchConversation } from "./elench-conversation";
import { useElenchThreads } from "./use-elench-threads";

/**
 * The single global Elench surface — mounted once in the app shell so the assistant
 * is available on every private route and survives navigation. Renders nothing when
 * closed; otherwise the one keyed conversation (which internally chooses modal vs
 * panel chrome). The conversation key excludes `view`, so minimize/maximize never
 * remount the chat.
 */
export function ElenchSurface() {
	const open = useElenchStore((s) => s.open);
	const ctx = useElenchStore((s) => s.ctx);
	const threadId = useElenchStore((s) => s.threadId);
	const epoch = useElenchStore((s) => s.epoch);
	const { ready, ...threadApi } = useElenchThreads();

	// Wait for the initial thread to resolve before mounting the keyed conversation. This
	// makes the conversation mount exactly once (with the resumed thread already staged),
	// eliminating the open→resume remount that flashed an empty chat before the thread loaded.
	if (!open || !ready) return null;

	return (
		<ElenchConversation
			key={elenchConversationKey(ctx, threadId, epoch)}
			{...threadApi}
		/>
	);
}
