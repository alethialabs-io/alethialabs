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
import { InfoNote, StatusCallout } from "@/components/connector/connection-ui";
import type { ConnectorProviderMeta } from "@/lib/connectors/registry.generated";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

interface ApiKeyConnectionProps {
	provider: ConnectorProviderMeta;
	onConnected?: () => void;
}

type SubmitState =
	| { phase: "idle" }
	| { phase: "saving" }
	| { phase: "success"; verified: boolean; message?: string }
	| { phase: "failed"; error: string };

/**
 * Generic credential form for any api_key connector provider — fields are
 * rendered from the provider's registry credential project, so adding a new provider
 * needs no new component. Submits to saveConnectorCredential (which encrypts the
 * secret fields and pings the provider to verify).
 */
export function ApiKeyConnection({
	provider,
	onConnected,
}: ApiKeyConnectionProps) {
	const router = useRouter();
	const [state, setState] = useState<SubmitState>({ phase: "idle" });

	// Defaults from the declarative field project. Validation is per-field below —
	// the dynamic field set has no static shape, so we validate on submit rather
	// than via a schema resolver, and the server action re-validates + verifies.
	const defaults: Record<string, string> = {};
	for (const f of provider.credentialFields) defaults[f.key] = "";

	type FormValues = Record<string, string>;

	const form = useForm<FormValues>({
		defaultValues: defaults,
		mode: "onSubmit",
	});

	const onSubmit = async (values: FormValues) => {
		// Required-field validation (registry-driven) with inline messages.
		let hasError = false;
		for (const f of provider.credentialFields) {
			if (f.required && !values[f.key]?.trim()) {
				form.setError(f.key, { message: `${f.label} is required.` });
				hasError = true;
			}
		}
		if (hasError) return;

		setState({ phase: "saving" });
		try {
			const result = await saveConnectorCredential(provider.slug, values);
			if (!result.ok) {
				setState({ phase: "failed", error: result.error });
				return;
			}
			setState({
				phase: "success",
				verified: result.verified,
				message: result.message,
			});
			if (result.verified) {
				toast.success(`${provider.name} connected and verified.`);
			} else {
				toast.warning(
					`${provider.name} saved, but verification failed${
						result.message ? `: ${result.message}` : "."
					}`,
				);
			}
			router.refresh();
			onConnected?.();
		} catch (err) {
			setState({
				phase: "failed",
				error:
					err instanceof Error ? err.message : "Failed to save credential.",
			});
		}
	};

	return (
		<div className="space-y-5">
			<p className="text-sm text-muted-foreground">{provider.description}</p>

			{state.phase === "success" && (
				<StatusCallout
					variant="success"
					title={state.verified ? "Connected and verified" : "Saved"}
				>
					{state.verified
						? `${provider.name} is ready to use in a Project.`
						: (state.message ??
							"The credential was stored but could not be verified.")}
				</StatusCallout>
			)}

			{state.phase === "failed" && (
				<StatusCallout variant="error" title="Could not connect">
					{state.error}
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
											className="h-9 text-sm border-border/50"
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
						disabled={state.phase === "saving"}
					>
						{state.phase === "saving" && (
							<Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
						)}
						{state.phase === "success" ? "Update credential" : "Connect"}
					</Button>
				</form>
			</Form>

			<InfoNote>
				Secrets are encrypted at rest and only decrypted on the runner at
				provision time — never stored in a Project snapshot.
			</InfoNote>
		</div>
	);
}
