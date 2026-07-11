"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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
import { zodResolver } from "@hookform/resolvers/zod";
import {
	ConnectSheetShell,
	Step,
	StoredNote,
	VerifySection,
} from "@/components/connector/connection-ui";
import {
	type VerifyOutcome,
	useConnectionTest,
} from "@/components/connector/use-connection-test";
import { Download, ExternalLink } from "lucide-react";
import { useForm } from "react-hook-form";
import * as z from "zod";

/** A save action's instant server-side verify outcome (drives the connect flow). */
type SaveResult = VerifyOutcome;

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
		<ConnectSheetShell
			title={`Connect ${providerName}`}
			badgeLabel="Encrypted"
			intro={`${providerName} has no role federation, so Alethia connects with a scoped API token you create. It's encrypted at rest and only decrypted on the runner at provision time — never in a project snapshot.`}
			howItWorks={
				<>
					<p>
						1. Create an API token in {providerName}, scoped to just what provisioning
						needs.
					</p>
					<p>
						2. Paste it here. Alethia verifies it against the {providerName} API and
						stores it encrypted (AES-GCM).
					</p>
					<p>
						3. Revoke the token in {providerName} at any time to instantly cut
						Alethia&apos;s access.
					</p>
				</>
			}
		>
			<div className="space-y-8">
				<Step n={1} title={`Create an API token in ${providerName}`}>
					<p className="max-w-sm text-muted-foreground text-xs">{tokenHelp}</p>
					{docsUrl && (
						<Button
							onClick={() => window.open(docsUrl, "_blank")}
							size="sm"
							className="h-8 font-medium text-xs"
							type="button"
						>
							<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
							Open {providerName} token settings
						</Button>
					)}
				</Step>
				<Step n={2} title="Paste the token below">
					<p className="max-w-sm text-muted-foreground text-xs">
						Alethia verifies it immediately and stores it encrypted — it is only decrypted
						on the runner at provision time.
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
										<FormLabel className="font-medium text-xs">API Token</FormLabel>
										<FieldHelp title={`${providerName} API token`}>
											{tokenHelp} Alethia encrypts it at rest and only decrypts it
											on the runner at provision time.
										</FieldHelp>
									</div>
									<FormControl>
										<Input
											type="password"
											placeholder="Paste your scoped API token"
											className="h-9 border-border/50 font-mono text-sm"
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
							className="h-9 w-full font-medium text-xs"
						>
							{retry ? "Retry" : "Connect"}
						</Button>
					</form>
				</Form>
				<StoredNote
					stored={`your ${providerName} API token, encrypted at rest (AES-GCM) — decrypted only on the runner at provision time.`}
					revoke={`delete the token in ${providerName} at any time to cut Alethia's access.`}
				/>
			</VerifySection>
		</ConnectSheetShell>
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
		<ConnectSheetShell
			title="Connect Alibaba Cloud"
			intro="You create a RAM OIDC provider + role in your own Alibaba account that trusts Alethia. Alethia signs in with a short-lived, minted token — no Alibaba credentials are ever shared or stored."
			howItWorks={
				<>
					<p>
						1. Apply the Terraform module — it creates a RAM OIDC provider trusting
						Alethia&apos;s issuer and a role that trusts it.
					</p>
					<p>
						2. Alethia authenticates with a signed token its issuer mints (≤10 min);
						Alibaba STS verifies it and returns a ~1-hour credential — no AccessKey.
					</p>
					<p>
						3. The only thing stored is the role ARN (a public identifier). Delete the role
						to revoke access.
					</p>
				</>
			}
		>
			<div className="space-y-8">
				<Step n={1} title="Create the RAM OIDC provider + role">
					<p className="max-w-sm text-muted-foreground text-xs">
						Apply the Terraform module below. It registers a RAM OIDC provider that trusts
						Alethia&apos;s issuer and a role that trusts that provider (scoped to
						Alethia&apos;s workload identity), then attaches provisioning permissions.
					</p>
					<div className="mt-2 flex flex-wrap items-center gap-3">
						<Button
							type="button"
							size="sm"
							className="h-8 font-medium text-xs"
							onClick={downloadModule}
						>
							<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
							Download module
						</Button>
						<a
							href="/docs/console/connectors/alibaba"
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
						>
							Full guide
							<ExternalLink className="h-3 w-3" />
						</a>
					</div>
				</Step>

				<Step n={2} title="Paste the role ARN below">
					<p className="max-w-sm text-muted-foreground text-xs">
						Run{" "}
						<code className="rounded border border-border/50 bg-muted px-1 py-0.5">terraform output</code>{" "}
						and copy <code className="rounded border border-border/50 bg-muted px-1 py-0.5">role_arn</code> — it
						looks like{" "}
						<code className="rounded border border-border/50 bg-muted px-1 py-0.5">acs:ram::&lt;account&gt;:role/&lt;name&gt;</code>.
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
										<FormLabel className="font-medium text-xs">RAM Role ARN</FormLabel>
										<FieldHelp title="RAM Role ARN">
											The ARN of the RAM role you created that trusts Alethia — looks
											like{" "}
											<code className="text-foreground">
												acs:ram::&lt;account&gt;:role/&lt;name&gt;
											</code>
											. Alethia assumes it via STS; no Alibaba credentials are stored.
										</FieldHelp>
									</div>
									<FormControl>
										<Input
											placeholder="acs:ram::5123456789012345:role/AlethiaProvisioner"
											className="h-9 border-border/50 font-mono text-sm"
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
							className="h-9 w-full font-medium text-xs"
						>
							{retry ? "Retry" : "Connect"}
						</Button>
					</form>
				</Form>
				<StoredNote
					stored="only the RAM role ARN (a public identifier) — no Alibaba account or AccessKey."
					revoke="delete the RAM role (or its OIDC-provider trust) to cut Alethia's access."
				/>
			</VerifySection>
		</ConnectSheetShell>
	);
}
