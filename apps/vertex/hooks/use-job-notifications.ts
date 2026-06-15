"use client";

import { useJobsStore } from "@/lib/stores/use-jobs-store";
import type { PublicProvisionJobStatus, PublicProvisionJobType } from "@/lib/validations/db.schemas";
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

/** Derives notifications from the jobs store and fires toasts on terminal status changes. */
export function useJobNotifications() {
	const [notifications, setNotifications] = useState<JobNotification[]>([]);
	const prevStatusRef = useRef<Map<string, PublicProvisionJobStatus>>(new Map());
	const mountedAtRef = useRef<number>(Date.now());
	const seededRef = useRef(false);

	useEffect(() => {
		const unsub = useJobsStore.subscribe((state) => {
			if (!seededRef.current) {
				for (const job of state.jobs) {
					prevStatusRef.current.set(job.id, job.status);
				}
				if (state.jobs.length > 0) {
					seededRef.current = true;
				}
				return;
			}

			for (const job of state.jobs) {
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

				const jobTypeLabel = job.job_type.replace(/_/g, " ");

				setNotifications((prev) => {
					const notification: JobNotification = {
						id: `${job.id}-${job.status}`,
						jobId: job.id,
						jobType: job.job_type,
						status: job.status,
						vineId: job.vine_id,
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
		});

		return unsub;
	}, []);

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
