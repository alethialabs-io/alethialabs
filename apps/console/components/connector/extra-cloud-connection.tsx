"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@repo/ui/card";
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
import { zodResolver } from "@hookform/resolvers/zod";
import {
	ConnectionTestStatus,
	InfoNote,
	StatusCallout,
} from "@/components/connector/connection-ui";
import {
	type ConnTestState,
	type VerifyOutcome,
	useConnectionTest,
} from "@/components/connector/use-connection-test";
import { Download, ExternalLink, ShieldCheck } from "lucide-react";
import { type ReactNode } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

/** A save action's instant server-side verify outcome (drives the connect flow). */
type SaveResult = VerifyOutcome;

/** Numbered step, identical to the aws/gcp/azure sheets. */
function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
	return (
		<div className="flex gap-4">
			<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
				{n}
			</div>
			<div className="space-y-3 flex-1 min-w-0">
				<div className="font-medium text-sm text-foreground">{title}</div>
				{children}
			</div>
		</div>
	);
}

/**
 * Verify section + form. While the instant server-side verify is in flight it shows the shared
 * verifying/success status (with Cancel); on idle/failure it shows the provider-specific form
 * (`children`). Mirrors the aws/gcp/azure sheets.
 */
function VerifySection({
	state,
	successText,
	verifyingText,
	onCancel,
	children,
}: {
	state: ConnTestState;
	successText: string;
	verifyingText: string;
	onCancel: () => void;
	children: ReactNode;
}) {
	const inFlight = state.phase === "success" || state.phase === "saving";
	return (
		<div className="pt-6 border-t border-border/40">
			{inFlight ? (
				<ConnectionTestStatus
					phase={state.phase}
					status={state.status}
					missingPermissions={state.missingPermissions}
					successText={successText}
					verifyingText={verifyingText}
					onCancel={onCancel}
				/>
			) : (
				<>
					{state.phase === "failed" && (
						<div className="mb-4">
							<StatusCallout variant="error" title="Verification failed">
								{state.error}
							</StatusCallout>
						</div>
					)}
					{children}
				</>
			)}
		</div>
	);
}

// --- Token clouds: DigitalOcean / Hetzner / Civo ---

const tokenSchema = z.object({ token: z.string().min(16, "Enter a valid API token.") });

export function TokenCloudConnection({
	providerName,
	tokenHelp,
	docsUrl,
	onSave,
}: {
	providerName: string;
	tokenHelp: string;
	docsUrl?: string;
	onSave: (token: string) => Promise<SaveResult>;
}) {
	const { state, run, cancel } = useConnectionTest();
	const form = useForm<{ token: string }>({
		resolver: zodResolver(tokenSchema),
		defaultValues: { token: "" },
		mode: "onChange",
	});

	const retry = state.phase === "failed";

	return (
		<div className="max-w-[800px] mx-auto space-y-6 w-full">
			<Card className="border-border/40 shadow-sm bg-background">
				<CardHeader className="border-b border-border/40 pb-4 bg-muted/5">
					<CardTitle className="text-base font-medium flex items-center gap-2">
						<ShieldCheck className="w-4.5 h-4.5 text-muted-foreground" />
						Setup Instructions
					</CardTitle>
					<CardDescription className="text-xs">
						{`${providerName} has no role federation, so Alethia connects with a scoped API token. Grant it only the permissions provisioning needs.`}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6 pt-6">
					<div className="space-y-8">
						<Step n={1} title={`Create an API token in ${providerName}`}>
							<p className="text-xs text-muted-foreground max-w-sm">{tokenHelp}</p>
							{docsUrl && (
								<Button
									onClick={() => window.open(docsUrl, "_blank")}
									size="sm"
									className="h-8 text-xs font-medium"
									type="button"
								>
									<ExternalLink className="w-3.5 h-3.5 mr-1.5 opacity-70" />
									Open {providerName} token settings
								</Button>
							)}
						</Step>
						<Step n={2} title="Paste the token below">
							<p className="text-xs text-muted-foreground max-w-sm">
								Alethia verifies it immediately and stores it encrypted (AES-GCM) — it is
								only decrypted on the runner at provision time, never in a project snapshot.
							</p>
						</Step>
					</div>

					<VerifySection
						state={state}
						onCancel={cancel}
						successText={`Alethia can authenticate into ${providerName} with your token. You're ready to provision infrastructure.`}
						verifyingText={`Testing your ${providerName} token against the ${providerName} API.`}
					>
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit((d) => run(() => onSave(d.token)))}
								className="space-y-4"
							>
								<FormField
									control={form.control}
									name="token"
									render={({ field }) => (
										<FormItem>
											<div className="flex items-center gap-1.5">
												<FormLabel className="text-xs font-medium">API Token</FormLabel>
												<FieldHelp title={`${providerName} API token`}>
													{tokenHelp} Alethia encrypts it at rest and only decrypts it
													on the runner at provision time.
												</FieldHelp>
											</div>
											<FormControl>
												<Input
													type="password"
													placeholder="Paste your scoped API token"
													className="h-9 text-sm font-mono border-border/50"
													{...field}
												/>
											</FormControl>
											<FormMessage className="text-xs" />
										</FormItem>
									)}
								/>
								<Button
									disabled={!form.formState.isValid}
									type="submit"
									className="w-full h-9 text-xs font-medium"
								>
									{retry ? "Retry" : "Connect"}
								</Button>
							</form>
						</Form>
						<div className="mt-5">
							<InfoNote>
								Revoke the token in {providerName} at any time to cut Alethia&apos;s access.
							</InfoNote>
						</div>
					</VerifySection>
				</CardContent>
			</Card>
		</div>
	);
}

