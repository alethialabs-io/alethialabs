"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Agents (`/{org}/~/settings/agents`, AGT-L2 SPEC §3): the org's switches for agents and
// approvals — the kill switch, keeping agents off production, how long a request stays open, and the
// two Enterprise rows.
//
// ONE READ, `agents.policy`: the stored settings (a missing row is every default), who changed them
// last, and `canManage` — the PDP's answer to `org:manage_agents`. The page never guesses a
// permission: without the verb every control is disabled and an inline alert says why. Reading needs
// `org:view`, so a refusal means the viewer is no longer in the org.
//
// EACH CONTROL SAVES ON CHANGE through the one `updateAgentPolicy` action, optimistically, and the
// mutation rolls the cached read back on a refusal. There is no page-level Save: settings that save
// instantly beside a Save button confuse people about what is applied (spec §3, Interactions). One
// mutation serves every control and all of them wait while it is in flight, so two optimistic
// patches can never interleave.
//
// Turning agent access OFF asks first (`ConfirmAction level="confirm"`, registered in
// destructive-actions.yaml as `settings.agent-access.turn-off`); turning it on does not.
//
// THE ENTERPRISE ROWS. Outside Enterprise they are locked with "Available on Enterprise". On
// Enterprise they show the stored value, still disabled: their write path arrives with AGT-L14's
// entitlement (lib/agents/policy.ts), and a switch that moves and then snaps back would be worse
// than one that says it can't change yet. While the entitlement is unknown (`null`, the first paint)
// neither the value's consequence nor the upsell is shown.

import { formatRelative } from "@repo/format";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { RegionError } from "@repo/ui/region-error";
import { SectionHeading } from "@repo/ui/section-heading";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";
import { useQuery } from "@tanstack/react-query";
import { Bot, Lock, Power } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { updateAgentPolicy } from "@/app/server/actions/agents/policy";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import {
	ACCESS_BODY,
	ACCESS_SECTION_DESCRIPTION,
	ACTIVITY_NOTE,
	ALLOWED_APPS_ANY,
	ALLOWED_APPS_ANY_BODY,
	ALLOWED_APPS_LIMIT,
	ALLOWED_APPS_TITLE,
	APPROVALS_SECTION_DESCRIPTION,
	AVAILABLE_ON_ENTERPRISE,
	type Consequence,
	DIFFERENT_APPROVER_BODY,
	DIFFERENT_APPROVER_TITLE,
	ENTERPRISE_LABEL,
	ENTERPRISE_NOT_EDITABLE_YET,
	ERROR_BODY,
	ERROR_TITLE,
	NO_PROD_BODY,
	NO_PROD_DISABLED_WHILE_OFF,
	NO_PROD_TITLE,
	OFF_BANNER_TITLE,
	READ_ONLY_TITLE,
	REFUSED_BODY,
	REFUSED_TITLE,
	TTL_GROUP_LABEL,
	TTL_HINT,
	TTL_PRESET_LABELS,
	TTL_TITLE,
	TURN_BACK_ON,
	TURN_OFF_CONFIRM,
	TURN_OFF_DESCRIPTION,
	TURN_OFF_PENDING,
	accessConsequence,
	accessTitle,
	allowedAppsDescription,
	differentApproverConsequence,
	lastChangedLine,
	noProdConsequence,
	offBannerBody,
	policyDescription,
	readOnlyBody,
	savedMessage,
	turnOffTitle,
} from "@/components/settings/agents/agent-policy-copy";
import { AgentPolicySkeleton } from "@/components/settings/agents/agent-policy-skeleton";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { agentAppIdentity } from "@/lib/agents/catalog";
import type { AgentPolicyPatch } from "@/lib/agents/policy";
import { orpc } from "@/lib/rpc/client";
import type { AgentPolicyRead } from "@/lib/rpc/procedures/agents";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

