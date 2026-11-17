"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/*
 * The presentational half of a multi-step form: the step rail, the footer, the "advanced" block,
 * the step heading and the two notices every wizard shows.
 *
 * NO ROUTER AND NO STORAGE, on purpose. Which step is current, what a draft holds and where a
 * step lives in the URL are decided by an engine in the app (the console's `lib/wizard/`); this
 * file only draws what it is told. That split is what lets a second app reuse the look without
 * inheriting the console's URL rules.
 *
 * What each piece guarantees, because each guarantee replaced a hand-rolled variant that did not:
 *   - `Stepper` is a `<nav>` holding an ORDERED list, marks the current item with
 *     `aria-current="step"`, and says every item's state in text as well as in a marker.
 *   - `WizardFooter` keeps Back and the primary action in fixed slots (the row never moves when
 *     Back disappears), mounts a DIFFERENT button node for "next" and "submit", and cancels the
 *     click's default action before calling the handler — so the press that advances to the last
 *     step can never also activate the button that the last step puts in the same place.
 *   - `WizardDisclosure` is open whenever a field inside it has an error, whatever the user did
 *     with it earlier, and its content stays mounted while closed so a form keeps the values.
 *   - `WizardStepHeading` takes focus when the step changes and announces the new position
 *     politely; it does neither on first paint.
 */

import { Check, ChevronDown, CircleAlert } from "lucide-react";
import * as React from "react";

import { Button } from "./button";
import { DisabledReason } from "./disabled-reason";
import { SectionHeading } from "./section-heading";
import { Spinner } from "./spinner";
import { cn } from "./utils";

/** Where one step stands relative to the user's progress. */
export type StepState = "done" | "current" | "todo" | "invalid";

/** One entry of the step rail. */
export interface StepperItem {
	readonly id: string;
	readonly label: string;
	readonly state: StepState;
}

/** Props of `Stepper`. */
export interface StepperProps {
	/** Names the `<nav>`, e.g. "Add a warm pool". */
	readonly label: string;
	readonly items: readonly StepperItem[];
	/** Called with a step's id. Only "done" and "invalid" items are buttons. */
	readonly onSelect?: (id: string) => void;
}

/** The state of a step, in words — read by a screen reader and never shown. */
const STATE_TEXT: Record<StepState, string> = {
	done: "Completed",
	current: "Current step",
	todo: "Not started",
	invalid: "Needs attention",
};

/** Whether a step in this state can be jumped to from the rail. */
function isSelectable(state: StepState): boolean {
	return state === "done" || state === "invalid";
}

/** The round marker in front of a step's label: a tick, a warning, or the step's number. */
function StepMarker({ state, position }: { state: StepState; position: number }) {
	return (
		<span
			aria-hidden="true"
			data-slot="stepper-marker"
			className={cn(
				"flex size-5 flex-none items-center justify-center rounded-full font-mono text-ui-2xs",
				state === "done" && "bg-foreground text-background",
				state === "current" && "border border-foreground text-foreground",
				state === "todo" && "border border-border text-muted-foreground",
				state === "invalid" && "border border-destructive text-destructive",
			)}
		>
			{state === "done" ? (
				<Check className="size-3" />
			) : state === "invalid" ? (
				<CircleAlert className="size-3" />
			) : (
				position
			)}
		</span>
	);
}

/**
 * The step rail of a wizard: an ordered list inside a named `<nav>`. Completed and invalid steps
 * are buttons when `onSelect` is given; the current and the not-yet-reached steps never are.
 */
export function Stepper({ label, items, onSelect }: StepperProps) {
	return (
		<nav aria-label={label} data-slot="stepper">
			<ol className="flex items-center gap-1.5">
				{items.map((item, index) => {
					const body = (
						<>
							<StepMarker state={item.state} position={index + 1} />
							<span
								className={cn(
									"truncate text-ui-sm",
									item.state === "current"
										? "font-medium text-foreground"
										: "text-muted-foreground",
								)}
							>
								{item.label}
							</span>
							<span className="sr-only">{STATE_TEXT[item.state]}</span>
						</>
					);
					return (
						<li
							key={item.id}
							data-state={item.state}
							aria-current={item.state === "current" ? "step" : undefined}
							className="flex min-w-0 flex-1 items-center"
						>
							{onSelect !== undefined && isSelectable(item.state) ? (
								<button
									type="button"
									onClick={() => onSelect(item.id)}
									className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								>
									{body}
								</button>
							) : (
								<span className="flex min-w-0 items-center gap-1.5">{body}</span>
							)}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

/** Props of `WizardFooter`. */
export interface WizardFooterProps {
	/** Goes one step back. `null` keeps the slot empty; the row never moves. */
	readonly back: (() => void) | null;
	readonly primary: {
		readonly kind: "next" | "submit";
		readonly label: string;
		readonly onPress: () => void;
	};
	/** True while the step's work is in flight: both buttons are disabled and the primary spins. */
	readonly pending: boolean;
	/** Why the primary action cannot be used right now. Said to pointer, keyboard and screen reader. */
	readonly disabledReason?: string;
}

/**
 * The button row of a wizard step. Back sits in a slot that stays when Back is absent. The
 * primary button is keyed by its kind, so "next" and "submit" are different DOM nodes, and its
 * click is cancelled before the handler runs.
 */
export function WizardFooter({ back, primary, pending, disabledReason }: WizardFooterProps) {
	return (
		<div data-slot="wizard-footer" className="flex items-center justify-between gap-2">
			<div data-slot="wizard-footer-back" className="flex min-w-0 items-center">
				{back === null ? null : (
					<Button type="button" variant="outline" disabled={pending} onClick={back}>
						Back
					</Button>
				)}
			</div>
			<DisabledReason reason={disabledReason}>
				<Button
					key={primary.kind}
					type="button"
					data-kind={primary.kind}
					disabled={pending}
					onClick={(event) => {
						event.preventDefault();
						primary.onPress();
					}}
				>
					{pending ? <Spinner /> : null}
					{primary.label}
				</Button>
			</DisabledReason>
		</div>
	);
}

/** Props of `WizardDisclosure`. */
export interface WizardDisclosureProps {
	readonly label: string;
	/** True while a field inside has an error: the block is open and cannot be closed. */
	readonly forceOpen: boolean;
	readonly children: React.ReactNode;
}

/**
 * A collapsible block for a step's optional fields. It opens itself while `forceOpen` is true, and
 * stays open once the user has put focus inside it, so fixing the field that forced it open does
 * not fold the block away under the cursor. The content is hidden, not unmounted, while closed.
 */
export function WizardDisclosure({ label, forceOpen, children }: WizardDisclosureProps) {
	const [userOpen, setUserOpen] = React.useState(false);
	const panelId = React.useId();
	const open = forceOpen || userOpen;
	return (
		<div data-slot="wizard-disclosure" data-state={open ? "open" : "closed"}>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setUserOpen(!open)}
				className="flex items-center gap-1.5 rounded-sm text-ui-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ChevronDown
					aria-hidden="true"
					className={cn("size-3.5 transition-transform", open ? "" : "-rotate-90")}
				/>
				{label}
			</button>
			<div
				id={panelId}
				data-slot="wizard-disclosure-panel"
				hidden={!open}
				onFocus={() => setUserOpen(true)}
				className="mt-3"
			>
				{children}
			</div>
		</div>
	);
}

/** Props of `WizardStepHeading`. */
export interface WizardStepHeadingProps {
	/** The step's name. */
	readonly title: string;
	/** The step's 1-based position among the steps shown. */
	readonly position: number;
	/** How many steps are shown. */
	readonly total: number;
	/** One line of supporting copy under the heading. */
	readonly description?: string;
	/** The heading's outline level. */
	readonly level?: 2 | 3 | 4 | 5 | 6;
}

/**
 * The heading of the step on screen. When the step changes it takes focus and a polite live
 * region says "Step 2 of 5: Placement". On first paint it does neither: a page that has just
 * loaded has not changed step.
 */
export function WizardStepHeading({
	title,
	position,
	total,
	description,
	level,
}: WizardStepHeadingProps) {
	const headingRef = React.useRef<HTMLDivElement>(null);
	const shown = React.useRef<string | null>(null);
	const stepKey = `${position}/${total}:${title}`;
	React.useEffect(() => {
		if (shown.current !== null && shown.current !== stepKey) headingRef.current?.focus();
		shown.current = stepKey;
	}, [stepKey]);
	return (
		<div data-slot="wizard-step-heading">
			<SectionHeading
				ref={headingRef}
				tabIndex={-1}
				title={title}
				description={description}
				level={level}
				className="outline-none"
			/>
			<p role="status" aria-live="polite" className="sr-only">
				{`Step ${position} of ${total}: ${title}`}
			</p>
		</div>
	);
}

/** Props of `WizardRestoredNotice`. */
export interface WizardRestoredNoticeProps {
	/** Drops the restored values and starts the wizard again. */
	readonly onStartOver: () => void;
}

/** The line a wizard shows when it filled itself in from a saved draft. */
export function WizardRestoredNotice({ onStartOver }: WizardRestoredNoticeProps) {
	return (
		<p data-slot="wizard-restored-notice" role="status" className="text-ui-sm text-muted-foreground">
			Restored your draft ·{" "}
			<button
				type="button"
				onClick={onStartOver}
				className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				Start over
			</button>
		</p>
	);
}

/** Props of `WizardFormError`. */
export interface WizardFormErrorProps {
	/** A problem that belongs to no field on screen. `null` renders nothing. */
	readonly message: string | null;
}

/** A wizard-level error, announced as an alert. */
export function WizardFormError({ message }: WizardFormErrorProps) {
	if (message === null) return null;
	return (
		<p data-slot="wizard-form-error" role="alert" className="text-ui-sm text-destructive">
			{message}
		</p>
	);
}
