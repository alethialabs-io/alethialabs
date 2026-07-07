// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared visuals for the add-on marketplace: the lucide icon resolver (catalog data stays
// JSX-free, like the alerts catalog) and the ArgoCD health / install-status badges. Grayscale
// first — meaning is carried by icon + label; `destructive` is reserved for a failing state.

import {
	Archive,
	Boxes,
	CircleDashed,
	CircleCheck,
	CircleX,
	Database,
	Gauge,
	KeyRound,
	LineChart,
	Loader,
	Lock,
	Network,
	ScrollText,
	ShieldCheck,
	type LucideIcon,
} from "lucide-react";
import { Badge } from "@repo/ui/badge";
import type { AddOnIcon } from "@/lib/addons/types";
import type { ComponentStatus } from "@/lib/db/schema";

const ICONS: Record<AddOnIcon, LucideIcon> = {
	LineChart,
	ScrollText,
	ShieldCheck,
	KeyRound,
	Network,
	Boxes,
	Gauge,
	Archive,
	Database,
	Lock,
};

/** Renders an add-on's catalog icon. */
export function AddonIcon({
	icon,
	className,
}: {
	icon: AddOnIcon;
	className?: string;
}) {
	const Icon = ICONS[icon] ?? Boxes;
	return <Icon className={className} />;
}

/**
 * The install/health badge for an add-on. Prefers the live ArgoCD health once it's read back;
 * before the first deploy it shows the component status (PENDING → "Pending deploy").
 */
export function AddonStatusBadge({
	status,
	health,
}: {
	status: ComponentStatus;
	health: string | null;
}) {
	// Live ArgoCD health (after a deploy read it back).
	if (health && health !== "Unknown") {
		if (health === "Healthy") {
			return (
				<Badge variant="secondary" className="gap-1.5">
					<CircleCheck className="h-3.5 w-3.5" />
					Healthy
				</Badge>
			);
		}
		if (health === "Degraded" || health === "Missing") {
			return (
				<Badge variant="destructive" className="gap-1.5">
					<CircleX className="h-3.5 w-3.5" />
					{health}
				</Badge>
			);
		}
		return (
			<Badge variant="outline" className="gap-1.5">
				<Loader className="h-3.5 w-3.5" />
				{health}
			</Badge>
		);
	}

	// Pre-deploy: the persisted component status.
	if (status === "PENDING") {
		return (
			<Badge variant="outline" className="gap-1.5 text-muted-foreground">
				<CircleDashed className="h-3.5 w-3.5" />
				Pending deploy
			</Badge>
		);
	}
	if (status === "FAILED") {
		return (
			<Badge variant="destructive" className="gap-1.5">
				<CircleX className="h-3.5 w-3.5" />
				Failed
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="gap-1.5">
			<Loader className="h-3.5 w-3.5" />
			{status}
		</Badge>
	);
}
