"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { saveConnectorCredential } from "@/app/server/actions/connectors";
import { Button } from "@repo/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { FieldHelp } from "@repo/ui/field-help";
import { StatusCallout, StoredNote } from "@/components/connectors/connection-ui";
import type { ConnectorProviderMeta } from "@/lib/connectors/registry.generated";
import { connectorKeys } from "@/components/connectors/connectors-board";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

interface ApiKeyConnectionProps {
	provider: ConnectorProviderMeta;
	onConnected?: () => void;
}

/**
 * Generic credential form for any api_key connector provider — fields are rendered from the
 * provider's registry credential project, so adding a new provider needs no new component. Submits
 * to `saveConnectorCredential` (which encrypts the secret fields and pings the provider to verify)
 * through `useActionMutation`: the submit is disabled while it runs, a required field the server
 * finds empty is reported under that field, and the board is invalidated when it settles.
 */
export function ApiKeyConnection({
	provider,
	onConnected,
}: ApiKeyConnectionProps) {
	// Defaults from the declarative field project. Validation is per-field below — the dynamic field
	// set has no static shape, so it is validated on submit rather than via a schema resolver, and
	// the server action re-validates + verifies.
	const defaults: Record<string, string> = {};
	for (const f of provider.credentialFields) defaults[f.key] = "";

	type FormValues = Record<string, string>;

	const form = useForm<FormValues>({
		defaultValues: defaults,
		mode: "onSubmit",
	});

	const save = useActionMutation(saveConnectorCredential, {
		invalidates: connectorKeys(),
		// The server reports a field as `fields.<key>`; the form names it `<key>`.
		onValidationError: (fields) => {
			for (const [path, messages] of Object.entries(fields)) {
				const message = messages?.[0];
				if (!message) continue;
				const key = path.startsWith("fields.") ? path.slice("fields.".length) : path;
				if (key in defaults) form.setError(key, { message });
				else form.setError("root", { message });
			}
		},
		onSuccess: (result) => {
			if (result.verified) {
				toast.success(`${provider.name} connected and verified.`);
			} else {
				toast.warning(
					`${provider.name} saved, but verification failed${result.message ? `: ${result.message}` : "."}`,
				);
			}
			onConnected?.();
		},
	});

	const onSubmit = (values: FormValues) => {
		// Required-field validation (registry-driven) with inline messages.
		let hasError = false;
		for (const f of provider.credentialFields) {
			if (f.required && !values[f.key]?.trim()) {
				form.setError(f.key, { message: `${f.label} is required.` });
				hasError = true;
			}
		}
		if (hasError || save.isPending) return;
		save.mutate({ slug: provider.slug, fields: values });
	};

	// A refusal shows here; a validation refusal shows under its field instead, so not twice.
	const failure =
		save.error && save.error.error.kind !== "validation"
			? save.error.message
			: form.formState.errors.root?.message;

	return (
		<div className="space-y-5">
			<p className="text-sm text-muted-foreground">{provider.description}</p>

			{save.data && (
				<StatusCallout
					variant="success"
					title={save.data.verified ? "Connected and verified" : "Saved"}
				>
					{save.data.verified
						? `${provider.name} is ready to use in a Project.`
						: (save.data.message ??
							"The credential was stored but could not be verified.")}
				</StatusCallout>
			)}

			{failure && (
				<StatusCallout variant="error" title="Could not connect">
					{failure}
				</StatusCallout>
			)}

			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="space-y-4"
				>
					{provider.credentialFields.map((f) => (
						<FormField
							key={f.key}
							control={form.control}
							name={f.key}
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel className="text-xs font-medium text-foreground">
											{f.label}
											{f.required && (
												<span className="text-destructive"> *</span>
											)}
										</FormLabel>
										{f.help && (
											<FieldHelp title={f.label}>{f.help}</FieldHelp>
										)}
									</div>
									<FormControl>
										<Input
											type={f.secret ? "password" : "text"}
											autoComplete="off"
											placeholder={f.help}
											className="h-9 text-sm border-border/60"
											{...field}
										/>
									</FormControl>
									<FormMessage className="text-xs" />
								</FormItem>
							)}
						/>
					))}

					<Button
						type="submit"
						className="w-full h-9 text-xs font-medium"
						disabled={save.isPending}
					>
						{save.isPending && (
							<Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
						)}
						{save.data ? "Update credential" : "Connect"}
					</Button>
				</form>
			</Form>

			<StoredNote
				stored={`your ${provider.name} credential, encrypted at rest (AES-GCM) — decrypted only on the runner at provision time, never in a Project snapshot.`}
				revoke={`rotate or revoke the credential in ${provider.name} at any time to cut access.`}
			/>
		</div>
	);
}
