"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
	type ConnectorCredentialSaved,
	saveConnectorCredential,
} from "@/app/server/actions/connectors";
import { StatusCallout, StoredNote } from "@/components/connectors/connection-ui";
import { connectorKeys } from "@/components/connectors/connectors-board";
import { FormRootError } from "@/components/forms/form-root-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { ConnectorField, ConnectorProviderMeta } from "@/lib/connectors/registry.generated";
import { PROJECT } from "@/lib/copy/vocabulary";
import { Button } from "@repo/ui/button";
import { FieldHelp } from "@repo/ui/field-help";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@repo/ui/form";
import { Input } from "@repo/ui/input";

interface ApiKeyConnectionProps {
	provider: ConnectorProviderMeta;
	/** Called when the person presses Done on the outcome: the sheet closes then, and only then. */
	onDone?: () => void;
}

/**
 * The form's values. The credential fields sit under `fields`, the same shape the action takes
 * (`saveConnectorCredential`), so the server's message for `fields.<key>` lands under the input
 * that is named `fields.<key>` with no translation between the two.
 */
interface CredentialValues {
	fields: Record<string, string>;
}

/**
 * The schema for one provider's credential: every field a string, and each field the registry
 * marks required refused when it is empty, with the message under that field. The set of fields
 * comes from the registry, so the schema is built from it; the action applies the same rule again.
 */
function credentialSchema(fields: readonly ConnectorField[]) {
	return z.object({ fields: z.record(z.string(), z.string()) }).superRefine((value, ctx) => {
		for (const field of fields) {
			if (field.required && !value.fields[field.key]?.trim()) {
				ctx.addIssue({
					code: "custom",
					path: ["fields", field.key],
					message: `${field.label} is required.`,
				});
			}
		}
	});
}

/**
 * Generic credential form for any api_key connector provider — fields are rendered from the
 * provider's registry credential project, so adding a new provider needs no new component. Submits
 * to `saveConnectorCredential` (which encrypts the secret fields and pings the provider to verify)
 * through `useActionMutation`: the submit is disabled while it runs, a field the server refuses is
 * reported under that field, and the board is invalidated when it settles.
 *
 * THE SHEET ENDS ON AN OUTCOME, NOT ON A CLOSE. When the save has been answered the form is
 * replaced by what happened — connected and verified, or saved but not verified, with the
 * provider's own reason — and a primary Done. It used to close the moment the action returned,
 * including when verification had failed, so the only trace of a credential the provider rejected
 * was a toast. An unverified save also offers "Edit credential", back to the form.
 *
 * A failure is shown once: a refusal in the callout above the form, a field problem under its
 * field, and only a failure with no place on the form (the network, an unexpected error) as a toast.
 */
export function ApiKeyConnection({ provider, onDone }: ApiKeyConnectionProps) {
	const schema = useMemo(() => credentialSchema(provider.credentialFields), [provider]);
	const form = useForm<CredentialValues>({
		resolver: zodResolver(schema),
		defaultValues: {
			fields: Object.fromEntries(provider.credentialFields.map((f) => [f.key, ""])),
		},
		mode: "onSubmit",
	});

	/** The refusal the action gave, shown above the form; cleared on the next submit. */
	const [refusal, setRefusal] = useState<string | null>(null);
	/** The answered save. While it is set the outcome is on screen instead of the form. */
	const [outcome, setOutcome] = useState<ConnectorCredentialSaved | null>(null);

	const save = useActionMutation(saveConnectorCredential, {
		invalidates: connectorKeys(),
		form: {
			instance: form,
			fields: provider.credentialFields.map((f) => `fields.${f.key}` as const),
		},
		onRefusal: (error) => setRefusal(error.message),
		onSuccess: (result) => setOutcome(result),
	});

	/** Sends the credential; a second submit while the first is in flight does nothing. */
	const onSubmit = form.handleSubmit((values) => {
		setRefusal(null);
		save.submit({ slug: provider.slug, fields: values.fields });
	});

	if (outcome) {
		return (
			<div className="space-y-5">
				<div role="status" data-slot="api-key-outcome">
					{outcome.verified ? (
						<StatusCallout variant="success" title="Connected and verified">
							{`${provider.name} is ready to use in a ${PROJECT.one}.`}
						</StatusCallout>
					) : (
						<StatusCallout variant="error" title="Saved, but not verified">
							{`${
								outcome.message
									? `${provider.name} did not accept the credential: ${outcome.message}`
									: `${provider.name} did not accept the credential.`
							} It is stored, and the connector reads Needs reconnection until a credential verifies.`}
						</StatusCallout>
					)}
				</div>
				<div className="flex flex-col gap-2">
					<Button type="button" className="h-9 w-full text-xs font-medium" onClick={onDone}>
						Done
					</Button>
					{!outcome.verified && (
						<Button
							type="button"
							variant="outline"
							className="h-9 w-full text-xs font-medium"
							onClick={() => setOutcome(null)}
						>
							Edit credential
						</Button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-5">
			<p className="text-sm text-muted-foreground">{provider.description}</p>

			{refusal && (
				<div role="alert">
					<StatusCallout variant="error" title="Could not connect">
						{refusal}
					</StatusCallout>
				</div>
			)}

			<Form {...form}>
				<form onSubmit={onSubmit} noValidate className="space-y-4">
					{provider.credentialFields.map((f) => (
						<FormField
							key={f.key}
							control={form.control}
							name={`fields.${f.key}` as const}
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel className="text-xs font-medium text-foreground">
											{f.label}
											{f.required && <span className="text-destructive"> *</span>}
										</FormLabel>
										{f.help && <FieldHelp title={f.label}>{f.help}</FieldHelp>}
									</div>
									<FormControl>
										<Input
											type={f.secret ? "password" : "text"}
											autoComplete="off"
											placeholder={f.help}
											className="h-9 border-border/60 text-sm"
											{...field}
										/>
									</FormControl>
									<FormMessage className="text-xs" />
								</FormItem>
							)}
						/>
					))}

					<FormRootError form={form} />

					<Button
						type="submit"
						className="h-9 w-full text-xs font-medium"
						pending={save.isPending}
					>
						{save.isPending ? "Connecting…" : "Connect"}
					</Button>
				</form>
			</Form>

			<StoredNote
				stored={`your ${provider.name} credential, encrypted at rest (AES-GCM) — decrypted only on the runner when a ${PROJECT.one} is deployed, never in a ${PROJECT.one} snapshot.`}
				revoke={`rotate or revoke the credential in ${provider.name} at any time to cut access.`}
			/>
		</div>
	);
}
