"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useMemo } from "react";
import { notificationFeed } from "@/hooks/use-job-notifications";
import { useSupportCasesQuery } from "@/lib/query/use-support-cases-query";
import { isSupportAcked, useNotificationsStore } from "@/lib/stores/use-notifications-store";
import type {
	SupportAuthorType,
	SupportCaseStatus,
} from "@/lib/db/schema/enums";

/** A bell entry derived from a recent support case with activity. */
export interface SupportNotification {
	caseId: string;
	caseNumber: number;
	subject: string;
	status: SupportCaseStatus;
	lastAuthorType: SupportAuthorType;
	/** ISO timestamp of the case's most recent message. */
	lastMessageAt: string;
	read: boolean;
}

const MAX_NOTIFICATIONS = 20;

/**
 * Derives the support half of the notifications-bell feed live from the shared support-cases
 * query plus the persisted read-state store — the mirror of `useJobNotifications`. Pure (no
 * toasts — those live in `use-support-toasts.ts`) and stateless, so it survives navigation and
 * reloads. A case is unread when the server watermark says so (`unread`) AND the user hasn't
 * locally acknowledged its NEWEST message in this browser; local acks let the bell clear instantly
 * on click without waiting for the server watermark round-trip, and an ack covers only the
 * messages that existed when it was made, so a later staff reply is unread again (G-08). Capped to
 * the most-recent cases.
 */
export function useSupportNotifications() {
	const casesQuery = useSupportCasesQuery();
	const cases = casesQuery.data;
	const supportAcks = useNotificationsStore((s) => s.supportAcks);
	const markSupportRead = useNotificationsStore((s) => s.markSupportRead);
	const markAllSupportRead = useNotificationsStore((s) => s.markAllSupportRead);

	const notifications = useMemo<SupportNotification[]>(() => {
		return (cases ?? [])
			.slice()
			.sort(
				(a, b) =>
					new Date(b.last_message_at).getTime() -
					new Date(a.last_message_at).getTime(),
			)
			.slice(0, MAX_NOTIFICATIONS)
			.map((c) => {
				const lastMessageAt = new Date(c.last_message_at).toISOString();
				return {
					caseId: c.id,
					caseNumber: c.case_number,
					subject: c.subject,
					status: c.status,
					lastAuthorType: c.last_author_type,
					lastMessageAt,
					// Read when the server watermark is caught up, OR the user acked this newest message.
					read: !c.unread || isSupportAcked(supportAcks, c.id, lastMessageAt),
				};
			});
	}, [cases, supportAcks]);

	const unreadCount = useMemo(
		() => notifications.filter((n) => !n.read).length,
		[notifications],
	);

	/** Acknowledges one case up to the newest message the bell shows for it. */
	const markAsRead = useCallback(
		(caseId: string) => {
			const shown = notifications.find((n) => n.caseId === caseId);
			if (shown) markSupportRead({ caseId, lastMessageAt: shown.lastMessageAt });
		},
		[markSupportRead, notifications],
	);

	/** Acknowledges every case the bell shows, each up to its newest message. */
	const markAllRead = useCallback(
		() =>
			markAllSupportRead(
				notifications.map((n) => ({ caseId: n.caseId, lastMessageAt: n.lastMessageAt })),
			),
		[markAllSupportRead, notifications],
	);

	return {
		notifications,
		unreadCount,
		markAsRead,
		markAllRead,
		feed: notificationFeed(casesQuery),
	};
}
