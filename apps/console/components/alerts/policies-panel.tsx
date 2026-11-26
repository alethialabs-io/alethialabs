"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub · Policies panel. A master-detail: a rail of policies + an inline view/edit
// detail. Creating a policy opens the guided PolicySheet (paged stepper); existing ones
// edit in place (updatePolicy / togglePolicy / deletePolicy) using the shared EventMatrix,
// ChannelRouting, PolicyConditions and ThrottleField. A viewer who may not manage alerts sees
// every mutation control disabled WITH its reason (`manageReason`), never a silently missing
// button; security (authz.*) events are locked without the advancedAlerting entitlement.
//
// The inline editor is the same react-hook-form + zod form as the create sheet (policy-form.ts):
// a missing name, event or channel is said inline under its field, not in a toast, and an
// emptied name is refused rather than saved as a placeholder.
//
// An edit draft carries the id of the policy it was opened on. The selection is shared state that
// other surfaces move, so save targets the draft's id, and a selection that moves off a policy
// with unsaved edits is held behind a discard question rather than followed.
//
// Every write goes through `useActionMutation` (#6125): its pending state disables the trigger
// (the double-submit guard), a refusal is one toast in the server's words, and success
// invalidates every key that shows alert data — no `router.refresh()`. The panel renders its
// rows, its empty copy, a skeleton or a region error from the view's READ STATE, never from an
// empty row list alone: "No policies yet" is an answer, and a read in flight has not given one.

import { zodResolver } from "@hookform/resolvers/zod";
import { Bell, Plus, SearchX, Trash2 } from "lucide-react";
import { useState } from "react";
import { type UseFormReturn, useForm, useFormState, useWatch } from "react-hook-form";
import {
	deletePolicy,
	type PolicyDTO,
	togglePolicy,
	updatePolicy,
} from "@/app/server/actions/alerts";
import type { AlertsHub } from "@/components/alerts/alerts-hub";
import { AlertsPanelSkeleton } from "@/components/alerts/alerts-skeleton";
import { manageReason } from "@/components/errors/manage-gate";
import { RegionError } from "@repo/ui/region-error";
import { FormRootError } from "@/components/forms/form-root-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { alertsKeys } from "@/lib/query/use-alerts-query";
import { ChannelRouting } from "@/components/alerts/channel-routing";
import { ChannelIcon } from "@/components/alerts/channel-icon";
import { PoliciesFilterBar } from "@/components/alerts/alerts-filter-bar";
import type { PoliciesView } from "@/components/alerts/alerts-filters";
import { policyBadge } from "@/components/alerts/alerts-status";
import { ClassificationChips } from "@/components/classification/classification-chips";
import { ClassificationControl } from "@/components/classification/classification-control";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { DiscardPrompt } from "@/components/confirm/use-unsaved-guard";
import { EventMatrix } from "@/components/alerts/event-matrix";
import {
	type ConditionsValue,
	PolicyConditions,
} from "@/components/alerts/policy-conditions";
import { PolicySheet } from "@/components/alerts/policy-sheet";
import {
	NEW_POLICY_FORM,
	normalizeBindings,
	POLICY_EDIT,
	POLICY_SERVER_FIELDS,
	type PolicyFormValues,
	policyFormFrom,
	policyFormSchema,
	toggleEventIn,
	toPolicyInput,
} from "@/components/alerts/policy-form";
import { toMinSeverity } from "@/components/alerts/policy-shared";
import { ThrottleField } from "@/components/alerts/throttle-field";
import { useAlertPolicyFilters } from "@/lib/stores/use-alerts-filters";
import { useAlertsSection } from "@/lib/stores/use-alerts-section";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { StatusBadge } from "@repo/ui/status-badge";
import { Switch } from "@repo/ui/switch";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";

interface PoliciesPanelProps {
	hub: AlertsHub;
	/** The filter standard's resolved view — rows, facets, read state, active-filter count. */
	view: PoliciesView;
	onOpenChannel: (id?: string) => void;
}

