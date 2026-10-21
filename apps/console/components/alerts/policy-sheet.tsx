"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The guided "new alert policy" flow — a right-side Sheet as one vertical form (no
// stepper): Details → Events → Routing → Conditions → Throttle, divided by Separators.
// react-hook-form + zod validate on submit; events/channels/conditions use the shared
// EventMatrix / ChannelRouting / PolicyConditions / ThrottleField. Creation only.
//
// #6125: the sheet tracks whether the form is DIRTY. Every editor writes through `setValue(…,
// { shouldDirty: true })`, so a chosen event, a bound channel or a moved throttle counts as an edit
// (react-hook-form only marks registered inputs dirty on its own); closing a dirty sheet asks before
// discarding it, and Create is disabled until something was entered. The write goes through
// `useActionMutation`: pending state on Create, server validation on the field it names, one toast
// for a refusal, and invalidation of every alert key.

import { zodResolver } from "@hookform/resolvers/zod";
import { Bell } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { createPolicy } from "@/app/server/actions/alerts";
import type { AlertsHub } from "@/components/alerts/alerts-hub";
import { ChannelRouting } from "@/components/alerts/channel-routing";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { EventMatrix } from "@/components/alerts/event-matrix";
import { FieldHelp } from "@/components/alerts/field-help";
import { PolicyConditions } from "@/components/alerts/policy-conditions";
import { isSeverity, toMinSeverity } from "@/components/alerts/policy-shared";
import { ThrottleField } from "@/components/alerts/throttle-field";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { alertsKeys } from "@/lib/query/use-alerts-query";
import type { PolicyInput } from "@/lib/validations/alerts";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Separator } from "@repo/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Switch } from "@repo/ui/switch";
import { Textarea } from "@repo/ui/textarea";

const wizardSchema = z.object({
	name: z.string().min(1, "Name your policy").max(120),
	description: z.string().max(500),
	enabled: z.boolean(),
	event_patterns: z.array(z.string()).min(1, "Pick at least one event."),
	channels: z
		.array(z.object({ id: z.string(), min_severity: z.string().optional() }))
		.min(1, "Bind at least one channel."),
	min_severity: z.string(),
	project_ids: z.array(z.string()),
	job_types: z.array(z.string()),
	resource_types: z.array(z.string()),
	actions: z.array(z.string()),
	throttle_seconds: z.number(),
});
type WizardValues = z.infer<typeof wizardSchema>;

const DEFAULTS: WizardValues = {
	name: "",
	description: "",
	enabled: true,
	event_patterns: [],
	channels: [],
	min_severity: "any",
	project_ids: [],
	job_types: [],
	resource_types: [],
	actions: [],
	throttle_seconds: 300,
};

/** Marks a programmatic write as an edit, and re-validates the field it wrote. */
const EDIT = { shouldDirty: true, shouldValidate: true } as const;

/** The sheet's field a server validation path is about (`match.project_ids` → `project_ids`), or null. */
function policyFieldOf(path: string): keyof WizardValues | null {
	const [head, sub] = path.split(".");
	switch (head) {
		case "name":
		case "description":
		case "event_patterns":
		case "channels":
		case "throttle_seconds":
			return head;
		case "match":
			if (sub === "min_severity") return "min_severity";
			if (sub === "project_ids" || sub === "job_types" || sub === "resource_types" || sub === "actions") return sub;
			return null;
		default:
			return null;
	}
}

interface PolicySheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	hub: AlertsHub;
	onGoChannels: () => void;
}

