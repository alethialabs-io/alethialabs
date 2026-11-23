"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The complimentary Early Access request (EA-3, #7325) — the page an EU business with a VAT number is
// sent to when the purchase gate cannot sell to it yet (EA-2's refusal links here).
//
// WHAT THIS PAGE MAY SAY (decisions-2026-11-23-early-access.md §2). The access is free; nothing is
// charged and nothing is owed; the free period is never charged later. It does NOT name a price, does
// not promise a future price, and does not say that a subscription will start: if the business later
// chooses to pay, that is a new choice, made then, billed only from then on. The optional note is the
// requester's own words and is stated to bind nobody.

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { formatDate } from "@repo/format";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { Textarea } from "@repo/ui/textarea";
import {
	getEarlyAccessOverview,
	requestEarlyAccess,
} from "@/app/server/actions/early-access";
import { SettingsSection } from "@/components/settings/settings-ui";
import type { EarlyAccessPlan, EarlyAccessRequestStatus } from "@/lib/db/schema/early-access";
import type { EarlyAccessRequestView } from "@/lib/early-access/request";
import { VAT_NUMBER_REFUSAL_MESSAGES, parseVatNumber } from "@/lib/early-access/vat-number";

/** The query key of the overview; invalidated once a request is filed. */
const OVERVIEW_KEY = ["early-access", "overview"] as const;

/** The longest note, matching the server's `EARLY_ACCESS_NOTE_MAX`. */
const NOTE_MAX = 1000;

/** A field label's look, matching the purchase sheet's `Field`. */
const fieldLabelClass = "flex items-center gap-1.5 text-ui-md font-medium text-text-primary";

/** The plans a grant can be asked for, as the form offers them. */
const PLAN_OPTIONS: readonly { value: EarlyAccessPlan; label: string; description: string }[] = [
	{ value: "team", label: "Team", description: "Organizations, teams and shared projects." },
	{ value: "ai_plus", label: "AI Plus", description: "A larger weekly AI allowance." },
	{ value: "ai_max", label: "AI Max", description: "The largest weekly AI allowance." },
];

/** The plan's label, for the request list. */
function planLabel(plan: EarlyAccessPlan): string {
	return PLAN_OPTIONS.find((o) => o.value === plan)?.label ?? plan;
}

/** How each request status reads, and its badge tier. */
const STATUS_COPY: Readonly<Record<EarlyAccessRequestStatus, { label: string; tier: StatusTier }>> = {
	open: { label: "Waiting for review", tier: "pending" },
	granted: { label: "Granted", tier: "active" },
	declined: { label: "Declined", tier: "disabled" },
	converted: { label: "Subscribed", tier: "active" },
};

