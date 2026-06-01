"use client";

import type {
	PublicWorkerStatus,
	PublicWorkerMode,
} from "@/lib/validations/db.schemas";

export const WORKER_STATUS_STYLES: Record<PublicWorkerStatus, string> = {
	ONLINE:
		"text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950",
	OFFLINE: "text-muted-foreground border-border bg-muted/50",
	DRAINING:
		"text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950",
};

export const WORKER_MODE_STYLES: Record<PublicWorkerMode, string> = {
	"cloud-hosted":
		"text-blue-600 border-blue-200 bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:bg-blue-950",
	"self-hosted": "text-muted-foreground border-border bg-muted/30",
};

export const STATUS_DOT_COLORS: Record<PublicWorkerStatus, string> = {
	ONLINE: "bg-emerald-500",
	OFFLINE: "bg-gray-400",
	DRAINING: "bg-amber-500",
};