/** Policies master-detail. */
export function PoliciesPanel({ hub, view, onOpenChannel }: PoliciesPanelProps) {
	const { policies, channels, canManage } = hub;
	const selectedId = useAlertsSection((s) => s.selectedPolicyId);
	const setSelectedId = useAlertsSection((s) => s.setSelectedPolicyId);

	// The policy being edited. Editing IS having this id — there is no separate flag to fall out
	// of step with it. The draft itself is the form's values, and they belong to this id only.
	const [editingId, setEditingId] = useState<string | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<PolicyDTO | null>(null);
	const [disableTarget, setDisableTarget] = useState<PolicyDTO | null>(null);
	const reason = manageReason(hub);

	// The same form as the create sheet (policy-form.ts): one schema, inline field errors.
	const form = useForm<PolicyFormValues>({
		resolver: zodResolver(policyFormSchema),
		defaultValues: NEW_POLICY_FORM,
	});
	// Read during render: react-hook-form tracks `isDirty` only for a component that reads it.
	const formDirty = form.formState.isDirty;

	const update = useActionMutation(updatePolicy, {
		invalidates: alertsKeys(),
		successMessage: "Policy saved",
		onSuccess: () => setEditingId(null),
		form: { instance: form, fields: POLICY_SERVER_FIELDS },
	});
	const toggle = useActionMutation(togglePolicy, {
		invalidates: alertsKeys(),
		onSuccess: () => setDisableTarget(null),
	});
	const remove = useActionMutation(deletePolicy, {
		invalidates: alertsKeys(),
		successMessage: "Policy deleted",
		onSuccess: () => {
			setSelectedId(null);
			setDeleteTarget(null);
		},
	});

	const selected =
		policies.find((p) => p.id === selectedId) ?? policies[0] ?? null;
	// The draft's own policy, found by the id the edit carries — never by the selection.
	const draftPolicy =
		editingId === null ? null : (policies.find((p) => p.id === editingId) ?? null);
	const dirty = draftPolicy !== null && formDirty;
	// The selection moved off the policy being edited while the draft holds unsaved edits. The
	// selection can move from outside this panel (a channel's "Used by" link), so this cannot be
	// asked before the move; instead the detail HOLDS on the draft's policy and the question is
	// asked now. Discard lets the selection through; Cancel puts it back.
	const held = dirty && draftPolicy !== null && selected?.id !== draftPolicy.id;
	const shown = held ? draftPolicy : selected;
	// A draft with nothing to lose does not outlive its policy being shown: the selection moved
	// off it, or the policy left the list. Dropped during render, so no frame pairs it with
	// another policy. Not while the list is unanswered — `[]` then does not mean "gone".
	if (editingId !== null && !held && hub.policiesKnown && selected?.id !== editingId) {
		setEditingId(null);
	}
	const editingShown = editingId !== null && shown !== null && editingId === shown.id;
	const { rows, facets, stale } = view;
	const resetFilters = useAlertPolicyFilters((s) => s.reset);
	// One batched query hydrates every rail row's classification chips.
	const { data: classMap = {} } = useAssignmentsForKind(
		"alert_rule",
		policies.map((p) => p.id),
	);

	const startEdit = () => {
		if (!selected) return;
		form.reset(policyFormFrom(selected));
		setEditingId(selected.id);
		// Pin the selection. `selected` may be the first-row fallback of a null selection, and a
		// fallback follows the list: a new first row would otherwise read as a selection change.
		setSelectedId(selected.id);
	};
	const cancel = () => setEditingId(null);

	const save = form.handleSubmit((values) => {
		if (editingId === null || !draftPolicy || !selected) return;
		// Refused unless the selection still names the draft's policy — while it does not, the
		// discard question is on screen and is the only thing to answer.
		if (selected.id !== editingId) return;
		// `enabled` is the policy's CURRENT state: the switch is its own write, not part of the edit.
		update.submit({ ...toPolicyInput(values), enabled: draftPolicy.enabled, id: editingId });
	});

	// The mutation itself, split from the click handler so the confirm path can reach it.
	const applyEnabled = (p: PolicyDTO, next: boolean) => {
		if (toggle.isPending) return;
		toggle.mutate({ id: p.id, enabled: next });
	};
	// Confirm only when DISABLING — enabling stays a bare click, exactly as it does for channels
	// (`onToggle` in channels-panel.tsx). Both surfaces stop alert delivery, and the product had
	// already decided that warrants an ask; it was applied to one of the two. A policy is the
	// wider of them: disabling one silences a class of alerts across every channel routed to it,
	// and nothing on the rail says so afterwards beyond the switch's own state.
	const onToggleEnabled = (p: PolicyDTO, next: boolean) => {
		if (!next) setDisableTarget(p);
		else applyEnabled(p, true);
	};

	// Rendered for every viewer; a viewer who may not create one is told why on the button.
	const newPolicyBtn = (
		<DisabledReason reason={reason}>
			<Button size="sm" onClick={() => setSheetOpen(true)}>
				<Plus className="mr-1 size-3.5" /> New policy
			</Button>
		</DisabledReason>
	);

	return (
		<div>
			{view.state === "loading" ? (
				<AlertsPanelSkeleton kind="policies" />
			) : view.state === "error" ? (
				<RegionError title="Couldn't load policies" onRetry={view.retry} />
			) : view.universeEmpty ? (
				<EmptyState
					icon={<Bell />}
					// `level={3}` under the section's own `h2` — see the twin in channels-panel.tsx:
					// EmptyState's title is a `<div>` unless a level is passed, and this state heads
					// the whole Policies region.
					level={3}
					title="No policies yet"
					description="A policy watches a set of events and routes matches to your channels. Create one to start."
					action={newPolicyBtn}
				/>
			) : (
				<>
					<PoliciesFilterBar facets={facets} action={newPolicyBtn} />

					{/* master-detail */}
					<div className="flex flex-wrap items-start gap-4">
						{/* The filter standard's `isPlaceholderData` dim: while `stale` is true these rows are
						    the PREVIOUS query's answer, kept so the rail does not blank on a filter change
						    and marked so they are not read as the current one. */}
						<div
							className={cn(
								"min-w-[290px] flex-1 overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm",
								stale && "opacity-60 transition-opacity",
							)}
						>
							<div className="px-4 py-3 font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-tertiary">
								Policies
							</div>
							{rows.length === 0 ? (
								// The shared empty state — see the twin in channels-panel.tsx (#4939).
								<EmptyState
									icon={<SearchX />}
									title="No policies match"
									description="No policy matches these filters."
									action={
										<Button variant="outline" size="sm" onClick={resetFilters}>
											Reset filters
										</Button>
									}
								/>
							) : (
								/*
								 * A single-select rail: a listbox of options, not a stack of buttons.
								 * Besides what a screen reader gets out of it, the role is what tells a
								 * policy's RAIL ROW apart from the "Used by" pill in the Channels panel
								 * that carries the same policy name — two buttons with one accessible
								 * name on one page is a strict-mode collision for anything driving the
								 * page by role. The caption above stays outside the listbox: a
								 * listbox's children must all be options.
								 */
								<div role="listbox" aria-label="Policies">
									{rows.map((p) => (
										<button
											key={p.id}
											type="button"
											role="option"
											// The list-item marker (#7673, components/data-table.tsx).
											data-list-item=""
											aria-selected={shown?.id === p.id}
											// Only moves the selection. What that does to a draft is
											// decided in one place above, for every way it can move.
											onClick={() => setSelectedId(p.id)}
											className={cn(
												"flex w-full items-center gap-3 border-b border-l-2 border-border/60 px-3.5 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40",
												shown?.id === p.id
													? "border-l-foreground bg-muted/40"
													: "border-l-transparent",
											)}
										>
											<StatusBadge {...policyBadge(p)} showLabel={false} />
											<span className="min-w-0 flex-1">
												<span className="block truncate font-medium text-ui-md">
													{p.name}
												</span>
												<span className="font-mono text-ui-2xs text-muted-foreground">
													{p.event_patterns.length} events ·{" "}
													{p.enabled ? "enabled" : "off"}
												</span>
												<ClassificationChips
													kind="alert_rule"
													id={p.id}
													initialAssignments={classMap[p.id]}
													className="mt-1 flex"
												/>
											</span>
											<span className="flex gap-1">
												{p.channelIds.slice(0, 4).map((cid) => {
													const ch = channels.find((c) => c.id === cid);
													if (!ch) return null;
													return (
														<span
															key={cid}
															className="flex size-[18px] items-center justify-center rounded border border-border/60"
														>
															<ChannelIcon
																type={ch.type}
																active={ch.is_verified}
																size={11}
															/>
														</span>
													);
												})}
											</span>
										</button>
									))}
								</div>
							)}
						</div>

						<div className="min-w-[min(500px,100%)] flex-[100]">
							{shown ? (
								<PolicyDetail
									// Keyed by policy: nothing a field holds for one policy is
									// carried into the detail of the next.
									key={shown.id}
									policy={shown}
									form={form}
									editing={editingShown}
									saving={update.isPending}
									dirty={dirty}
									togglePending={toggle.isPending}
									hub={hub}
									onStartEdit={startEdit}
									onCancel={cancel}
									onSave={save}
									onToggleEnabled={onToggleEnabled}
									onDelete={setDeleteTarget}
									onOpenChannel={onOpenChannel}
								/>
							) : (
								<div className="rounded-xl border border-border/60 bg-background p-12 text-center text-muted-foreground text-sm shadow-sm">
									Select a policy to view it.
								</div>
							)}
						</div>
					</div>
				</>
			)}

			{canManage && (
				<PolicySheet
					open={sheetOpen}
					onOpenChange={setSheetOpen}
					hub={hub}
					onGoChannels={() => onOpenChannel()}
				/>
			)}

			<DiscardPrompt
				open={held}
				title="Discard unsaved changes?"
				description={`Your edits to "${draftPolicy?.name ?? ""}" have not been saved. Opening another policy discards them.`}
				confirmLabel="Discard changes"
				// Keep editing: back to the policy being edited, draft intact.
				onKeep={() => {
					if (editingId !== null) setSelectedId(editingId);
				}}
				// The selection has already moved; dropping the draft is what lets it through.
				onDiscard={() => setEditingId(null)}
			/>

			<ConfirmAction
				open={disableTarget !== null}
				onOpenChange={(o) => !o && setDisableTarget(null)}
				title="Disable this policy?"
				description="This policy stops watching its events until you re-enable it, across every channel it routes to. You can re-enable any time."
				confirmLabel="Disable"
				pendingLabel="Disabling…"
				severity={{ level: "confirm" }}
				mutation={toggle}
				variables={disableTarget ? { id: disableTarget.id, enabled: false } : null}
			/>

			<ConfirmAction
				open={deleteTarget !== null}
				onOpenChange={(o) => !o && setDeleteTarget(null)}
				title={`Delete policy "${deleteTarget?.name ?? ""}"?`}
				description="This policy stops watching its events immediately. Delivery history is kept. This cannot be undone."
				confirmLabel="Delete policy"
				pendingLabel="Deleting…"
				severity={{ level: "confirm" }}
				mutation={remove}
				variables={deleteTarget ? { id: deleteTarget.id } : null}
			/>
		</div>
	);
}

