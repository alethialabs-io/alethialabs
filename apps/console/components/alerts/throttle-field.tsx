"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Notify at most once per …" control: common presets plus a custom value (minutes).
// Value is the policy `throttle_seconds` (0 = every event). Repeats of the same event
// subject within the window collapse into a single notification.

import { useId } from "react";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";

const PRESETS = [
	{ value: 0, label: "Every event" },
	{ value: 300, label: "5 minutes" },
	{ value: 900, label: "15 minutes" },
	{ value: 3600, label: "1 hour" },
	{ value: 21600, label: "6 hours" },
	{ value: 86400, label: "1 day" },
];
const MAX = 604_800; // 7 days (matches the schema cap)

interface ThrottleFieldProps {
	value: number;
	onChange: (seconds: number) => void;
}

/** Throttle/grouping window selector with a custom minutes option. */
export function ThrottleField({ value, onChange }: ThrottleFieldProps) {
	const id = useId();
	const isPreset = PRESETS.some((p) => p.value === value);
	const mode = isPreset ? String(value) : "custom";

	return (
		<div className="space-y-2">
			<Select
				value={mode}
				onValueChange={(v) => {
					if (v === "custom") onChange(value > 0 ? value : 600);
					else onChange(Number(v));
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{PRESETS.map((p) => (
						<SelectItem key={p.value} value={String(p.value)}>
							{p.label}
						</SelectItem>
					))}
					<SelectItem value="custom">Custom…</SelectItem>
				</SelectContent>
			</Select>
			{mode === "custom" && (
				<div className="flex items-center gap-2">
					<Input
						id={id}
						type="number"
						min={1}
						max={MAX / 60}
						value={Math.max(1, Math.round(value / 60))}
						onChange={(e) => {
							const mins = Math.min(
								MAX / 60,
								Math.max(1, Number(e.target.value) || 1),
							);
							onChange(mins * 60);
						}}
						className="w-24"
					/>
					<span className="text-muted-foreground text-sm">minutes</span>
				</div>
			)}
		</div>
	);
}
