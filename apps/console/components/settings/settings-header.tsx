// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

interface SettingsHeaderProps {
	title: string;
	description?: string;
	/** Optional right-aligned action (e.g. an "Invite member" button). */
	action?: ReactNode;
}

/** Section page header — title + description, with an optional action slot. */
export function SettingsHeader({ title, description, action }: SettingsHeaderProps) {
	return (
		<div className="mb-8 flex items-start justify-between gap-4 border-b border-border/40 pb-5">
			<div className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight text-foreground">
					{title}
				</h1>
				{description && (
					<p className="text-sm text-muted-foreground">{description}</p>
				)}
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</div>
	);
}
