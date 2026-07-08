"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChatSkeleton } from "@/components/agent/chat-skeleton";
import {
	elenchConversationKey,
	useElenchStore,
} from "@/lib/stores/use-elench-store";
import { ElenchConversation } from "./elench-conversation";
import { ElenchErrorBoundary } from "./elench-error-boundary";
import { ElenchModal } from "./elench-modal";
import { ElenchPanel } from "./elench-panel";
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
	const view = useElenchStore((s) => s.view);
	const ctx = useElenchStore((s) => s.ctx);
	const threadId = useElenchStore((s) => s.threadId);
	const epoch = useElenchStore((s) => s.epoch);
	const close = useElenchStore((s) => s.close);
	const { ready, ...threadApi } = useElenchThreads();

	if (!open) return null;

	const isOrg = ctx.kind === "org";

	// While the initial thread list → resume/create resolves, show the chrome with a
	// loading skeleton (not a blank overlay) — then mount the keyed conversation exactly
	// once, with the resumed thread already staged, so there's no open→resume flash.
	if (!ready) {
		return view === "modal" ? (
			<ElenchModal
				isOrg={isOrg}
				threads={threadApi.threads}
				activeId={threadApi.activeId}
				isEmpty={false}
				title="Loading…"
				onSelectThread={threadApi.selectThread}
				onNewChat={threadApi.newChat}
				onDeleteThread={threadApi.deleteThread}
			>
				<ChatSkeleton className="mx-auto w-full max-w-[720px]" />
			</ElenchModal>
		) : (
			<ElenchPanel
				isOrg={isOrg}
				threads={threadApi.threads}
				activeId={threadApi.activeId}
				onSelectThread={threadApi.selectThread}
				onNewChat={threadApi.newChat}
			>
				<ChatSkeleton />
			</ElenchPanel>
		);
	}

	// Key the boundary by the conversation lineage so a fresh conversation clears any
	// prior render error instead of staying stuck on the fallback.
	const key = elenchConversationKey(ctx, threadId, epoch);
	return (
		<ElenchErrorBoundary key={key} onReset={close}>
			<ElenchConversation {...threadApi} />
		</ElenchErrorBoundary>
	);
}
