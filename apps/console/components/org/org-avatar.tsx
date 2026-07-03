// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@repo/ui/utils";

/** Two-letter monogram from an organization name (e.g. "Acme Cloud" → "AC"). */
export function orgInitials(name: string): string {
	const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return "OR";
	return (
		(parts[0][0] ?? "") + (parts[1] ? parts[1][0] : (parts[0][1] ?? ""))
	)
		.toUpperCase()
		.padEnd(2, "R")
		.slice(0, 2);
}

interface OrgAvatarProps {
	name: string;
	/** Served logo URL (`/api/org/{id}/logo?v=…`), or null/undefined → monogram. */
	logo?: string | null;
	/** Pixel size of the square. */
	size?: number;
	className?: string;
}

/**
 * Organization avatar: the uploaded logo when set, otherwise a monogram on the ink
 * surface. Reused in onboarding, the org-switcher, and settings.
 */
export function OrgAvatar({ name, logo, size = 40, className }: OrgAvatarProps) {
	if (logo) {
		return (
			// Plain <img> (not next/image) — the source is our own /api serve route.
			// eslint-disable-next-line @next/next/no-img-element
			<img
				src={logo}
				alt={name}
				width={size}
				height={size}
				style={{ width: size, height: size }}
				className={cn("shrink-0 rounded-lg object-cover", className)}
			/>
		);
	}
	return (
		<div
			style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
			className={cn(
				"flex shrink-0 items-center justify-center rounded-lg bg-ink font-grotesk font-semibold tracking-[-0.02em] text-ink-foreground",
				className,
			)}
		>
			{orgInitials(name)}
		</div>
	);
}
