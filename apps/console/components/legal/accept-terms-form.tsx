"use client";

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Fragment, useId } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import { acceptLegalDocuments } from "@/app/server/actions/legal";
import {
	ACCEPTANCE_LOCALE,
	type AcceptanceDocument,
	type CopySegment,
	checkboxLabel,
	gateHeading,
	noticeLine,
	requiredMessage,
	TERMS_ACCEPTANCE_TEXT,
} from "@/components/legal/terms-acceptance-copy";
import { ROOT_SERVER_ERROR } from "@/lib/actions/form-errors";

/**
 * Renders copy segments: plain text, or a link to a legal page that opens in a new tab. Text is a bare
 * text node, never a wrapping element: the box's accessible name is computed from this label, and a
 * wrapper per run drops the spaces at each run's edge ("theTerms of Service(version …)").
 */
function Segments({ segments }: { segments: readonly CopySegment[] }) {
	return (
		<>
			{segments.map((segment, i) =>
				segment.kind === "link" ? (
					<a
						key={`${segment.documentId}-${i}`}
						className="underline underline-offset-4"
						href={segment.href}
						rel="noopener noreferrer"
						target="_blank"
					>
						{segment.text}
					</a>
				) : (
					<Fragment key={`text-${i}`}>{segment.text}</Fragment>
				),
			)}
		</>
	);
}

/**
 * The `/accept-terms` clickwrap: shown after sign-in when a document the person must accept reaches
 * a version they have not accepted. A new account accepts inline on onboarding instead (WIZ-W6), so
 * in practice this is the RE-acceptance screen.
 *
 * Two properties matter more than the styling, and both are easy to lose in a redesign:
 *
 *  1. The box starts UNTICKED and the button is inert until it is ticked — a positive act, by the
 *     person, recorded at a moment.
 *  2. Each document is LINKED, and its sealed version is printed INSIDE the label the person ticks.
 *     An acceptance of "the Terms" with no version is not evidence of anything.
 *
 * Every word comes from `terms-acceptance-copy.ts`, the module onboarding renders from too, so the
 * two surfaces cannot word the same agreement differently. Links go through `legalUrl`.
 */
export function AcceptTermsForm({
	documents,
	next,
}: {
	documents: readonly AcceptanceDocument[];
	next: string;
}) {
	const router = useRouter();
	const labelId = useId();
	const schema = z.object({
		/**
		 * A single, unticked box. Not pre-ticked, and not implied by pressing the button: an acceptance
		 * the user did not perform is not an acceptance.
		 */
		accepted: z.boolean().refine((v) => v, { message: requiredMessage(documents) }),
	});
	const form = useForm<{ accepted: boolean }>({
		resolver: zodResolver(schema),
		defaultValues: { accepted: false },
	});
	const { control, handleSubmit, formState } = form;
	const { isSubmitting, errors } = formState;
	// The button follows the box itself, not `isValid`: a recorded failure sets a root error, and a
	// root error would leave `isValid` false until the box was unticked and ticked again.
	const accepted = useWatch({ control, name: "accepted" });
	const copy = gateHeading(documents);
	const notice = noticeLine();
	const failure = errors.root?.server?.message;

	/** Records the acceptance, then continues to where the person was going. */
	async function onSubmit() {
		try {
			await acceptLegalDocuments({
				documentIds: documents.map((d) => d.id),
				locale: ACCEPTANCE_LOCALE,
				// No context and no surface: WHY this acceptance happened and where it was shown are
				// decided by the server from the stored history, never asserted from here (#5009).
				// The browser's own clock, recorded alongside the server's.
				clientTimestamp: new Date().toISOString(),
			});
			router.replace(next);
		} catch {
			// A thrown server error reaches a production build as a digest, never a sentence the
			// person can use (A-07), so the form's own sentence is shown instead of its message.
			form.setError(ROOT_SERVER_ERROR, { type: "server", message: TERMS_ACCEPTANCE_TEXT.recordFailed });
		}
	}

	return (
		<form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
					{copy.heading}
				</h1>
				<p className="text-ui-md text-text-tertiary">{copy.body}</p>
			</div>

			<div className="flex flex-col gap-2">
				<label className="flex items-start gap-3 text-ui-md">
					<Controller
						control={control}
						name="accepted"
						render={({ field }) => (
							<Checkbox
								ref={field.ref}
								checked={field.value === true}
								onCheckedChange={(v) => field.onChange(v === true)}
								aria-labelledby={labelId}
								className="mt-0.5"
							/>
						)}
					/>
					<span id={labelId}>
						<Segments segments={checkboxLabel(documents)} />
					</span>
				</label>
				{notice.length > 0 ? (
					<p className="pl-7 text-ui-sm text-text-tertiary">
						<Segments segments={notice} />
					</p>
				) : null}
			</div>

			{failure ? (
				<p role="alert" className="text-ui-md text-destructive">
					{failure}
				</p>
			) : null}

			<Button type="submit" disabled={!accepted || isSubmitting} className="h-[46px] w-full text-sm">
				{isSubmitting ? TERMS_ACCEPTANCE_TEXT.submitting : TERMS_ACCEPTANCE_TEXT.submit}
			</Button>
		</form>
	);
}
