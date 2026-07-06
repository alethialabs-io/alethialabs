"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useMemo } from "react";
import { useSupportCasesQuery } from "@/lib/query/use-support-cases-query";
import { useNotificationsStore } from "@/lib/stores/use-notifications-store";
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
 * locally acknowledged it in this browser; local acks let the bell clear instantly on click
 * without waiting for the server watermark round-trip. Capped to the most-recent cases.
 */
export function useSupportNotifications() {
	const { data: cases } = useSupportCasesQuery();
	const readSupportCaseIds = useNotificationsStore((s) => s.readSupportCaseIds);
	const markSupportRead = useNotificationsStore((s) => s.markSupportRead);
	const markAllSupportRead = useNotificationsStore((s) => s.markAllSupportRead);

	const readSet = useMemo(
		() => new Set(readSupportCaseIds),
		[readSupportCaseIds],
	);

	const notifications = useMemo<SupportNotification[]>(() => {
		return (cases ?? [])
			.slice()
			.sort(
				(a, b) =>
					new Date(b.last_message_at).getTime() -
					new Date(a.last_message_at).getTime(),
			)
			.slice(0, MAX_NOTIFICATIONS)
			.map((c) => ({
				caseId: c.id,
				caseNumber: c.case_number,
				subject: c.subject,
				status: c.status,
				lastAuthorType: c.last_author_type,
				lastMessageAt: new Date(c.last_message_at).toISOString(),
				// Read when the server watermark is caught up, OR the user acked it locally.
				read: !c.unread || readSet.has(c.id),
			}));
	}, [cases, readSet]);

	const unreadCount = useMemo(
		() => notifications.filter((n) => !n.read).length,
		[notifications],
	);

	const markAsRead = useCallback(
		(caseId: string) => markSupportRead(caseId),
		[markSupportRead],
	);

	const markAllRead = useCallback(
		() => markAllSupportRead(notifications.map((n) => n.caseId)),
		[markAllSupportRead, notifications],
	);

	return { notifications, unreadCount, markAsRead, markAllRead };
}