const schema = z.object({
	plan: z.enum(["team", "ai_plus", "ai_max"], { error: "Choose the plan you would like." }),
	vatId: z
		.string()
		.trim()
		.superRefine((value, ctx) => {
			const parsed = parseVatNumber(value);
			if (!parsed.ok) ctx.addIssue({ code: "custom", message: VAT_NUMBER_REFUSAL_MESSAGES[parsed.reason] });
		}),
	note: z.string().trim().max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters.`),
});

type FormInput = z.input<typeof schema>;
type FormData = z.output<typeof schema>;

/** Fetches the overview. Wrapped so the query never passes a client value to the action. */
function fetchOverview() {
	return getEarlyAccessOverview();
}

/**
 * The Early Access page body: what the grant is, the organization's past requests, and the request
 * form (hidden while a request is open, because the server allows one open request at a time).
 */
export function EarlyAccessRequestPanel() {
	const overview = useQuery({ queryKey: OVERVIEW_KEY, queryFn: fetchOverview, retry: false });

	return (
		<>
			<SettingsSection title="Complimentary Early Access">
				<Card className="space-y-2 p-6 text-ui-md text-text-secondary">
					<p>
						Paid plans are not on sale yet to businesses in other EU countries that have a VAT number.
						Until they are, your organization can ask for complimentary access to a paid plan.
					</p>
					<p>
						Complimentary means free: nothing is charged and nothing is owed, now or later, and no part
						of a complimentary period is ever charged. We review each request and reply by email.
					</p>
				</Card>
			</SettingsSection>

			{overview.isPending ? (
				<Skeleton className="h-40 w-full" />
			) : overview.isError ? (
				<Alert>
					<AlertTitle>Couldn&apos;t load your requests</AlertTitle>
					<AlertDescription>
						<Button variant="outline" size="sm" className="mt-2" onClick={() => void overview.refetch()}>
							Try again
						</Button>
					</AlertDescription>
				</Alert>
			) : (
				<>
					<RequestList requests={overview.data.requests} />
					{!overview.data.grantsOpen ? (
						<Card className="p-6 text-ui-md text-text-secondary">
							Complimentary requests are closed. Your organization can choose a plan on the billing page.
						</Card>
					) : overview.data.requests.some((r) => r.status === "open") ? null : (
						<RequestForm />
					)}
				</>
			)}
		</>
	);
}

/** The organization's requests, newest first. Renders nothing before the first one. */
function RequestList({ requests }: { requests: readonly EarlyAccessRequestView[] }) {
	if (requests.length === 0) return null;
	return (
		<SettingsSection title="Your requests">
			<Card className="divide-y divide-border">
				{requests.map((r) => (
					<div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
						<div className="min-w-0 space-y-0.5">
							<p className="text-ui-md font-medium text-text-primary">{planLabel(r.plan)}</p>
							<p className="font-mono text-ui-xs text-text-tertiary">
								{r.vatId} · filed {formatDate(r.createdAt)}
								{r.vies === "invalid" ? " · VIES did not confirm this number" : ""}
							</p>
						</div>
						<StatusBadge
							status={r.status}
							tier={STATUS_COPY[r.status].tier}
							label={STATUS_COPY[r.status].label}
						/>
					</div>
				))}
			</Card>
		</SettingsSection>
	);
}

/** The request form. */
function RequestForm() {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const [filed, setFiled] = useState(false);
	const form = useForm<FormInput, unknown, FormData>({
		resolver: zodResolver(schema),
		defaultValues: { vatId: "", note: "" },
	});
	const busy = form.formState.isSubmitting;
	const vatFieldId = useId();
	const noteFieldId = useId();

	/** Files the request and refreshes the list. */
	async function submit(values: FormData) {
		setError(null);
		const result = await requestEarlyAccess({
			plan: values.plan,
			vatId: values.vatId,
			note: values.note || undefined,
		});
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setFiled(true);
		await queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
	}

	if (filed) {
		return (
			<SettingsSection title="Request a grant">
				<Card className="p-6 text-ui-md text-text-secondary">
					Request sent. We will review it and reply by email to your organization&apos;s owner.
				</Card>
			</SettingsSection>
		);
	}

	return (
		<SettingsSection title="Request a grant">
			<Card className="p-6">
				<form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4">
					<fieldset className="space-y-1.5" disabled={busy}>
						<legend className="flex items-center gap-1.5 text-ui-md font-medium text-text-primary">
							Plan
							<span className="font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
								required
							</span>
						</legend>
						<div className="space-y-2 pt-1">
							{PLAN_OPTIONS.map((option) => (
								<label
									key={option.value}
									className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-3 transition-colors hover:border-border-strong has-[:checked]:border-border-strong has-[:checked]:bg-surface-sunken"
								>
									<input
										type="radio"
										value={option.value}
										className="mt-0.5 size-4 shrink-0 accent-[var(--text-primary)]"
										{...form.register("plan")}
									/>
									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="text-ui-sm font-medium text-text-primary">{option.label}</span>
										<span className="text-ui-xs leading-snug text-text-tertiary">
											{option.description}
										</span>
									</span>
								</label>
							))}
						</div>
						{form.formState.errors.plan?.message && (
							<p className="text-ui-xs text-destructive">{form.formState.errors.plan.message}</p>
						)}
					</fieldset>

					<div className="space-y-1.5">
						<Label htmlFor={vatFieldId} className={fieldLabelClass}>
							VAT number
							<span className="font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
								required
							</span>
						</Label>
						<Input
							id={vatFieldId}
							placeholder="DE123456789"
							autoComplete="off"
							disabled={busy}
							aria-invalid={Boolean(form.formState.errors.vatId)}
							{...form.register("vatId")}
						/>
						<p className="text-ui-xs text-text-tertiary">
							We check it against the EU&apos;s VIES register. It is used only for this request.
						</p>
						{form.formState.errors.vatId?.message && (
							<p role="alert" className="text-ui-xs text-destructive">
								{form.formState.errors.vatId.message}
							</p>
						)}
					</div>

					<div className="space-y-1.5">
						<Label htmlFor={noteFieldId} className={fieldLabelClass}>
							Note (optional)
						</Label>
						<Textarea id={noteFieldId} rows={3} disabled={busy} {...form.register("note")} />
						<p className="text-ui-xs text-text-tertiary">
							Anything you would like us to know — for example, that you intend to subscribe once paid
							plans open in your country. A note is not binding on you or on us.
						</p>
						{form.formState.errors.note?.message && (
							<p role="alert" className="text-ui-xs text-destructive">
								{form.formState.errors.note.message}
							</p>
						)}
					</div>

					{error && (
						<p role="alert" className="text-ui-sm text-destructive">
							{error}
						</p>
					)}

					<Button type="submit" disabled={busy} className="self-start">
						{busy ? "Sending…" : "Request complimentary access"}
					</Button>
				</form>
			</Card>
		</SettingsSection>
	);
}