/** Guided, single-form create flow for an alert policy. */
export function PolicySheet({
	open,
	onOpenChange,
	hub,
	onGoChannels,
}: PolicySheetProps) {
	const { categories, channels, advancedAlerting, conditionOptions } = hub;
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const wasOpen = useRef(false);
	// The switch's name is the visible row title, by reference — `role="switch"` takes its name
	// from the author only, so the text beside it names nothing unless it is pointed at (#4352).
	const enableLabelId = useId();
	const enableDescId = useId();

	const form = useForm<WizardValues>({
		resolver: zodResolver(wizardSchema),
		defaultValues: DEFAULTS,
		mode: "onChange",
	});
	const v = form.watch();

	useEffect(() => {
		if (open && !wasOpen.current) form.reset(DEFAULTS);
		wasOpen.current = open;
	}, [open, form]);

	const mutation = useActionMutation(createPolicy, {
		invalidates: alertsKeys(),
		successMessage: "Policy created",
		onSuccess: () => onOpenChange(false),
		onValidationError: (fields) => {
			for (const [path, messages] of Object.entries(fields)) {
				const message = messages?.[0];
				const field = policyFieldOf(path);
				if (message && field) form.setError(field, { message });
			}
		},
	});
	const saving = mutation.isPending;
	const dirty = form.formState.isDirty;

	// Closing with something entered asks first; nothing closes it while the create is in flight.
	const requestOpenChange = (next: boolean) => {
		if (next) return onOpenChange(true);
		if (saving) return;
		if (dirty) setConfirmDiscard(true);
		else onOpenChange(false);
	};

	const onSubmit = form.handleSubmit((values) => {
		if (saving) return;
		const input: PolicyInput = {
			name: values.name.trim(),
			description: values.description.trim() || undefined,
			event_patterns: values.event_patterns,
			channels: values.channels.map((b) => ({
				id: b.id,
				min_severity:
					b.min_severity && isSeverity(b.min_severity) ? b.min_severity : undefined,
			})),
			match: {
				...(isSeverity(values.min_severity)
					? { min_severity: values.min_severity }
					: {}),
				...(values.project_ids.length ? { project_ids: values.project_ids } : {}),
				...(values.job_types.length ? { job_types: values.job_types } : {}),
				...(values.resource_types.length
					? { resource_types: values.resource_types }
					: {}),
				...(values.actions.length ? { actions: values.actions } : {}),
			},
			severity: "warning",
			throttle_seconds: values.throttle_seconds,
			escalate: false,
			recipient: undefined,
			enabled: values.enabled,
		};
		mutation.mutate(input);
	});

	const errors = form.formState.errors;

	return (
		<>
		<Sheet open={open} onOpenChange={requestOpenChange}>
			<SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
				<SheetHeader className="gap-3 border-b border-border/60 p-5">
					<div className="flex items-center gap-3">
						<span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30 text-muted-foreground">
							<Bell className="size-5" />
						</span>
						<div>
							<SheetTitle className="font-display text-base">
								New alert policy
							</SheetTitle>
							<SheetDescription className="text-xs">
								Watch a set of events and route them to your channels.
							</SheetDescription>
						</div>
					</div>
				</SheetHeader>

				<div className="flex-1 space-y-6 overflow-y-auto p-5">
					{/* details */}
					<section className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="policy-name">Name</Label>
							<Input
								id="policy-name"
								placeholder="Production deploy failures"
								{...form.register("name")}
							/>
							{errors.name && (
								<p className="text-destructive text-xs">{errors.name.message}</p>
							)}
						</div>
						<div className="space-y-2">
							<Label htmlFor="policy-desc">Description (optional)</Label>
							<Textarea
								id="policy-desc"
								rows={2}
								placeholder="What this policy watches and why"
								{...form.register("description")}
							/>
						</div>
						<div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
							<div>
								<div id={enableLabelId} className="text-sm">
									Enable on create
								</div>
								<div id={enableDescId} className="text-muted-foreground text-xs">
									Start routing matching events immediately.
								</div>
							</div>
							<Switch
								aria-labelledby={enableLabelId}
								aria-describedby={enableDescId}
								checked={v.enabled}
								onCheckedChange={(c) => form.setValue("enabled", c, EDIT)}
							/>
						</div>
					</section>

					<Separator />

					{/* events */}
					<section className="space-y-3">
						<div className="flex items-center gap-1.5">
							<span className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
								Trigger · events
							</span>
							<FieldHelp title="Events">
								Each event is a key (e.g.{" "}
								<code className="font-mono">system.job.failed</code>); the policy
								fires when any selected event occurs. Security (PDP) events require
								an Enterprise plan.
							</FieldHelp>
							<span className="ml-auto font-mono text-ui-2xs text-muted-foreground">
								{v.event_patterns.length} selected
							</span>
						</div>
						<EventMatrix
							categories={categories}
							selected={v.event_patterns}
							onToggle={(key) => {
								const cur = form.getValues("event_patterns");
								form.setValue(
									"event_patterns",
									cur.includes(key)
										? cur.filter((x) => x !== key)
										: [...cur, key],
									EDIT,
								);
							}}
							advancedAlerting={advancedAlerting}
							editable
						/>
						{errors.event_patterns && (
							<p className="text-destructive text-xs">
								{errors.event_patterns.message}
							</p>
						)}
					</section>

					<Separator />

					{/* routing */}
					<section className="space-y-3">
						<div className="flex items-center gap-1.5">
							<span className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
								Routing · channels
							</span>
							<FieldHelp title="Routing">
								Bind one or more channels. Optionally give a channel a severity
								floor so it only receives, say, critical events.
							</FieldHelp>
						</div>
						<ChannelRouting
							channels={channels}
							value={v.channels}
							onChange={(next) =>
								form.setValue("channels", next, EDIT)
							}
							editable
							onGoChannels={onGoChannels}
						/>
						{errors.channels && (
							<p className="text-destructive text-xs">{errors.channels.message}</p>
						)}
					</section>

					<Separator />

					{/* conditions */}
					<section className="space-y-3">
						<span className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
							Conditions
						</span>
						<PolicyConditions
							options={conditionOptions}
							editable
							value={{
								min_severity: toMinSeverity(v.min_severity),
								project_ids: v.project_ids,
								job_types: v.job_types,
								resource_types: v.resource_types,
								actions: v.actions,
							}}
							onChange={(c) => {
								form.setValue("min_severity", c.min_severity, EDIT);
								form.setValue("project_ids", c.project_ids, EDIT);
								form.setValue("job_types", c.job_types, EDIT);
								form.setValue("resource_types", c.resource_types, EDIT);
								form.setValue("actions", c.actions, EDIT);
							}}
						/>
					</section>

					<Separator />

					{/* throttle */}
					<section className="space-y-2">
						<div className="flex items-center gap-1.5">
							<Label>Notify at most once per</Label>
							<FieldHelp title="Throttle & grouping">
								Repeats of the same event subject within this window collapse into a
								single notification, so a flapping condition will not spam your
								channels.
							</FieldHelp>
						</div>
						<ThrottleField
							value={v.throttle_seconds}
							onChange={(s) => form.setValue("throttle_seconds", s, EDIT)}
						/>
					</section>
				</div>

				<SheetFooter className="flex-row items-center justify-between border-t border-border/60 p-4">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => requestOpenChange(false)}
						disabled={saving}
					>
						Cancel
					</Button>
					<Button size="sm" onClick={onSubmit} disabled={saving || !dirty}>
						{saving ? "Creating…" : "Create policy"}
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
		<ConfirmDialog
			open={confirmDiscard}
			onOpenChange={setConfirmDiscard}
			title="Discard this policy?"
			description="What you entered has not been saved."
			confirmLabel="Discard"
			onConfirm={() => {
				setConfirmDiscard(false);
				onOpenChange(false);
			}}
		/>
		</>
	);
}
