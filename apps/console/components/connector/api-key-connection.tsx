"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { saveConnectorCredential } from "@/app/server/actions/connectors";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { IntegrationProviderMeta } from "@/lib/integrations/registry.generated";
import { AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

interface ApiKeyConnectionProps {
	provider: IntegrationProviderMeta;
	onConnected?: () => void;
}

type SubmitState =
	| { phase: "idle" }
	| { phase: "saving" }
	| { phase: "success"; verified: boolean; message?: string }
	| { phase: "failed"; error: string };

/**
 * Generic credential form for any api_key integration provider — fields are
 * rendered from the provider's registry credential spec, so adding a new provider
 * needs no new component. Submits to saveConnectorCredential (which encrypts the
 * secret fields and pings the provider to verify).
 */
export function ApiKeyConnection({
	provider,
	onConnected,
}: ApiKeyConnectionProps) {
	const router = useRouter();
	const [state, setState] = useState<SubmitState>({ phase: "idle" });

	// Defaults from the declarative field spec. Validation is per-field below —
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
				<div className="flex items-start gap-3 p-4 bg-muted/40 border border-border rounded-md">
					<CheckCircle2 className="w-5 h-5 text-foreground shrink-0" />
					<div>
						<p className="text-sm font-medium text-foreground">
							{state.verified ? "Connected and verified" : "Saved"}
						</p>
						<p className="text-xs text-muted-foreground mt-0.5">
							{state.verified
								? `${provider.name} is ready to use in a Spec.`
								: state.message ??
									"The credential was stored but could not be verified."}
						</p>
					</div>
				</div>
			)}

			{state.phase === "failed" && (
				<div className="flex items-start gap-3 p-4 bg-destructive/5 border border-destructive/20 rounded-md">
					<XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
					<div>
						<p className="text-sm font-medium text-destructive">
							Could not connect
						</p>
						<p className="text-xs text-muted-foreground mt-0.5">
							{state.error}
						</p>
					</div>
				</div>
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
									<FormLabel className="text-xs font-medium text-foreground">
										{f.label}
										{f.required && (
											<span className="text-destructive"> *</span>
										)}
									</FormLabel>
									<FormControl>
										<Input
											type={f.secret ? "password" : "text"}
											autoComplete="off"
											placeholder={f.help}
											className="h-9 text-sm border-border/50"
											{...field}
										/>
									</FormControl>
									{f.help && (
										<FormDescription className="text-[11px]">
											{f.help}
										</FormDescription>
									)}
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

			<div className="flex items-start gap-2.5 p-3 bg-muted/20 rounded-md border border-border/40 text-[11px] text-muted-foreground">
				<AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
				<p className="leading-relaxed">
					Secrets are encrypted at rest and only decrypted on the runner at
					provision time — never stored in a Spec snapshot.
				</p>
			</div>
		</div>
	);
}
