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
import { Textarea } from "@repo/ui/textarea";
import {
	ConnectSheetShell,
	MethodTabs,
	Step,
	StoredNote,
	VerifySection,
} from "@/components/connector/connection-ui";
import {
	type VerifyOutcome,
	useConnectionTest,
} from "@/components/connector/use-connection-test";
import { CopyButton } from "@repo/ui/copy-button";
import { FieldHelp } from "@repo/ui/field-help";
import { connectorAssetUrl } from "@/components/connector/connector-assets";
import type { WifCredentialConfig } from "@/types/jsonb.types";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Download, ExternalLink, Terminal } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

const wifConfigSchema = z.object({
	wifConfig: z.string().superRefine((val, ctx) => {
		let parsed: WifCredentialConfig;
		try {
			parsed = JSON.parse(val);
		} catch {
			ctx.addIssue({
				code: "custom",
				message:
					"Invalid JSON format. Paste the complete credential configuration file contents.",
			});
			return;
		}

		if (parsed.type !== "external_account") {
			ctx.addIssue({
				code: "custom",
				message:
					'Invalid credential type. Expected a Workload Identity Federation config with type "external_account".',
			});
			return;
		}

		// Alethia federates GCP via DIRECT OIDC — the config's subject token must be a minted JWT. A legacy
		// AWS-hub config (subject_token_type "…aws4_request") is no longer supported: reject it up-front with a
		// clear message instead of failing server-side. Reconnect with the current setup script / module.
		if (parsed.subject_token_type !== "urn:ietf:params:oauth:token-type:jwt") {
			ctx.addIssue({
				code: "custom",
				message:
					"This looks like a retired AWS-hub WIF config. Re-run the current GCP setup script or Terraform module — it produces a direct-OIDC config Alethia can use.",
			});
			return;
		}

		const audience = parsed.audience;
		if (!audience || !audience.includes("workloadIdentityPools")) {
			ctx.addIssue({
				code: "custom",
				message:
					"Missing or invalid audience. Ensure the config references a Workload Identity Pool.",
			});
			return;
		}

		if (!parsed.service_account_impersonation_url) {
			ctx.addIssue({
				code: "custom",
				message:
					"Missing service account impersonation URL. Re-run the setup script with --service-account flag.",
			});
			return;
		}

		if (!parsed.credential_source) {
			ctx.addIssue({
				code: "custom",
				message: "Missing credential_source in the configuration.",
			});
		}
	}),
});

type WifConfigFormValues = z.infer<typeof wifConfigSchema>;

interface GcpConnectionProps {
	onComplete: (wifConfigJson: string) => Promise<VerifyOutcome>;
}

