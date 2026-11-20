"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE frame every inspector subject is drawn in (#6834).
//
// The rail used to host six cards, and each had drawn its own top: a node had an editable name and
// a status strip, the environment had a title and a paragraph, a chart workload had a dashed icon
// and a Save bar, a collection had a count chip. Selecting a different thing therefore changed
// where the name was, where the state was, where the close control was and whether there was a
// commit button at all.
//
// Here the answer to each of those is fixed, in this order, for every subject:
//
//   back crumb     only when the subject was reached from another one
//   identity       icon · kind · name (editable where the design owns the name) · one-line summary
//   primary action at most one, beside the close control
//   status         one badge and one sentence
//   tabs           only when the subject has more than one view
//   messages       ONE place: what is staged, and what went wrong
//   body           scrolls on its own
//
// There is no footer and no commit button. A field edit is staged in the document the moment it
// is committed; the changes bar is where staged work is reviewed and applied.

import { ArrowLeft, X } from "lucide-react";
import { createContext, useContext, useId, type ReactNode } from "react";
import { Alert, AlertDescription } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { SectionHeading } from "@repo/ui/section-heading";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { cn } from "@repo/ui/utils";
import type { InspectorTab } from "@/lib/canvas/store/types";

/** What each inspector tab is called. One table, so two subjects cannot name one tab two ways. */
export const INSPECTOR_TAB_LABEL: Record<InspectorTab, string> = {
	configure: "Settings",
	connections: "Connections",
	status: "Status",
	sources: "Sources",
	activity: "Activity",
};

/** An editable name in the frame's identity row. */
export interface InspectorName {
	value: string;
	onChange: (next: string) => void;
	mono?: boolean;
	maxLength?: number;
	placeholder?: string;
}

/** The frame's status row: one badge, one sentence, and at most one overlay chip. */
export interface InspectorStatus {
	label: string;
	tier: StatusTier;
	/** The most useful sentence for this state: the first issue, a failure, what to do next. */
	message?: string;
	/** An overlay riding on the state (drift), drawn at the end of the row. */
	detail?: ReactNode;
}

/** Where the crumb above the identity row leads back to. */
export interface InspectorBack {
	label: string;
	onClick: () => void;
}

export interface InspectorFrameProps {
	/** A 16px icon for the leading plate. */
	icon?: ReactNode;
	/** Draw the plate dashed: the design does not own this thing (a chart's workload, a module). */
	external?: boolean;
	/** The kind, in the small uppercase label above the name. */
	eyebrow?: ReactNode;
	/** What this is called. Drawn as the frame's heading unless `name` makes it editable. */
	title: ReactNode;
	/** Makes the name editable. `title` is then not drawn. */
	name?: InspectorName;
	/** One line under the name: what this currently is. */
	summary?: ReactNode;
	status?: InspectorStatus | null;
	/** The subject's primary action. One control. */
	action?: ReactNode;
	back?: InspectorBack | null;
	/** The subject's views. A tab bar is drawn only when there is more than one. */
	tabs?: readonly InspectorTab[];
	tab?: InspectorTab;
	onTabChange?: (tab: InspectorTab) => void;
	/** What went wrong, said in the frame's one message place. */
	error?: string | null;
	/** What is staged or otherwise worth knowing, said in the same place, above an error. */
	notice?: ReactNode;
	onClose: () => void;
	className?: string;
	bodyClassName?: string;
	children: ReactNode;
}

const EmbedContext = createContext(false);

/**
 * Marks its children as drawn INSIDE a frame that is already on screen. A card built on
 * `SheetCard` then draws a section rather than a second header and a second close control.
 */
export function InspectorEmbed({ children }: { children: ReactNode }) {
	return <EmbedContext.Provider value={true}>{children}</EmbedContext.Provider>;
}

/** True under an {@link InspectorEmbed}. */
export function useInspectorEmbedded(): boolean {
	return useContext(EmbedContext);
}