/** Narrows a cached value to the policy read. */
function isPolicyRead(value: unknown): value is AgentPolicyRead {
	return (
		typeof value === "object" &&
		value !== null &&
		"settings" in value &&
		typeof value.settings === "object" &&
		value.settings !== null &&
		"canManage" in value
	);
}

/**
 * The policy read with `patch` applied — the optimistic update. A value that is not the read
 * (nothing cached yet) is returned as it is; only the toggles the patch names move.
 */
export function withPolicyPatch(current: unknown, patch: AgentPolicyPatch): unknown {
	if (!isPolicyRead(current)) return current;
	const s = current.settings;
	return {
		...current,
		settings: {
			...s,
			agentAccessEnabled: patch.agentAccessEnabled ?? s.agentAccessEnabled,
			agentsMayNotApplyToProduction: patch.agentsMayNotApplyToProduction ?? s.agentsMayNotApplyToProduction,
			approvalTtlMinutes: patch.approvalTtlMinutes ?? s.approvalTtlMinutes,
		},
	};
}

/** A consequence line, tied to its control by `id` (the control's `aria-describedby`). */
function ConsequenceLine({ id, consequence }: { id: string; consequence: Consequence | null }) {
	if (!consequence) return null;
	return (
		<p id={id} data-slot="consequence" className="col-span-full text-ui-sm text-text-secondary">
			<span className="font-medium text-text-primary">{consequence.lead}</span> {consequence.text}
		</p>
	);
}

/** The small "Enterprise" label beside an Enterprise row's title. */
function EnterpriseLabel() {
	return (
		<span className="rounded-sm border border-border px-1.5 py-px text-ui-2xs font-medium tracking-wide text-text-secondary uppercase">
			{ENTERPRISE_LABEL}
		</span>
	);
}

/**
 * One switch row: title and body on the left, the switch on the right, the consequence line under
 * both. The switch's accessible name is the visible title and its description is the consequence.
 */
function SwitchRow({
	title,
	label,
	body,
	checked,
	disabled,
	disabledReason,
	consequence,
	onCheckedChange,
}: {
	title: ReactNode;
	/** The switch's accessible name: the visible title as text. */
	label: string;
	body: string;
	checked: boolean;
	disabled: boolean;
	/** Why the switch is disabled, when the page's read-only alert does not already say it. */
	disabledReason: string | null;
	consequence: Consequence | null;
	onCheckedChange: (next: boolean) => void;
}) {
	const consequenceId = useId();
	const control = (
		<Switch
			checked={checked}
			disabled={disabled}
			aria-label={label}
			aria-describedby={consequence ? consequenceId : undefined}
			onCheckedChange={(next) => onCheckedChange(next)}
		/>
	);
	return (
		<div className="grid grid-cols-[1fr_auto] items-start gap-x-6 gap-y-2 px-4 py-4">
			<div className="min-w-0 space-y-1">
				<div className="flex flex-wrap items-center gap-2 text-ui-md font-medium text-text-primary">{title}</div>
				<p className="text-ui-sm text-text-tertiary">{body}</p>
			</div>
			<div className="pt-0.5">
				{disabledReason ? <DisabledReason reason={disabledReason}>{control}</DisabledReason> : control}
			</div>
			<ConsequenceLine id={consequenceId} consequence={consequence} />
		</div>
	);
}

/** The settings card that holds a section's rows. */
function SettingsCard({ children }: { children: ReactNode }) {
	return <div className="divide-y divide-border rounded-sm border border-border bg-surface">{children}</div>;
}

/** The inverted banner shown while agent access is off, with Turn back on for a manager. */
function AccessOffBanner({ org, onTurnOn, busy }: { org: string; onTurnOn: (() => void) | null; busy: boolean }) {
	return (
		<div
			role="status"
			data-slot="agent-access-off"
			className="flex flex-wrap items-center gap-3 rounded-sm bg-ink px-4 py-3 text-ui-md text-ink-foreground"
		>
			<Power aria-hidden className="size-4 shrink-0" />
			<p className="min-w-0 flex-1">
				<strong className="font-medium">{OFF_BANNER_TITLE}</strong> {offBannerBody(org)}
			</p>
			{onTurnOn ? (
				<Button
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={onTurnOn}
					className="border-ink-foreground bg-ink-foreground text-ink hover:bg-ink-foreground hover:text-ink"
				>
					{TURN_BACK_ON}
				</Button>
			) : null}
		</div>
	);
}

