"use client";

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import { ACCEPTANCE_LABELS } from "@repo/legal/documents";
import { acceptLegalDocuments } from "@/app/server/actions/legal";

/** One document awaiting acceptance, as the page resolved it. */
export interface PendingDocument {
	id: string;
	title: string;
	version: string;
	path: string;
}

const schema = z.object({
	/**
	 * A single, unticked box. Not pre-ticked, and not implied by pressing the button: an acceptance
	 * the user did not perform is not an acceptance, and a pre-ticked box is the textbook example of
	 * consent that was never given.
	 */
	accepted: z.boolean().refine((v) => v, {
		message: "Tick the box to accept the Terms.",
	}),
});

type FormValues = z.infer<typeof schema>;

/** Where the marketing site serving the legal documents lives. */
const MARKETING_ORIGIN =
	process.env.NEXT_PUBLIC_MARKETING_URL ?? "https://alethialabs.io";

/**
 * The clickwrap itself.
 *
 * Two properties matter more than the styling, and both are easy to lose in a redesign:
 *
 *  1. The box starts UNTICKED and the button is inert until it is ticked — a positive act, by the
 *     person, recorded at a moment.
 *  2. The document is LINKED at the exact version being accepted, and the version is shown. An
 *     acceptance of "the Terms" with no version is not evidence of anything.
 */
export function AcceptTermsForm({
	documents,
	next,
}: {
	documents: PendingDocument[];
	next: string;
}) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const { control, handleSubmit, formState } = useForm<FormValues>({
		resolver: zodResolver(schema),
		defaultValues: { accepted: false },
		// The button must be inert until the box is ticked, and `isValid` only tracks that under
		// onChange validation — with the default (onSubmit) it stays false until the first submit,
		// which would leave the button disabled even after a correct tick.
		mode: "onChange",
	});
	const { isSubmitting, isValid } = formState;

	async function onSubmit() {
		setError(null);
		try {
			await acceptLegalDocuments({
				documentIds: documents.map((d) => d.id),
				locale: "en",
				surface: "console-gate",
				context: "reacceptance",
				// The browser's own clock, recorded alongside the server's. A large gap between the two
				// is itself a signal, and reconciling them later needs both.
				clientTimestamp: new Date().toISOString(),
			});
			router.replace(next);
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "Could not record your acceptance.",
			);
		}
	}

	return (
		<form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h1 className="text-xl font-medium">
					{documents.length > 1 ? "Updated agreements" : "Our Terms have changed"}
				</h1>
				<p className="text-sm text-muted-foreground">
					Read and accept to continue. Your work is untouched — nothing has been
					removed and nothing expires while you decide.
				</p>
			</div>

			<ul className="flex flex-col gap-2 text-sm">
				{documents.map((doc) => (
					<li key={doc.id}>
						<a
							className="underline underline-offset-4"
							href={`${MARKETING_ORIGIN}${doc.path}`}
							rel="noopener noreferrer"
							target="_blank"
						>
							{doc.title}
						</a>{" "}
						<span className="text-muted-foreground">
							(version {doc.version})
						</span>
					</li>
				))}
			</ul>

			<label className="flex items-start gap-3 text-sm">
				<Controller
					control={control}
					name="accepted"
					render={({ field }) => (
						<Checkbox
							checked={field.value === true}
							onCheckedChange={(v) => field.onChange(v === true)}
						/>
					)}
				/>
				<span>
					{ACCEPTANCE_LABELS.checkboxPrefix} the{" "}
					{documents.map((d) => d.title).join(" and ")}.
				</span>
			</label>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<Button type="submit" disabled={!isValid || isSubmitting}>
				{isSubmitting ? "Recording…" : ACCEPTANCE_LABELS.submit}
			</Button>
		</form>
	);
}