/** The inspector's frame. See the file header for what goes where. */
export function InspectorFrame({
	icon,
	external = false,
	eyebrow,
	title,
	name,
	summary,
	status,
	action,
	back,
	tabs,
	tab,
	onTabChange,
	error,
	notice,
	onClose,
	className,
	bodyClassName,
	children,
}: InspectorFrameProps) {
	const views = tabs ?? [];
	const tabbed = views.length > 1 && tab !== undefined;
	const body = cn("min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-4", bodyClassName);

	const messages =
		notice || error ? (
			<div className="shrink-0 space-y-2 border-b border-border px-4 py-3" data-slot="inspector-messages">
				{notice ? (
					<div role="status" className="text-ui-sm text-muted-foreground">
						{notice}
					</div>
				) : null}
				{error ? (
					<Alert variant="destructive" role="alert">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
			</div>
		) : null;

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)} data-slot="inspector-frame">
			{back ? (
				<button
					type="button"
					onClick={back.onClick}
					className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
				>
					<ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
					{back.label}
				</button>
			) : null}

			<div className="flex shrink-0 items-start gap-3 border-b border-border p-4">
				{icon ? (
					<span
						className={cn(
							"mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-none border text-muted-foreground",
							external && "border-dashed",
						)}
						aria-hidden="true"
					>
						{icon}
					</span>
				) : null}
				<div className="min-w-0 flex-1 space-y-1">
					{eyebrow ? <span className="vx-eyebrow block">{eyebrow}</span> : null}
					{name ? (
						<>
							<Input
								aria-label="Name"
								value={name.value}
								maxLength={name.maxLength}
								placeholder={name.placeholder}
								onChange={(e) => name.onChange(e.target.value)}
								className={cn(
									"h-8 border-0 bg-transparent px-0 text-base font-semibold shadow-none focus-visible:ring-0",
									name.mono && "font-mono",
								)}
							/>
							{summary ? (
								<p className="truncate text-ui-md text-text-tertiary">{summary}</p>
							) : null}
						</>
					) : (
						<SectionHeading level={2} title={title} description={summary} />
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{action}
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-7 w-7"
						onClick={onClose}
						aria-label="Close"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
			</div>

			{status ? (
				<div className="flex shrink-0 items-center gap-2.5 border-b border-border bg-surface-sunken px-4 py-2.5">
					<StatusBadge status={status.label} tier={status.tier} className="shrink-0" />
					<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={status.message}>
						{status.message ?? ""}
					</span>
					{status.detail}
				</div>
			) : null}

			{tabbed ? (
				<Tabs
					value={tab}
					onValueChange={(next) => {
						const view = views.find((v) => v === next);
						if (view) onTabChange?.(view);
					}}
					className="flex min-h-0 flex-1 flex-col gap-0"
				>
					<TabsList className="mx-4 my-3 flex w-auto shrink-0">
						{views.map((view) => (
							<TabsTrigger key={view} value={view}>
								{INSPECTOR_TAB_LABEL[view]}
							</TabsTrigger>
						))}
					</TabsList>
					{messages}
					<TabsContent value={tab} className={body}>
						{children}
					</TabsContent>
				</Tabs>
			) : (
				<>
					{messages}
					<div className={body}>{children}</div>
				</>
			)}
		</div>
	);
}

/**
 * The frame's primary action: one button. Given a `disabledReason` it stays focusable and
 * announces why it does nothing, instead of going dead.
 */
export function InspectorAction({
	label,
	icon,
	onClick,
	disabledReason,
	variant = "outline",
}: {
	label: string;
	icon?: ReactNode;
	onClick: () => void;
	/** Why the action cannot run now. Set, the button is `aria-disabled` and says this instead. */
	disabledReason?: string | null;
	variant?: "outline" | "ghost" | "destructive";
}) {
	const reasonId = useId();
	const disabled = Boolean(disabledReason);
	return (
		<>
			<Button
				type="button"
				variant={variant}
				size="sm"
				className={cn("h-7 gap-1.5 px-2 text-xs", disabled && "opacity-60")}
				aria-disabled={disabled ? true : undefined}
				aria-describedby={disabled ? reasonId : undefined}
				title={disabledReason ?? undefined}
				onClick={() => {
					if (!disabled) onClick();
				}}
			>
				{icon}
				{label}
			</Button>
			{disabled ? (
				<span id={reasonId} className="sr-only">
					{disabledReason}
				</span>
			) : null}
		</>
	);
}