/** The agent policy page: the read's states, the banner, the three sections and the footer. */
export function AgentPolicyPage() {
	const options = orpc.agents.policy.queryOptions({ input: undefined, retry: retryUnlessRefused });
	const read = useQuery(options);
	const entitled = useEntitlement("agentPolicy");
	const orgName = useWorkspaceStore((s) => s.organizations.find((o) => o.id === s.activeOrgId)?.name ?? null);
	const org = orgName ?? "this organization";
	const [confirmingOff, setConfirmingOff] = useState(false);

	const save = useActionMutation(updateAgentPolicy, {
		invalidates: [orpc.agents.key()],
		optimistic: [{ key: options.queryKey, update: (current, patch) => withPolicyPatch(current, patch) }],
		onSuccess: (_settings, patch) => toast.success(savedMessage(patch)),
	});

	if (readRefusalOf(read.error) === "forbidden") {
		return (
			<EmptyState
				className="border border-border bg-surface"
				icon={<Bot />}
				title={REFUSED_TITLE}
				description={REFUSED_BODY}
			/>
		);
	}
	if (read.isError && read.data === undefined) {
		return <RegionError title={ERROR_TITLE} description={ERROR_BODY} onRetry={() => void read.refetch()} />;
	}
	if (read.data === undefined) return <AgentPolicySkeleton />;

	const { settings, canManage } = read.data;
	const busy = save.isPending;
	const locked = !canManage || busy;
	const on = settings.agentAccessEnabled;
	const turnOn = () => save.submit({ agentAccessEnabled: true });

	// The Enterprise rows: never editable here (see the header), and why depends on the edition.
	const enterpriseReason = !canManage
		? null
		: entitled === true
			? ENTERPRISE_NOT_EDITABLE_YET
			: entitled === false
				? AVAILABLE_ON_ENTERPRISE
				: null;
	const allowed = settings.allowedOauthClientIds;
	const changed = lastChangedLine(
		settings.updatedBy?.name ?? null,
		settings.updatedAt ? formatRelative(settings.updatedAt) : null,
	);

	return (
		<div className="space-y-6">
			{on ? null : <AccessOffBanner org={org} onTurnOn={canManage ? turnOn : null} busy={busy} />}

			<PageToolbar description={policyDescription(org)} />

			{canManage ? null : (
				<Alert role="status">
					<Lock aria-hidden />
					<AlertTitle>{READ_ONLY_TITLE}</AlertTitle>
					<AlertDescription>
						<p>{readOnlyBody(org)}</p>
					</AlertDescription>
				</Alert>
			)}

			<section aria-labelledby="agent-access-heading" className="space-y-3">
				<SectionHeading title={<span id="agent-access-heading">Agent access</span>} description={ACCESS_SECTION_DESCRIPTION} />
				<SettingsCard>
					<SwitchRow
						title={accessTitle(org)}
						label={accessTitle(org)}
						body={ACCESS_BODY}
						checked={on}
						disabled={locked}
						disabledReason={null}
						consequence={accessConsequence(on)}
						onCheckedChange={(next) => (next ? turnOn() : setConfirmingOff(true))}
					/>
					<SwitchRow
						title={NO_PROD_TITLE}
						label={NO_PROD_TITLE}
						body={NO_PROD_BODY}
						checked={settings.agentsMayNotApplyToProduction}
						disabled={locked || !on}
						disabledReason={canManage && !on ? NO_PROD_DISABLED_WHILE_OFF : null}
						consequence={noProdConsequence(settings.agentsMayNotApplyToProduction)}
						onCheckedChange={(next) => save.submit({ agentsMayNotApplyToProduction: next })}
					/>
				</SettingsCard>
			</section>

			<section aria-labelledby="approvals-heading" className="space-y-3">
				<SectionHeading title={<span id="approvals-heading">Approvals</span>} description={APPROVALS_SECTION_DESCRIPTION} />
				<SettingsCard>
					<div className="space-y-2.5 px-4 py-4">
						<div className="space-y-1">
							<div className="text-ui-md font-medium text-text-primary">{TTL_TITLE}</div>
							<p className="text-ui-sm text-text-tertiary">
								A request has to be approved <strong className="font-medium text-text-primary">and used</strong> within
								this time. Shorter is safer; longer suits teams across time zones.
							</p>
						</div>
						<div role="group" aria-label={TTL_GROUP_LABEL} className="flex flex-wrap gap-1.5">
							{TTL_PRESET_LABELS.map((preset) => {
								const pressed = settings.approvalTtlMinutes === preset.minutes;
								return (
									<Button
										key={preset.minutes}
										type="button"
										size="sm"
										variant="outline"
										aria-pressed={pressed}
										disabled={locked}
										onClick={() => {
											if (!pressed) save.submit({ approvalTtlMinutes: preset.minutes });
										}}
										className={cn(pressed && "border-foreground bg-foreground text-background hover:bg-foreground hover:text-background")}
									>
										{preset.label}
									</Button>
								);
							})}
						</div>
						<p className="text-ui-sm text-text-tertiary">{TTL_HINT}</p>
					</div>
					<SwitchRow
						title={
							<>
								{DIFFERENT_APPROVER_TITLE}
								<EnterpriseLabel />
							</>
						}
						label={DIFFERENT_APPROVER_TITLE}
						body={DIFFERENT_APPROVER_BODY}
						checked={settings.requireDifferentApprover}
						disabled
						disabledReason={enterpriseReason}
						consequence={
							entitled === null ? null : differentApproverConsequence(entitled, settings.requireDifferentApprover)
						}
						onCheckedChange={() => {}}
					/>
				</SettingsCard>
			</section>

			<section aria-labelledby="allowed-apps-heading" className="space-y-3">
				<SectionHeading
					title={<span id="allowed-apps-heading">{ALLOWED_APPS_TITLE}</span>}
					description={allowedAppsDescription(org)}
					actions={<EnterpriseLabel />}
				/>
				<SettingsCard>
					<div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
						<div className="min-w-0 space-y-1">
							{allowed === null ? (
								<>
									<div className="text-ui-md font-medium text-text-primary">{ALLOWED_APPS_ANY}</div>
									<p className="text-ui-sm text-text-tertiary">{ALLOWED_APPS_ANY_BODY}</p>
								</>
							) : (
								<ul aria-label={ALLOWED_APPS_TITLE} className="space-y-1 text-ui-md text-text-primary">
									{allowed.map((clientId) => (
										<li key={clientId}>{agentAppIdentity({ clientId, name: null, icon: null }).name}</li>
									))}
								</ul>
							)}
						</div>
						<DisabledReason reason={enterpriseReason}>
							<Button size="sm" variant="outline" disabled>
								{ALLOWED_APPS_LIMIT}
							</Button>
						</DisabledReason>
					</div>
				</SettingsCard>
			</section>

			<p className="text-ui-sm text-text-tertiary">{changed ? `${changed} ${ACTIVITY_NOTE}` : ACTIVITY_NOTE}</p>

			<ConfirmAction
				open={confirmingOff}
				onOpenChange={setConfirmingOff}
				title={turnOffTitle(org)}
				description={TURN_OFF_DESCRIPTION}
				confirmLabel={TURN_OFF_CONFIRM}
				pendingLabel={TURN_OFF_PENDING}
				severity={{ level: "confirm" }}
				mutation={save}
				variables={confirmingOff ? { agentAccessEnabled: false } : null}
			/>
		</div>
	);
}
