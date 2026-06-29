"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useJobsQuery } from "@/lib/query/use-jobs-query";
import type {
	ProvisionJobStatus as PublicProvisionJobStatus,
	ProvisionJobType as PublicProvisionJobType,
} from "@/lib/db/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface JobNotification {
	id: string;
	jobId: string;
	jobType: PublicProvisionJobType;
	status: PublicProvisionJobStatus;
	vineId: string | null;
	createdAt: string;
	read: boolean;
}

const MAX_NOTIFICATIONS = 20;

/** Derives notifications from the shared jobs query and fires toasts on terminal status changes. */
export function useJobNotifications() {
	const { data: jobs } = useJobsQuery();
	const [notifications, setNotifications] = useState<JobNotification[]>([]);
	const prevStatusRef = useRef<Map<string, PublicProvisionJobStatus>>(new Map());
	const mountedAtRef = useRef<number>(Date.now());
	const seededRef = useRef(false);

	// Diff each jobs snapshot against the last to detect status transitions. The first
	// non-empty snapshot only seeds the baseline so we never toast for jobs that were
	// already terminal before this hook mounted.
	useEffect(() => {
		const list = jobs ?? [];

		if (!seededRef.current) {
			for (const job of list) {
				prevStatusRef.current.set(job.id, job.status);
			}
			if (list.length > 0) {
				seededRef.current = true;
			}
			return;
		}

		for (const job of list) {
			const prevStatus = prevStatusRef.current.get(job.id);

			if (prevStatus === job.status) continue;

			prevStatusRef.current.set(job.id, job.status);

			const isNew = prevStatus === undefined;
			const isTerminal = job.status === "SUCCESS" || job.status === "FAILED";

			if (isNew && !isTerminal) continue;

			if (isNew && isTerminal) {
				const jobCreatedAt = job.created_at ? new Date(job.created_at).getTime() : 0;
				if (jobCreatedAt < mountedAtRef.current) continue;
			}

			const jobTypeLabel = (job.job_type ?? "Job").replace(/_/g, " ");

			setNotifications((prev) => {
				const notification: JobNotification = {
					id: `${job.id}-${job.status}`,
					jobId: job.id,
					jobType: job.job_type,
					status: job.status,
					vineId: job.project_id,
					createdAt: new Date().toISOString(),
					read: false,
				};
				const withoutOld = prev.filter((n) => n.jobId !== job.id);
				return [notification, ...withoutOld].slice(0, MAX_NOTIFICATIONS);
			});

			if (isTerminal) {
				const toastFn = job.status === "SUCCESS" ? toast.success : toast.error;
				toastFn(
					`${jobTypeLabel} — ${job.status === "SUCCESS" ? "Completed" : "Failed"}`,
					{
						description: job.status === "FAILED"
							? "Job failed. Click to see details."
							: "Job completed successfully.",
						duration: 5000,
						action: {
							label: "View Job",
							onClick: () => { window.location.href = `/dashboard/jobs/${job.id}`; },
						},
						cancel: {
							label: "Dismiss",
							onClick: () => {},
						},
					},
				);
			}
		}
	}, [jobs]);

	const unreadCount = notifications.filter((n) => !n.read).length;

	const markAsRead = useCallback((notificationId: string) => {
		setNotifications((prev) =>
			prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n)),
		);
	}, []);

	const markAllRead = useCallback(() => {
		setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
	}, []);

	return { notifications, unreadCount, markAsRead, markAllRead };
}