interface DetailProps {
	policy: PolicyDTO;
	/** The panel's edit form. Its values are THIS policy's draft only while `editing` is true. */
	form: UseFormReturn<PolicyFormValues>;
	/** This policy is being edited (the form holds its draft); false when it is only viewed. */
	editing: boolean;
	saving: boolean;
	/** The draft differs from the saved policy — Save does nothing until it does. */
	dirty: boolean;
	/** The enable switch's write is in flight. */
	togglePending: boolean;
	hub: AlertsHub;
	onStartEdit: () => void;
	onCancel: () => void;
	onSave: () => void;
	onToggleEnabled: (p: PolicyDTO, next: boolean) => void;
	onDelete: (p: PolicyDTO) => void;
	onOpenChannel: (id?: string) => void;
}

/** The draft fields the detail renders from while editing (name and description are inputs). */
const DETAIL_WATCHED = [
	"event_patterns",
	"channels",
	"min_severity",
	"project_ids",
	"job_types",
	"resource_types",
	"actions",
	"throttle_seconds",
] as const;

/** Inline view/edit of one existing policy. */
function PolicyDetail({
	policy,
	form,
	editing: ed,
	saving,
	dirty,
	togglePending,
	hub,
	onStartEdit,
	onCancel,
	onSave,
	onToggleEnabled,
	onDelete,
	onOpenChannel,
}: DetailProps) {
	const { categories, channels, conditionOptions, advancedAlerting } = hub;
	const reason = manageReason(hub);
	const [
		eventPatterns,
		boundChannels,
		minSeverity,
		projectIds,
		jobTypes,
		resourceTypes,
		actions,
		throttleSeconds,
	] = useWatch({ control: form.control, name: DETAIL_WATCHED });
	const { errors } = useFormState({ control: form.control });
	// What the detail shows: the draft while editing, the saved policy otherwise.
	const values: Omit<PolicyFormValues, "name" | "description" | "enabled"> = ed
		? {
				event_patterns: eventPatterns,
				channels: boundChannels,
				min_severity: minSeverity,
				project_ids: projectIds,
				job_types: jobTypes,
				resource_types: resourceTypes,
				actions,
				throttle_seconds: throttleSeconds,
			}
		: policyFormFrom(policy);

	const conditions: ConditionsValue = {
		min_severity: toMinSeverity(values.min_severity),
		project_ids: values.project_ids,
		job_types: values.job_types,
		resource_types: values.resource_types,
		actions: values.actions,
	};
	const throttle = values.throttle_seconds;
	const totalEv = categories.reduce((n, c) => n + c.events.length, 0);
	const throttleLabel =
		throttle <= 0 ? "Every event" : `${Math.round(throttle / 60)} min`;
	const nameId = `policy-name-${policy.id}`;
	const nameErrorId = `${nameId}-error`;

	return (
		<div className="overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm">
			{/* header */}
			<div className="flex items-start justify-between gap-4 border-b border-border/60 p-5">
				<div className="flex min-w-0 gap-3">
					<span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30">
						<Bell className="size-5 text-muted-foreground" />
					</span>
					<div className="min-w-0 space-y-1.5">
						<div className="flex flex-wrap items-center gap-2.5">
							{ed ? (
								<div className="space-y-1">
									{/* Visually hidden for the same reason as the channel detail's twin:
									    the field's own text is this panel's heading, and a placeholder
									    is not a label. */}
									<Label htmlFor={nameId} className="sr-only">
										Policy name
									</Label>
									<Input
										id={nameId}
										placeholder="Policy name"
										aria-invalid={errors.name ? true : undefined}
										aria-describedby={errors.name ? nameErrorId : undefined}
										className="h-8 w-64 font-semibold"
										{...form.register("name")}
									/>
									{errors.name && (
										<p id={nameErrorId} className="text-destructive text-xs">
											{errors.name.message}
										</p>
									)}
								</div>
							) : (
								<span className="font-display font-semibold text-lg tracking-tight">
									{policy.name}
								</span>
							)}
							{policy.is_security && (
								<span className="rounded-full border border-border/60 px-2 py-0.5 font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
									security
								</span>
							)}
						</div>
						{ed ? (
							<Textarea
								aria-label="Policy description"
								rows={2}
								placeholder="What this policy watches and why"
								className="text-xs"
								{...form.register("description")}
							/>
						) : (
							policy.description && (
								<p className="max-w-prose text-muted-foreground text-xs leading-relaxed">
									{policy.description}
								</p>
							)
						)}
						{/* Classification (Workstream B) — chips + a picker for managers. */}
						<ClassificationControl
							kind="alert_rule"
							id={policy.id}
							canEdit={hub.canManage}
							className="pt-1"
						/>
					</div>
				</div>
				<div className="flex flex-none items-center gap-2">
					<StatusBadge {...policyBadge(policy)} className="text-ui-2xs" />
					{/* Named in both states — the name is the control, the state is `aria-checked`. */}
					<DisabledReason reason={reason}>
						<Switch
							aria-label="Enabled"
							checked={policy.enabled}
							disabled={ed || togglePending}
							onCheckedChange={(c) => onToggleEnabled(policy, c)}
						/>
					</DisabledReason>
					{ed ? (
						<>
							<Button
								variant="ghost"
								size="sm"
								onClick={onCancel}
								disabled={saving}
							>
								Cancel
							</Button>
							<Button size="sm" onClick={onSave} disabled={saving || !dirty}>
								{saving ? "Saving…" : "Save"}
							</Button>
						</>
					) : (
						<DisabledReason reason={reason}>
							<Button size="sm" variant="outline" onClick={onStartEdit}>
								Edit policy
							</Button>
						</DisabledReason>
					)}
				</div>
			</div>
			{ed && <FormRootError form={form} className="rounded-none border-x-0 border-t-0" />}

			{/* meta */}
			<div className="flex flex-wrap border-b border-border/60">
				<MetaCell k="Events" v={`${values.event_patterns.length} of ${totalEv}`} />
				<MetaCell
					k="Routes to"
					v={`${values.channels.length} ${values.channels.length === 1 ? "channel" : "channels"}`}
				/>
				<MetaCell k="Throttle" v={throttleLabel} />
			</div>

			{/* events */}
			<div className="space-y-3 border-b border-border/60 p-5">
				<div className="flex items-center gap-2">
					<span className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
						Trigger · events
					</span>
					<span className="ml-auto font-mono text-ui-2xs text-muted-foreground">
						{values.event_patterns.length} selected
					</span>
				</div>
				<EventMatrix
					categories={categories}
					selected={values.event_patterns}
					onToggle={(key) =>
						form.setValue(
							"event_patterns",
							toggleEventIn(form.getValues("event_patterns"), key),
							POLICY_EDIT,
						)
					}
					advancedAlerting={advancedAlerting}
					editable={ed}
				/>
				{ed && errors.event_patterns && (
					<p className="text-destructive text-xs">{errors.event_patterns.message}</p>
				)}
			</div>

			{/* routing */}
			<div className="space-y-3 border-b border-border/60 p-5">
				<div className="flex items-center gap-2">
					<span className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
						Routing · channels
					</span>
					{/* An in-page LINK to the Channels section, not a button that scrolls — see the
					    "All policies →" twin in channels-panel.tsx for why (#7673). */}
					<a
						href="#channels"
						className="ml-auto text-muted-foreground text-xs hover:text-foreground"
					>
						All channels →
					</a>
				</div>
				<ChannelRouting
					channels={channels}
					value={values.channels}
					onChange={(next) =>
						form.setValue("channels", normalizeBindings(next), POLICY_EDIT)
					}
					editable={ed}
					onGoChannels={() => onOpenChannel()}
				/>
				{ed && errors.channels && (
					<p className="text-destructive text-xs">{errors.channels.message}</p>
				)}
			</div>

			{/* conditions */}
			<div className="space-y-3 border-b border-border/60 p-5">
				<span className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
					Conditions
				</span>
				<PolicyConditions
					options={conditionOptions}
					editable={ed}
					value={conditions}
					onChange={(c) => {
						form.setValue("min_severity", c.min_severity, POLICY_EDIT);
						form.setValue("project_ids", c.project_ids, POLICY_EDIT);
						form.setValue("job_types", c.job_types, POLICY_EDIT);
						form.setValue("resource_types", c.resource_types, POLICY_EDIT);
						form.setValue("actions", c.actions, POLICY_EDIT);
					}}
				/>
			</div>

			{/* throttle */}
			<div className="space-y-2 p-5">
				<div className="flex items-center gap-1.5">
					<span className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
						Notify at most once per
					</span>
				</div>
				{ed ? (
					<ThrottleField
						value={throttle}
						onChange={(seconds) =>
							form.setValue("throttle_seconds", seconds, POLICY_EDIT)
						}
					/>
				) : (
					<p className="text-muted-foreground text-sm">{throttleLabel}</p>
				)}
			</div>

			{/* footer */}
			{!ed && (
				<div className="flex items-center justify-between border-t border-border/60 bg-muted/20 px-5 py-3">
					<span className="text-muted-foreground text-xs">
						{policy.is_security
							? "Security policy · PDP-sourced events"
							: "Operational policy"}
					</span>
					<DisabledReason reason={reason}>
						<Button variant="ghost" size="sm" onClick={() => onDelete(policy)}>
							<Trash2 className="mr-1.5 size-3.5" /> Delete policy
						</Button>
					</DisabledReason>
				</div>
			)}
		</div>
	);
}

/** One labelled figure in the detail's summary strip. */
function MetaCell({ k, v }: { k: string; v: string }) {
	return (
		<div className="min-w-[120px] flex-1 border-r border-border/60 px-5 py-3 last:border-r-0">
			<div className="font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
				{k}
			</div>
			<div className="mt-1.5 truncate text-ui-md">{v}</div>
		</div>
	);
}
