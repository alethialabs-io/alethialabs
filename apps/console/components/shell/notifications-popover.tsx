"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Bell, ClipboardList } from "lucide-react";
import Link from "next/link";
import { Button } from "@repo/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@repo/ui/popover";
import { useJobNotifications } from "@/hooks/use-job-notifications";
import { cn } from "@repo/ui/utils";

/**
 * Job notifications bell + popover for the sidebar profile bar. Derives its feed from the
 * jobs store via `useJobNotifications`; an unread dot rides the bell and the list links to
 * each job. Lifted from the legacy header chrome.
 */
export function NotificationsPopover() {
	const { notifications, unreadCount, markAsRead, markAllRead } =
		useJobNotifications();

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="relative h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
				>
					<Bell className="h-4 w-4" />
					{unreadCount > 0 && (
						<span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-foreground ring-2 ring-background" />
					)}
					<span className="sr-only">Notifications</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80 p-0" align="end" side="top">
				<div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
					<div>
						<p className="text-sm font-semibold text-foreground">Notifications</p>
						<p className="text-[11px] text-muted-foreground">
							{unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
						</p>
					</div>
					{unreadCount > 0 && (
						<button
							onClick={markAllRead}
							className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
						>
							Mark all read
						</button>
					)}
				</div>
				<div className="max-h-[320px] overflow-y-auto">
					{notifications.map((n) => (
						<Link
							key={n.id}
							href={`/dashboard/jobs/${n.jobId}`}
							onClick={() => markAsRead(n.id)}
						>
							<div
								className={cn(
									"flex items-center gap-3 border-b border-border/20 px-4 py-2.5 transition-colors hover:bg-muted/50",
									!n.read && "bg-muted/20",
								)}
							>
								<div
									className={cn(
										"shrink-0 rounded-md p-1",
										n.status === "FAILED" ? "bg-destructive/10" : "bg-muted",
									)}
								>
									<ClipboardList
										className={cn(
											"h-3.5 w-3.5",
											n.status === "FAILED"
												? "text-destructive"
												: n.status === "SUCCESS"
													? "text-foreground"
													: "text-muted-foreground",
										)}
									/>
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-xs font-medium text-foreground">
										{(n.jobType ?? "Job").replace("_", " ")} —{" "}
										{(n.status ?? "").toLowerCase()}
									</p>
									<p className="mt-0.5 text-[11px] text-muted-foreground">
										{new Date(n.createdAt).toLocaleTimeString()}
									</p>
								</div>
								{!n.read && (
									<span
										className={cn(
											"h-2 w-2 shrink-0 rounded-full",
											n.status === "FAILED"
												? "bg-destructive"
												: n.status === "SUCCESS"
													? "bg-foreground"
													: "bg-muted-foreground",
										)}
									/>
								)}
							</div>
						</Link>
					))}
					{notifications.length === 0 && (
						<div className="p-8 text-center text-sm text-muted-foreground">
							You&apos;re all caught up!
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
