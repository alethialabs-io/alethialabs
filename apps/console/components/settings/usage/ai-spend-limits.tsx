"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Admin AI-spend limits (Claude-Enterprise style): an org-wide and a per-member weekly
// ceiling that only ever TIGHTEN the plan's included caps. Shown on the AI usage card to
// admins (manage_billing) only. Entered in USD/week; stored as credits ($0.001/credit).
//
// F047 (#6127): an invalid value used to make Save do NOTHING — no message, no toast, and the
// value silently not persisted (`-5` was coerced to "no limit"; `1e20` overflowed the column and
// failed unhandled) — and a valid save gave no confirmation. The form is react-hook-form over the
// shared zod schema now (`spend-limits.ts`): an invalid field says why inline before anything is
// sent, the server re-validates with the SAME limits and its field errors land on the same inputs,
// the button is disabled while the save is in flight, and a save says so.

import { zodResolver } from "@hookform/resolvers/zod";
import { type UseFormRegisterReturn, useForm } from "react-hook-form";
import { saveAiSpendLimits } from "@/app/server/actions/billing";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	MAX_LABEL,
	SERVER_TO_FORM_FIELD,
	type SpendLimitsFormValues,
	spendLimitsForm,
	toCredits,
	toDollars,
} from "./spend-limits";

/** Whether a server field name is one of this form's (a narrowing, not a cast). */
function isServerField(key: string): key is keyof typeof SERVER_TO_FORM_FIELD {
	return key in SERVER_TO_FORM_FIELD;
}

/**
 * The two spend-limit fields + a Save. Seeds from the current caps; a blank field clears the
 * limit (back to the plan default). The parent re-keys this on the stored values, so a successful
 * save — which invalidates `usage.ai` — re-seeds the form from what the server actually stored.
 */
export function AiSpendLimits({
	orgWeeklyCapCredits,
	perUserWeeklyCapCredits,
}: {
	orgWeeklyCapCredits: number | null;
	perUserWeeklyCapCredits: number | null;
}) {
	const form = useForm<SpendLimitsFormValues>({
		resolver: zodResolver(spendLimitsForm),
		mode: "onChange",
		defaultValues: {
			orgWeeklyCap: toDollars(orgWeeklyCapCredits),
			perUserWeeklyCap: toDollars(perUserWeeklyCapCredits),
		},
	});
	const { errors, isDirty } = form.formState;

	const save = useActionMutation(saveAiSpendLimits, {
		// The AI card shows the limits AND the budgets they tighten; the overview's usage card shows
		// the same budgets (#6118) — `usage.ai` is the read both render from.
		invalidates: [orpc.usage.ai.key()],
		successMessage: "Spend limits saved.",
		onValidationError: (fields) => {
			for (const [key, messages] of Object.entries(fields)) {
				const message = messages?.[0];
				if (!message) continue;
				if (isServerField(key)) form.setError(SERVER_TO_FORM_FIELD[key], { message });
				else form.setError("root", { message });
			}
		},
	});

	const onSubmit = form.handleSubmit((values) =>
		save.mutate({
			orgWeeklyCapCredits: toCredits(values.orgWeeklyCap),
			perUserWeeklyCapCredits: toCredits(values.perUserWeeklyCap),
		}),
	);

	return (
		<form className="border-t border-border px-6 py-4" onSubmit={onSubmit} noValidate>
			<div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
				<span className="font-mono text-ui-2xs uppercase tracking-[0.1em] text-text-tertiary">
					Spend limits
				</span>
				<span className="text-ui-xs text-text-tertiary">
					Weekly ceilings on top of your plan — AI pauses here. Leave blank for none; $0
					pauses the plan&apos;s included AI.
				</span>
			</div>
			<div className="flex flex-wrap items-start gap-3">
				<CapField
					id="ai-cap-org"
					label="Whole org / week"
					error={errors.orgWeeklyCap?.message}
					{...form.register("orgWeeklyCap")}
				/>
				<CapField
					id="ai-cap-member"
					label="Per member / week"
					error={errors.perUserWeeklyCap?.message}
					{...form.register("perUserWeeklyCap")}
				/>
				<Button
					type="submit"
					size="sm"
					variant="outline"
					className="mt-[18px] rounded-none"
					disabled={!isDirty || save.isPending}
				>
					{save.isPending ? "Saving…" : "Save limits"}
				</Button>
			</div>
			{errors.root?.message ? (
				<p role="alert" className="mt-2 text-ui-xs text-destructive">
					{errors.root.message}
				</p>
			) : null}
		</form>
	);
}

/** A single dollars/week input with a `$` adornment and its inline error. */
function CapField({
	id,
	label,
	error,
	...input
}: {
	id: string;
	label: string;
	error: string | undefined;
} & UseFormRegisterReturn<keyof SpendLimitsFormValues>) {
	const errorId = `${id}-error`;
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={id} className="font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
				{label}
			</label>
			<span className="flex items-center gap-1 border border-border bg-background px-2">
				<span className="text-ui-sm text-text-tertiary">$</span>
				<Input
					id={id}
					type="text"
					inputMode="decimal"
					autoComplete="off"
					placeholder="No limit"
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? errorId : undefined}
					title={`Up to ${MAX_LABEL} a week`}
					className="h-8 w-28 rounded-none border-0 bg-transparent px-0 text-ui-md shadow-none focus-visible:ring-0"
					{...input}
				/>
			</span>
			{error ? (
				<span id={errorId} role="alert" className="max-w-[14rem] text-ui-xs text-destructive">
					{error}
				</span>
			) : null}
		</div>
	);
}
