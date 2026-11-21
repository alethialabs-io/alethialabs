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
// discarding it. Create stays pressable on a pristine sheet: pressing it is how the sheet says what
// is missing (inline, per field) rather than a disabled button that explains nothing. The write goes through
// `useActionMutation`: pending state on Create, server validation on the field it names, one toast
// for a refusal, and invalidation of every alert key.

import { zodResolver } from "@hookform/resolvers/zod";
import { Bell } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useForm, useWatch } from "react-hook-form";
import { createPolicy } from "@/app/server/actions/alerts";
import type { AlertsHub } from "@/components/alerts/alerts-hub";
import { ChannelRouting } from "@/components/alerts/channel-routing";
import { DiscardPrompt, useUnsavedGuard } from "@/components/confirm/use-unsaved-guard";
import { EventMatrix } from "@/components/alerts/event-matrix";
import { FieldHelp } from "@/components/alerts/field-help";
import { PolicyConditions } from "@/components/alerts/policy-conditions";
import {
	NEW_POLICY_FORM,
	normalizeBindings,
	POLICY_EDIT as EDIT,
	POLICY_SERVER_FIELDS,
	type PolicyFormValues,
	policyFormSchema,
	toggleEventIn,
	toPolicyInput,
} from "@/components/alerts/policy-form";
import { toMinSeverity } from "@/components/alerts/policy-shared";
import { FormRootError } from "@/components/forms/form-root-error";
import { ThrottleField } from "@/components/alerts/throttle-field";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { alertsKeys } from "@/lib/query/use-alerts-query";
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

interface PolicySheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	hub: AlertsHub;
	onGoChannels: () => void;
}

/** The fields the sheet renders from. */
const WATCHED = [
	"enabled",
	"event_patterns",
	"channels",
	"min_severity",
	"project_ids",
	"job_types",
	"resource_types",
	"actions",
	"throttle_seconds",
] as const;

/** Guided, single-form create flow for an alert policy. */
export function PolicySheet({
	open,
	onOpenChange,
	hub,
	onGoChannels,
}: PolicySheetProps) {
	const { categories, channels, advancedAlerting, conditionOptions } = hub;
	const wasOpen = useRef(false);
	// The switch's name is the visible row title, by reference — `role="switch"` takes its name
	// from the author only, so the text beside it names nothing unless it is pointed at (#4352).
	const enableLabelId = useId();
	const enableDescId = useId();

	const form = useForm<PolicyFormValues>({
		resolver: zodResolver(policyFormSchema),
		defaultValues: NEW_POLICY_FORM,
		mode: "onChange",
	});
	const [
		enabled,
		eventPatterns,
		boundChannels,
		minSeverity,
		projectIds,
		jobTypes,
		resourceTypes,
		actions,
		throttleSeconds,
	] = useWatch({ control: form.control, name: WATCHED });

	useEffect(() => {
		if (open && !wasOpen.current) form.reset(NEW_POLICY_FORM);
		wasOpen.current = open;
	}, [open, form]);

	const mutation = useActionMutation(createPolicy, {
		invalidates: alertsKeys(),
		successMessage: "Policy created",
		closes: onOpenChange,
		// The server's validation lands on the field it names; anything else in the root error
		// under the form, never lost.
		form: { instance: form, fields: POLICY_SERVER_FIELDS },
	});
	const saving = mutation.isPending;
	const unsaved = useUnsavedGuard(form);

	// Closing with something entered asks first; nothing closes it while the create is in flight.
	const requestOpenChange = (next: boolean) => {
		if (next) return onOpenChange(true);
		if (saving) return;
		unsaved.guard(() => onOpenChange(false));
	};

	const onSubmit = form.handleSubmit((values) => mutation.submit(toPolicyInput(values)));

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
								checked={enabled}
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
								{eventPatterns.length} selected
							</span>
						</div>
						<EventMatrix
							categories={categories}
							selected={eventPatterns}
							onToggle={(key) =>
								form.setValue(
									"event_patterns",
									toggleEventIn(form.getValues("event_patterns"), key),
									EDIT,
								)
							}
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
							value={boundChannels}
							onChange={(next) =>
								form.setValue("channels", normalizeBindings(next), EDIT)
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
								min_severity: toMinSeverity(minSeverity),
								project_ids: projectIds,
								job_types: jobTypes,
								resource_types: resourceTypes,
								actions,
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
							value={throttleSeconds}
							onChange={(s) => form.setValue("throttle_seconds", s, EDIT)}
						/>
					</section>
				</div>

				<FormRootError form={form} className="mx-4 mt-3 w-auto" />
				<SheetFooter className="flex-row items-center justify-between border-t border-border/60 p-4">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => requestOpenChange(false)}
						disabled={saving}
					>
						Cancel
					</Button>
					<Button size="sm" onClick={onSubmit} disabled={saving}>
						{saving ? "Creating…" : "Create policy"}
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
		<DiscardPrompt
			{...unsaved.prompt}
			title="Discard this policy?"
			description="What you entered has not been saved."
			confirmLabel="Discard"
		/>
		</>
	);
}