// --- Alibaba: RAM role (zero stored credentials) ---

const alibabaSchema = z.object({
	roleArn: z
		.string()
		.regex(/^acs:ram::\d+:role\/[\w+=,.@-]+$/, "Expected acs:ram::<account-id>:role/<role-name>"),
});

export function AlibabaConnection({
	onSave,
}: {
	onSave: (roleArn: string) => Promise<SaveResult>;
}) {
	const { state, run, cancel } = useConnectionTest();
	const form = useForm<{ roleArn: string }>({
		resolver: zodResolver(alibabaSchema),
		defaultValues: { roleArn: "" },
		mode: "onChange",
	});

	const retry = state.phase === "failed";

	/** Downloads the customer setup Terraform module (served from public/). */
	const downloadModule = () => {
		const a = document.createElement("a");
		a.href = "/connector-terraform/alibaba.tf";
		a.download = "alethia-alibaba.tf";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	};

	return (
		<div className="max-w-[800px] mx-auto space-y-6 w-full">
			<Card className="border-border/40 shadow-sm bg-background">
				<CardHeader className="border-b border-border/40 pb-4 bg-muted/5">
					<CardTitle className="text-base font-medium flex items-center gap-2">
						<ShieldCheck className="w-4.5 h-4.5 text-muted-foreground" />
						Setup Instructions
					</CardTitle>
					<CardDescription className="text-xs">
						Keyless: you create a RAM OIDC provider trusting Alethia&apos;s issuer + a RAM
						role. Alethia assumes it with a short-lived minted token — no Alibaba credentials
						are stored. Create the resources, then paste the role ARN.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6 pt-6">
					<div className="space-y-8">
						<Step n={1} title="Create the RAM OIDC provider + role">
							<p className="text-xs text-muted-foreground max-w-sm">
								Apply the Terraform module below. It registers a RAM OIDC provider that
								trusts Alethia&apos;s issuer and a role that trusts that provider (scoped
								to Alethia&apos;s workload identity), then attaches provisioning
								permissions.
							</p>
							<div className="mt-2 flex flex-wrap items-center gap-3">
								<Button
									type="button"
									size="sm"
									className="h-8 text-xs font-medium"
									onClick={downloadModule}
								>
									<Download className="w-3.5 h-3.5 mr-1.5 opacity-70" />
									Download module
								</Button>
								<a
									href="/docs/console/connectors/alibaba"
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
								>
									Full guide
									<ExternalLink className="w-3 h-3" />
								</a>
							</div>
						</Step>

						<Step n={2} title="Paste the role ARN below">
							<p className="text-xs text-muted-foreground max-w-sm">
								Run{" "}
								<code className="bg-muted px-1 py-0.5 border border-border/50 rounded">terraform output</code>{" "}
								and copy <code className="bg-muted px-1 py-0.5 border border-border/50 rounded">role_arn</code> — it
								looks like{" "}
								<code className="bg-muted px-1 py-0.5 border border-border/50 rounded">acs:ram::&lt;account&gt;:role/&lt;name&gt;</code>.
								(Alethia derives the OIDC-provider ARN from it.)
							</p>
						</Step>
					</div>

					<VerifySection
						state={state}
						onCancel={cancel}
						successText="Alethia recorded your RAM role and verified it with a real STS AssumeRoleWithOIDC — zero stored credentials."
						verifyingText="Assuming the RAM role via Alibaba STS (AssumeRoleWithOIDC)."
					>
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit((d) => run(() => onSave(d.roleArn)))}
								className="space-y-4"
							>
								<FormField
									control={form.control}
									name="roleArn"
									render={({ field }) => (
										<FormItem>
											<div className="flex items-center gap-1.5">
												<FormLabel className="text-xs font-medium">
													RAM Role ARN
												</FormLabel>
												<FieldHelp title="RAM Role ARN">
													The ARN of the RAM role you created that trusts
													Alethia — looks like{" "}
													<code className="text-foreground">
														acs:ram::&lt;account&gt;:role/&lt;name&gt;
													</code>
													. Alethia assumes it via STS; no Alibaba
													credentials are stored.
												</FieldHelp>
											</div>
											<FormControl>
												<Input
													placeholder="acs:ram::5123456789012345:role/AlethiaProvisioner"
													className="h-9 text-sm font-mono border-border/50"
													{...field}
												/>
											</FormControl>
											<FormMessage className="text-xs" />
										</FormItem>
									)}
								/>
								<Button
									disabled={!form.formState.isValid}
									type="submit"
									className="w-full h-9 text-xs font-medium"
								>
									{retry ? "Retry" : "Connect"}
								</Button>
							</form>
						</Form>
					</VerifySection>
				</CardContent>
			</Card>
		</div>
	);
}