export function GcpConnection({ onComplete }: GcpConnectionProps) {
	const [method, setMethod] = useState<"gcloud" | "terraform">("gcloud");
	const { state: verifyState, run, cancel } = useConnectionTest();

	const form = useForm<WifConfigFormValues>({
		resolver: zodResolver(wifConfigSchema),
		defaultValues: { wifConfig: "" },
		mode: "onChange",
	});

	const scriptUrl = connectorAssetUrl("alethia-gcp-setup.sh");
	const cloudShellCmd = `curl -sO ${scriptUrl} && bash alethia-gcp-setup.sh YOUR_PROJECT_ID`;
	const cloudShellUrl =
		"https://shell.cloud.google.com/cloudshell/open?shellonly=true&show=terminal";

	const handleDownload = () => {
		const link = document.createElement("a");
		link.href = "/alethia-gcp-setup.sh";
		link.download = "alethia-gcp-setup.sh";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	};

	const onSubmit = async (data: WifConfigFormValues) => {
		await run(() => onComplete(data.wifConfig));
	};

	const isValidJson = (() => {
		const val = form.watch("wifConfig");
		if (!val) return false;
		try {
			const parsed = JSON.parse(val);
			return parsed.type === "external_account";
		} catch {
			return false;
		}
	})();

	return (
		<ConnectSheetShell
			title="Connect GCP"
			intro="You create a Workload Identity Pool in your own GCP project that trusts Alethia's issuer. Alethia signs in with a short-lived, minted token — no service account keys are ever created, shared, or stored."
			howItWorks={
				<>
					<p>
						1. Run the setup script (or apply the Terraform module) — it creates a Workload
						Identity Pool + OIDC provider trusting Alethia&apos;s issuer and a provisioner
						service account.
					</p>
					<p>
						2. Alethia authenticates with a signed token its issuer mints (≤10 min); GCP STS
						verifies it and returns a ~1-hour access token — no JSON key.
					</p>
					<p>
						3. The only thing stored is the trust configuration (no secret). Delete the pool
						or unbind the service account to revoke access.
					</p>
				</>
			}
		>
			<MethodTabs
				value={method}
				onChange={(id) => setMethod(id as "gcloud" | "terraform")}
				help={
					<>
						<b className="text-foreground">gcloud CLI</b> runs a script in Google Cloud
						Shell — nothing to install, works from the browser.{" "}
						<b className="text-foreground">Terraform</b> is for teams that manage
						infrastructure as code: download the module and <code>apply</code> it. Both
						create the same resources.
					</>
				}
				tabs={[
					{
						id: "gcloud",
						label: "gcloud CLI",
						sub: "Quick setup via Cloud Shell",
						icon: <Terminal className="h-3.5 w-3.5" />,
					},
					{
						id: "terraform",
						label: "Terraform / IaC",
						sub: "Infrastructure as Code",
						icon: <Terminal className="h-3.5 w-3.5" />,
					},
				]}
			/>

			{method === "gcloud" ? (
				<div className="space-y-8">
					<Step n={1} title="Open Cloud Shell">
						<p className="max-w-sm text-muted-foreground text-xs">
							Click below to open Google Cloud Shell in your browser. No local tooling
							required.
						</p>
						<div className="flex gap-3">
							<Button
								onClick={() => window.open(cloudShellUrl, "_blank")}
								size="sm"
								className="h-8 font-medium text-xs"
								type="button"
							>
								<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Open Cloud Shell
							</Button>
							<Button
								onClick={handleDownload}
								variant="outline"
								size="sm"
								className="h-8 border-border/50 font-medium text-xs"
								type="button"
							>
								<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download Script
							</Button>
						</div>
					</Step>
					<Step n={2} title="Run Setup Command">
						<p className="max-w-sm text-muted-foreground text-xs">
							Paste this command in Cloud Shell. Replace{" "}
							<b className="font-medium text-foreground">YOUR_PROJECT_ID</b> with your GCP
							project ID.
						</p>
						<div className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 p-3 font-mono text-[11px] text-foreground">
							<span className="min-w-0 break-all">{cloudShellCmd}</span>
							<CopyButton
								text={cloudShellCmd}
								className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted"
							/>
						</div>
					</Step>
					<Step n={3} title="Copy Credential Config">
						<p className="max-w-sm text-muted-foreground text-xs">
							The script outputs a JSON credential configuration. Copy everything between{" "}
							<b className="font-medium text-foreground">START CONFIG</b> and{" "}
							<b className="font-medium text-foreground">END CONFIG</b> and paste it below.
						</p>
					</Step>
				</div>
			) : (
				<div className="space-y-8">
					<Step n={1} title="Apply Terraform Module">
						<p className="max-w-sm text-muted-foreground text-xs">
							Set your project ID in the Terraform variables and apply:
						</p>
						<div className="mt-1 space-y-1 overflow-x-auto rounded-md border border-border/40 bg-muted/30 p-3 font-mono text-[11px] text-foreground">
							<div>terraform init && terraform apply \</div>
							<div className="pl-4">-var &quot;project_id=YOUR_PROJECT_ID&quot;</div>
						</div>
						<div className="mt-2 flex flex-wrap items-center gap-3">
							<Button
								type="button"
								size="sm"
								className="h-8 font-medium text-xs"
								onClick={() => {
									const a = document.createElement("a");
									a.href = "/connector-terraform/gcp.tf";
									a.download = "alethia-gcp.tf";
									document.body.appendChild(a);
									a.click();
									document.body.removeChild(a);
								}}
							>
								<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download module
							</Button>
							<a
								href="/docs/console/connectors/gcp"
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
							>
								Full guide
								<ExternalLink className="h-3 w-3" />
							</a>
						</div>
					</Step>
					<Step n={2} title="Copy Credential Config Output">
						<p className="max-w-sm text-muted-foreground text-xs">
							Run{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5 text-foreground">
								terraform output credential_config
							</code>{" "}
							and paste the JSON value below.
						</p>
					</Step>
				</div>
			)}

			<VerifySection
				state={verifyState}
				onCancel={cancel}
				successText="Alethia can authenticate into your GCP project via Workload Identity Federation. You're ready to provision infrastructure."
				verifyingText="Testing Workload Identity Federation authentication into your GCP project."
			>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="wifConfig"
							render={({ field }) => (
								<FormItem>
									<div className="mb-2 flex items-center gap-1.5">
										<FormLabel className="font-medium text-foreground text-xs">
											WIF Credential Config JSON
										</FormLabel>
										<FieldHelp title="WIF Credential Config JSON">
											The full Workload Identity Federation credential JSON the setup
											prints — copy everything between{" "}
											<b className="text-foreground">START CONFIG</b> and{" "}
											<b className="text-foreground">END CONFIG</b> (or{" "}
											<code className="text-foreground">
												terraform output credential_config
											</code>
											). It starts with{" "}
											<code className="text-foreground">
												&quot;type&quot;: &quot;external_account&quot;
											</code>
											.
										</FieldHelp>
									</div>
									<div className="space-y-2">
										<FormControl>
											<Textarea
												placeholder='{"type": "external_account", "audience": "//iam.googleapis.com/projects/...", ...}'
												className="min-h-30 w-full resize-y overflow-x-hidden whitespace-pre-wrap break-all border-border/50 font-mono text-xs"
												{...field}
											/>
										</FormControl>
										{!form.formState.errors.wifConfig && isValidJson && (
											<div className="flex items-center gap-1.5 text-foreground text-xs">
												<CheckCircle2 className="h-3.5 w-3.5" />
												Valid credential configuration
											</div>
										)}
									</div>
									<FormMessage className="text-xs" />
								</FormItem>
							)}
						/>
						<Button
							disabled={!form.formState.isValid}
							type="submit"
							className="h-9 w-full font-medium text-xs"
						>
							{verifyState.phase === "failed" ? "Retry" : "Connect"}
						</Button>
					</form>
				</Form>
				<StoredNote
					stored="only the WIF trust configuration (pool + provider audience, impersonation URL) — no service account key."
					revoke="delete the Workload Identity Pool or unbind the service account to cut Alethia's access."
				/>
			</VerifySection>
		</ConnectSheetShell>
	);
}
