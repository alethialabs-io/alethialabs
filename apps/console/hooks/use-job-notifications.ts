"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useMemo } from "react";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import { useNotificationsStore } from "@/lib/stores/use-notifications-store";
import { NOTIFY_JOB_TYPES } from "@/lib/jobs/toast-copy";
import type {
	ProvisionJobStatus as PublicProvisionJobStatus,
	ProvisionJobType as PublicProvisionJobType,
} from "@/lib/db/schema";

/** A bell entry derived from a recent notifiable job. */
export interface JobNotification {
	jobId: string;
	jobType: PublicProvisionJobType;
	status: PublicProvisionJobStatus;
	projectName: string | null;
	environmentName: string | null;
	/** ISO timestamp of completion (terminal) or creation (in-flight). */
	createdAt: string;
	read: boolean;
}

const MAX_NOTIFICATIONS = 20;
const TERMINAL: ReadonlySet<PublicProvisionJobStatus> = new Set([
	"SUCCESS",
	"FAILED",
	"CANCELLED",
]);

/**
 * Derives the notifications-bell feed live from the shared jobs query plus the persisted
 * read-state store. Pure (no toasts — those live in `use-job-toasts.ts`) and stateless, so
 * the feed is always correct and survives navigation/reloads (the old hook kept an ephemeral
 * list that emptied on every remount). Unread = terminal jobs the user hasn't acknowledged.
 */
export function useJobNotifications() {
	const { data: jobs } = useJobsQuery();
	const readJobIds = useNotificationsStore((s) => s.readJobIds);
	const markRead = useNotificationsStore((s) => s.markRead);
	const markAllReadStore = useNotificationsStore((s) => s.markAllRead);

	const readSet = useMemo(() => new Set(readJobIds), [readJobIds]);

	const notifications = useMemo<JobNotification[]>(() => {
		// getJobs() already returns newest-first; take the most recent notifiable ones.
		return (jobs ?? [])
			.filter((j) => NOTIFY_JOB_TYPES.has(j.job_type))
			.slice(0, MAX_NOTIFICATIONS)
			.map((j) => {
				const ts = j.completed_at ?? j.created_at;
				return {
					jobId: j.id,
					jobType: j.job_type,
					status: j.status,
					projectName: j.project_name,
					environmentName: j.environment_name,
					createdAt: new Date(ts).toISOString(),
					read: readSet.has(j.id),
				};
			});
	}, [jobs, readSet]);

	const unreadCount = useMemo(
		() => notifications.filter((n) => TERMINAL.has(n.status) && !n.read).length,
		[notifications],
	);

	const markAsRead = useCallback(
		(jobId: string) => markRead(jobId),
		[markRead],
	);

	const markAllRead = useCallback(
		() => markAllReadStore(notifications.map((n) => n.jobId)),
		[markAllReadStore, notifications],
	);

	return { notifications, unreadCount, markAsRead, markAllRead };
}
