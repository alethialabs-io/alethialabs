"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useFormContext } from "react-hook-form";

import { cn } from "@repo/ui/utils";

import type { CreateProjectValues } from "./create-project.wizard";
import { SOURCE_GRID_CLASS, SOURCE_OPTION_CLASS, type SourceOption } from "./source-options";

/**
 * "Start from" — the starting points as one native radio group: arrow keys move between them, the
 * group has a name, and the checked one is said in text by the browser, not only by a border.
 */
export function SourceField({ options }: { options: readonly SourceOption[] }) {
	const { register, watch } = useFormContext<CreateProjectValues>();
	const selected = watch("source");
	return (
		<fieldset>
			<legend className="sr-only">Start from</legend>
			<div className={SOURCE_GRID_CLASS}>
				{options.map((option) => {
					const Icon = option.icon;
					const checked = selected === option.value;
					return (
						<label
							key={option.value}
							className={cn(
								SOURCE_OPTION_CLASS,
								"cursor-pointer transition-colors hover:border-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
								checked && "border-foreground",
							)}
						>
							<input
								type="radio"
								value={option.value}
								className="sr-only"
								aria-label={option.title}
								aria-describedby={`source-${option.value}-description`}
								{...register("source")}
							/>
							<Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0">
								<span className="block text-ui-sm font-medium text-foreground">{option.title}</span>
								<span
									id={`source-${option.value}-description`}
									className="mt-0.5 block text-ui-xs text-muted-foreground"
								>
									{option.description}
								</span>
							</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}
