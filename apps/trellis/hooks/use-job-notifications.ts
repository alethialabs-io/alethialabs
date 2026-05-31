"use client";

import { createClient } from "@/lib/supabase/client";
import { useCallback, useEffect, useRef, useState } from "react";

export interface JobNotification {
	id: string;
	jobId: string;
	jobType: string;
	status: string;
	vineId: string | null;
	createdAt: string;
	read: boolean;
}

const MAX_NOTIFICATIONS = 20;
const INTERESTING_STATUSES = new Set(["QUEUED", "PROCESSING", "SUCCESS", "FAILED"]);

/** Subscribes to realtime job events and tracks unread notifications. */
export function useJobNotifications() {
	const [notifications, setNotifications] = useState<JobNotification[]>([]);
	const [userId, setUserId] = useState<string | null>(null);
	const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);

	useEffect(() => {
		const supabase = createClient();
		supabase.auth.getUser().then(({ data: { user } }) => {
			if (user) setUserId(user.id);
		});
	}, []);

	useEffect(() => {
		if (!userId) return;

		const supabase = createClient();

		const addOrUpdateNotification = (job: Record<string, unknown>) => {
			if ((job.user_id as string) !== userId) return;
			if (!INTERESTING_STATUSES.has(job.status as string)) return;

			setNotifications((prev) => {
				const notification: JobNotification = {
					id: `${job.id}-${job.status}`,
					jobId: job.id as string,
					jobType: job.job_type as string,
					status: job.status as string,
					vineId: (job.vine_id as string) ?? null,
					createdAt: new Date().toISOString(),
					read: false,
				};

				const withoutOld = prev.filter((n) => n.jobId !== job.id);
				return [notification, ...withoutOld].slice(0, MAX_NOTIFICATIONS);
			});
		};

		const channel = supabase
			.channel("job-notifications")
			.on(
				"postgres_changes",
				{
					event: "INSERT",
					schema: "public",
					table: "provision_jobs",
				},
				(payload) => addOrUpdateNotification(payload.new as Record<string, unknown>),
			)
			.on(
				"postgres_changes",
				{
					event: "UPDATE",
					schema: "public",
					table: "provision_jobs",
				},
				(payload) => addOrUpdateNotification(payload.new as Record<string, unknown>),
			)
			.subscribe();

		channelRef.current = channel;

		return () => {
			supabase.removeChannel(channel);
		};
	}, [userId]);

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
