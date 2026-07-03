// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LayoutGrid, List } from "lucide-react";
import { cn } from "./utils";

/** The two layouts a list of items can be rendered in. */
export type ViewMode = "card" | "table";

interface ViewToggleProps {
	value: ViewMode;
	onChange: (value: ViewMode) => void;
	className?: string;
}

const OPTIONS: { mode: ViewMode; label: string; Icon: typeof LayoutGrid }[] = [
	{ mode: "card", label: "Card view", Icon: LayoutGrid },
	{ mode: "table", label: "Table view", Icon: List },
];

/**
 * A compact segmented control for switching a collection between a card grid and
 * a table. Purely presentational — the caller owns the `ViewMode` state.
 */
export function ViewToggle({ value, onChange, className }: ViewToggleProps) {
	return (
		<div
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-muted/20 p-1",
				className,
			)}
			role="group"
			aria-label="View"
		>
			{OPTIONS.map(({ mode, label, Icon }) => {
				const active = value === mode;
				return (
					<button
						key={mode}
						type="button"
						onClick={() => onChange(mode)}
						aria-pressed={active}
						title={label}
						className={cn(
							"inline-flex size-7 items-center justify-center rounded transition-colors",
							active
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<Icon className="size-3.5" />
						<span className="sr-only">{label}</span>
					</button>
				);
			})}
		</div>
	);
}
