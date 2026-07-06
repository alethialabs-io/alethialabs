// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared bits for the alert-policy surface (the policies-panel master-detail editor):
// the catalog-icon map and the routing option lists. Kept here so the rail, detail and
// any future policy UI stay in sync instead of each carrying their own copy.

import {
	Boxes,
	CircleDollarSign,
	Cpu,
	Fingerprint,
	KeyRound,
	LifeBuoy,
	LogIn,
	type LucideIcon,
	ShieldCheck,
	Users,
} from "lucide-react";
import type { CategoryIcon } from "@/lib/alerts/catalog";
import type { AlertSeverity } from "@/lib/db/schema/enums";

/** Resolves the catalog's JSX-free icon names to lucide components. */
export const CATEGORY_ICON: Record<CategoryIcon, LucideIcon> = {
	Boxes,
	ShieldCheck,
	KeyRound,
	Users,
	Fingerprint,
	CircleDollarSign,
	Cpu,
	LogIn,
	LifeBuoy,
};

/** Narrows a select value to a real severity (drops the "any" sentinel). */
export function isSeverity(v: string): v is AlertSeverity {
	return v === "info" || v === "warning" || v === "critical";
}

/** Dedup-window presets (seconds) for the policy throttle. */
export const THROTTLE_OPTIONS: { value: string; label: string }[] = [
	{ value: "0", label: "Every event" },
	{ value: "300", label: "At most every 5 min" },
	{ value: "3600", label: "At most every hour" },
	{ value: "21600", label: "At most every 6 hours" },
	{ value: "86400", label: "At most once a day" },
];

/** Minimum-severity filter presets ("any" maps to no filter). */
export const MIN_SEV_OPTIONS: { value: string; label: string }[] = [
	{ value: "any", label: "Any severity" },
	{ value: "info", label: "Info and above" },
	{ value: "warning", label: "Warning and above" },
	{ value: "critical", label: "Critical only" },
];
