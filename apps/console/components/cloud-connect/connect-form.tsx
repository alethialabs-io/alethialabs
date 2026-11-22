"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The frame every cloud's connect form renders inside: the form element, the restored-draft line,
// where the press stands, and the one button. The cloud's own body — its method choice, its setup
// steps and its fields, each field inline in the step that produces its value — is `children`.
//
// It ends on an OUTCOME. A verified connect replaces the form with the result and a primary Done
// (B-03): the person is told it worked and leaves on purpose, instead of reading a callout beside
// a form they could press again. A failed verify keeps the form, says why under it, and the button
// reads Retry. While the verify runs the fields are disabled, the button spins, and a Cancel
// returns the form.

import { Skeleton } from "@repo/ui/skeleton";
import { Form } from "@repo/ui/form";
import { WizardFooter, WizardFormError, WizardRestoredNotice } from "@repo/ui/wizard";
import type { ReactNode } from "react";
import type { FieldValues } from "react-hook-form";
import type { ConnectFlow } from "@/components/cloud-connect/use-connect-wizard";
import { ConnectStatus } from "@/components/connectors/connection-ui";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/** Props of {@link ConnectForm}. */
export interface ConnectFormProps<V extends FieldValues, TOut> {
	readonly flow: ConnectFlow<V, TOut>;
	/** What a verified connection means for this cloud. */
	readonly successText: string;
	/** What is being checked while the verify runs. */
	readonly verifyingText: string;
	/** What Alethia keeps and how to revoke it (`StoredNote`), shown under the button. */
	readonly stored: ReactNode;
	readonly children: ReactNode;
}

/** The form's shape while the draft is being read: a field and the button, in place. */
function ConnectFormSkeleton() {
	return (
		<SkeletonRoot className="space-y-4" data-testid="connect-form-skeleton">
			<Skeleton className="h-4 w-32" />
			<Skeleton className="h-9 w-full" />
			<div className="flex justify-end">
				<Skeleton className="h-9 w-24" />
			</div>
		</SkeletonRoot>
	);
}

/** Renders one cloud's connect form around its body. See the header. */
export function ConnectForm<V extends FieldValues, TOut>({
	flow,
	successText,
	verifyingText,
	stored,
	children,
}: ConnectFormProps<V, TOut>) {
	const { wizard, state } = flow;
	if (!wizard.ready) return <ConnectFormSkeleton />;

	if (state.phase === "success") {
		return (
			<div className="space-y-4">
				<ConnectStatus
					state={state}
					successText={successText}
					verifyingText={verifyingText}
					onCancel={flow.cancel}
				/>
				<WizardFooter
					back={null}
					primary={{ kind: "submit", label: "Done", onPress: flow.done }}
					pending={false}
				/>
				{stored}
			</div>
		);
	}

	const saving = state.phase === "saving";
	return (
		<Form {...wizard.form}>
			<form
				noValidate
				onSubmit={(event) => {
					event.preventDefault();
					flow.submit();
				}}
				className="space-y-6"
			>
				{wizard.restored ? <WizardRestoredNotice onStartOver={wizard.discard} /> : null}
				<fieldset disabled={saving} className="min-w-0 space-y-6">
					{children}
				</fieldset>
				<div className="space-y-4 border-border/60 border-t pt-6">
					<ConnectStatus
						state={state}
						successText={successText}
						verifyingText={verifyingText}
						onCancel={flow.cancel}
					/>
					<WizardFormError message={wizard.formError} />
					<WizardFooter
						back={null}
						primary={{
							kind: "submit",
							label: state.phase === "failed" ? "Retry" : "Connect",
							onPress: flow.submit,
						}}
						pending={saving}
					/>
					{stored}
				</div>
			</form>
		</Form>
	);
}
