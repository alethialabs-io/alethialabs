"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Ref } from "react";
import { cn } from "@repo/ui/utils";

/**
 * The card's box — padding, border, gap and the two text lines' type. The route's loading form draws
 * these cards with `RadioCardSkeleton` (`components/support/radio-card.tsx`), whose box is the same
 * set of tokens; `support-route-skeletons.test.tsx` holds the two to it, so the swap from placeholder
 * to card moves nothing (#6354). `relative` is the only addition: it contains the hidden input.
 */
const CARD = "relative flex w-full flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left";
const LABEL = "text-sm font-medium leading-none";
const DESCRIPTION = "text-sm";

/** One option of a {@link ChoiceCards} group. */
export interface ChoiceOption<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly description?: string;
}

interface ChoiceCardsProps<T extends string> {
	/** The group's accessible name, e.g. "Case type". */
	label: string;
	/** The radio inputs' shared `name`; also prefixes their ids. */
	name: string;
	options: readonly ChoiceOption<T>[];
	/** The chosen value, or `undefined` while nothing is chosen. */
	value: T | undefined;
	onChange: (value: T) => void;
	/** Given the input that takes focus for the group: the chosen one, else the first. */
	inputRef?: Ref<HTMLInputElement>;
	/** True while the group's field has an error. */
	invalid?: boolean;
	/** The id of the line carrying the group's validation message. */
	describedBy?: string;
	/** The group's layout (its grid). */
	className?: string;
}

/**
 * A single choice drawn as cards: a `radiogroup` of native radio inputs, each inside its card's
 * label (G-19). Native radios give the group what independent pressed buttons never had — one tab
 * stop, arrow keys to move the choice, and "radio, 2 of 4, checked" read by a screen reader. The
 * input is visually hidden; the card shows its state and its focus ring.
 */
export function ChoiceCards<T extends string>({
	label,
	name,
	options,
	value,
	onChange,
	inputRef,
	invalid,
	describedBy,
	className,
}: ChoiceCardsProps<T>) {
	const focusTarget = options.some((option) => option.value === value) ? value : options[0]?.value;
	return (
		<div
			role="radiogroup"
			aria-label={label}
			aria-invalid={invalid ? true : undefined}
			aria-describedby={describedBy}
			className={className}
		>
			{options.map((option) => {
				const id = `${name}-${option.value}`;
				const checked = option.value === value;
				return (
					<label
						key={option.value}
						htmlFor={id}
						data-slot="choice-card"
						data-state={checked ? "checked" : "unchecked"}
						className={cn(
							CARD,
							"cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
							checked
								? "border-foreground bg-muted"
								: "border-border hover:border-foreground/30 hover:bg-muted/40",
						)}
					>
						<input
							id={id}
							type="radio"
							name={name}
							value={option.value}
							checked={checked}
							onChange={() => onChange(option.value)}
							ref={option.value === focusTarget ? inputRef : undefined}
							aria-labelledby={`${id}-label`}
							aria-describedby={option.description ? `${id}-description` : undefined}
							className="sr-only"
						/>
						<span id={`${id}-label`} className={LABEL}>
							{option.label}
						</span>
						{option.description ? (
							<span id={`${id}-description`} className={cn(DESCRIPTION, "text-muted-foreground")}>
								{option.description}
							</span>
						) : null}
					</label>
				);
			})}
		</div>
	);
}
