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
		const channel = supabase
			.channel("job-notifications")
			.on(
				"postgres_changes",
				{
					event: "INSERT",
					schema: "public",
					table: "provision_jobs",
					filter: `user_id=eq.${userId}`,
				},
				(payload) => {
					const job = payload.new as Record<string, unknown>;
					if (!INTERESTING_STATUSES.has(job.status as string)) return;

					setNotifications((prev) => {
						const notification: JobNotification = {
							id: `${job.id}-${job.status}`,
							jobId: job.id as string,
							jobType: job.job_type as string,
							status: job.status as string,
							vineId: (job.vine_id as string) ?? null,
							createdAt: (job.created_at as string) ?? new Date().toISOString(),
							read: false,
						};
						return [notification, ...prev].slice(0, MAX_NOTIFICATIONS);
					});
				},
			)
			.on(
				"postgres_changes",
				{
					event: "UPDATE",
					schema: "public",
					table: "provision_jobs",
					filter: `user_id=eq.${userId}`,
				},
				(payload) => {
					const job = payload.new as Record<string, unknown>;
					if (!INTERESTING_STATUSES.has(job.status as string)) return;

					setNotifications((prev) => {
						const existingIdx = prev.findIndex((n) => n.jobId === job.id);

						const notification: JobNotification = {
							id: `${job.id}-${job.status}`,
							jobId: job.id as string,
							jobType: job.job_type as string,
							status: job.status as string,
							vineId: (job.vine_id as string) ?? null,
							createdAt: new Date().toISOString(),
							read: false,
						};

						if (existingIdx >= 0) {
							const updated = [...prev];
							updated[existingIdx] = notification;
							return [notification, ...updated.filter((_, i) => i !== existingIdx)].slice(0, MAX_NOTIFICATIONS);
						}

						return [notification, ...prev].slice(0, MAX_NOTIFICATIONS);
					});
				},
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
