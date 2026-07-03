"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
import { Textarea } from "@repo/ui/textarea";
import {
	ConnectionTestStatus,
	InfoNote,
	StatusCallout,
} from "@/components/connector/connection-ui";
import {
	type VerifyOutcome,
	useConnectionTest,
} from "@/components/connector/use-connection-test";
import { CopyButton } from "@repo/ui/copy-button";
import { FieldHelp } from "@repo/ui/field-help";
import { connectorAssetUrl } from "@/components/connector/connector-assets";
import { zodResolver } from "@hookform/resolvers/zod";
import {
	CheckCircle2,
	Download,
	ExternalLink,
	ShieldCheck,
	Terminal,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

const wifConfigSchema = z.object({
	wifConfig: z.string().superRefine((val, ctx) => {
		let parsed: Record<string, unknown>;
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

		const audience = parsed.audience as string | undefined;
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
	onComplete: (
		wifConfigJson: string,
	) => Promise<VerifyOutcome>;
}

export function GcpConnection({ onComplete }: GcpConnectionProps) {
	const [method, setMethod] = useState<"gcloud" | "terraform">("gcloud");
	const { state: verifyState, run, cancel } = useConnectionTest();

	const form = useForm<WifConfigFormValues>({
		resolver: zodResolver(wifConfigSchema),
		defaultValues: {
			wifConfig: "",
		},
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
		<div className="max-w-200 mx-auto space-y-6 w-full">
			<div className="flex flex-col gap-4">
				{/* Method Selection */}
				<div className="flex gap-3">
					<button
						onClick={() => setMethod("gcloud")}
						className={`flex-1 p-3 rounded-lg border text-left transition-all duration-200 ${
							method === "gcloud"
								? "border-foreground bg-muted/20"
								: "border-border/50 bg-background hover:border-border/80 hover:bg-muted/10"
						}`}
						type="button"
					>
						<div className="flex items-center gap-2.5">
							<div
								className={`p-1.5 rounded-md border ${method === "gcloud" ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border/50"}`}
							>
								<Terminal className="w-3.5 h-3.5" />
							</div>
							<div>
								<div className="font-medium text-sm text-foreground">
									gcloud CLI
								</div>
								<div className="text-[11px] text-muted-foreground">
									Quick setup via Cloud Shell
								</div>
							</div>
						</div>
					</button>

					<button
						onClick={() => setMethod("terraform")}
						className={`flex-1 p-3 rounded-lg border text-left transition-all duration-200 ${
							method === "terraform"
								? "border-foreground bg-muted/20"
								: "border-border/50 bg-background hover:border-border/80 hover:bg-muted/10"
						}`}
						type="button"
					>
						<div className="flex items-center gap-2.5">
							<div
								className={`p-1.5 rounded-md border ${method === "terraform" ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border/50"}`}
							>
								<Terminal className="w-3.5 h-3.5" />
							</div>
							<div>
								<div className="font-medium text-sm text-foreground">
									Terraform / IaC
								</div>
								<div className="text-[11px] text-muted-foreground">
									Infrastructure as Code
								</div>
							</div>
						</div>
					</button>
				</div>

				{/* Instructions */}
				<Card className="border-border/40 shadow-sm bg-background">
					<CardHeader className="border-b border-border/40 pb-4 bg-muted/5">
						<CardTitle className="text-base font-medium flex items-center gap-2">
							<ShieldCheck className="w-4.5 h-4.5 text-muted-foreground" />
							Setup Instructions
						</CardTitle>
						<CardDescription className="text-xs">
							Follow these steps to authorize Alethia in your GCP
							project using Workload Identity Federation.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-6 pt-6">
						{method === "gcloud" ? (
							<div className="space-y-8">
								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										1
									</div>
									<div className="space-y-3">
										<div>
											<div className="font-medium text-sm text-foreground">
												Open Cloud Shell
											</div>
											<p className="text-xs text-muted-foreground mt-1 mb-3 max-w-sm">
												Click below to open Google Cloud
												Shell in your browser. No local
												tooling required.
											</p>
										</div>
										<div className="flex gap-3">
											<Button
												onClick={() =>
													window.open(
														cloudShellUrl,
														"_blank",
													)
												}
												size="sm"
												className="h-8 text-xs font-medium"
												type="button"
											>
												<ExternalLink className="w-3.5 h-3.5 mr-1.5 opacity-70" />
												Open Cloud Shell
											</Button>
											<Button
												onClick={handleDownload}
												variant="outline"
												size="sm"
												className="h-8 text-xs font-medium border-border/50"
												type="button"
											>
												<Download className="w-3.5 h-3.5 mr-1.5 opacity-70" />
												Download Script
											</Button>
										</div>
									</div>
								</div>

								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										2
									</div>
									<div className="space-y-3">
										<div className="font-medium text-sm text-foreground">
											Run Setup Command
										</div>
										<p className="text-xs text-muted-foreground mt-1 max-w-sm">
											Paste this command in Cloud Shell.
											Replace{" "}
											<b className="text-foreground font-medium">
												YOUR_PROJECT_ID
											</b>{" "}
											with your GCP project ID.
										</p>
										<div className="flex items-start gap-2 p-3 bg-muted/30 border border-border/40 rounded-md font-mono text-[11px] text-foreground">
											<span className="break-all min-w-0">
												{cloudShellCmd}
											</span>
											<CopyButton
												text={cloudShellCmd}
												className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted"
											/>
										</div>
									</div>
								</div>

								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										3
									</div>
									<div className="flex-1">
										<div className="font-medium text-sm text-foreground">
											Copy Credential Config
										</div>
										<p className="text-xs text-muted-foreground mt-1 max-w-sm">
											The script outputs a JSON credential
											configuration. Copy everything
											between{" "}
											<b className="text-foreground font-medium">
												START CONFIG
											</b>{" "}
											and{" "}
											<b className="text-foreground font-medium">
												END CONFIG
											</b>{" "}
											and paste it below.
										</p>
									</div>
								</div>
							</div>
						) : (
							<div className="space-y-8">
								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										1
									</div>
									<div className="flex-1 min-w-0">
										<div className="font-medium text-sm text-foreground">
											Apply Terraform Module
										</div>
										<p className="text-xs text-muted-foreground mt-1 max-w-sm">
											Set your project ID in the Terraform
											variables and apply:
										</p>
										<div className="mt-3 p-3 bg-muted/30 border border-border/40 rounded-md font-mono text-[11px] text-foreground space-y-1 overflow-x-auto">
											<div>
												terraform init && terraform
												apply \
											</div>
											<div className="pl-4">
												-var
												&quot;project_id=YOUR_PROJECT_ID&quot;
											</div>
										</div>
										<div className="mt-3 flex flex-wrap items-center gap-3">
											<Button
												type="button"
												size="sm"
												className="h-8 text-xs font-medium"
												onClick={() => {
													const a = document.createElement("a");
													a.href = "/connector-terraform/gcp.tf";
													a.download = "alethia-gcp.tf";
													document.body.appendChild(a);
													a.click();
													document.body.removeChild(a);
												}}
											>
												<Download className="w-3.5 h-3.5 mr-1.5 opacity-70" />
												Download module
											</Button>
											<a
												href="/docs/console/connectors/gcp"
												target="_blank"
												rel="noopener noreferrer"
												className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
											>
												Full guide
												<ExternalLink className="w-3 h-3" />
											</a>
										</div>
									</div>
								</div>

								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										2
									</div>
									<div className="flex-1">
										<div className="font-medium text-sm text-foreground">
											Copy Credential Config Output
										</div>
										<p className="text-xs text-muted-foreground mt-1 max-w-sm">
											Run{" "}
											<code className="bg-muted px-1 py-0.5 border border-border/50 rounded text-foreground">
												terraform output
												credential_config
											</code>{" "}
											and paste the JSON value below.
										</p>
									</div>
								</div>
							</div>
						)}

						<div className="pt-6 border-t border-border/40">
							{verifyState.phase === "success" ||
							verifyState.phase === "saving" ? (
								<ConnectionTestStatus
									phase={verifyState.phase}
									status={verifyState.status}
									missingPermissions={verifyState.missingPermissions}
									successText="Alethia can authenticate into your GCP project via Workload Identity Federation. You're ready to provision infrastructure."
									verifyingText="Testing Workload Identity Federation authentication into your GCP project."
									onCancel={cancel}
								/>
							) : (
								<>
									<Form {...form}>
										<form
											onSubmit={form.handleSubmit(
												onSubmit,
											)}
											className="space-y-4"
										>
											<FormField
												control={form.control}
												name="wifConfig"
												render={({ field }) => (
													<FormItem>
														<div className="mb-2 flex items-center gap-1.5">
															<FormLabel className="text-xs font-medium text-foreground">
																WIF Credential Config JSON
															</FormLabel>
															<FieldHelp title="WIF Credential Config JSON">
																The full Workload Identity Federation
																credential JSON the setup prints — copy
																everything between{" "}
																<b className="text-foreground">START CONFIG</b>{" "}
																and <b className="text-foreground">END CONFIG</b>{" "}
																(or{" "}
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
																	className="min-h-30 text-xs font-mono border-border/50 resize-y break-all whitespace-pre-wrap overflow-x-hidden w-full"
																	{...field}
																/>
															</FormControl>
															{!form.formState
																.errors
																.wifConfig &&
																isValidJson && (
																	<div className="flex items-center gap-1.5 text-foreground text-xs">
																		<CheckCircle2 className="w-3.5 h-3.5" />
																		Valid
																		credential
																		configuration
																	</div>
																)}
														</div>
														<FormMessage className="text-xs" />
													</FormItem>
												)}
											/>
											{verifyState.phase === "failed" && (
												<StatusCallout
													variant="error"
													title="Verification failed"
												>
													{verifyState.error}
												</StatusCallout>
											)}
											<Button
												disabled={
													!form.formState.isValid
												}
												type="submit"
												className="w-full h-9 text-xs font-medium"
											>
												{verifyState.phase === "failed"
													? "Retry"
													: "Connect"}
											</Button>
										</form>
									</Form>

									<div className="mt-5">
										<InfoNote>
											Alethia uses Workload Identity Federation for keyless
											authentication. No service account keys are stored —
											only the trust configuration between Alethia&apos;s
											infrastructure and your GCP project.
										</InfoNote>
									</div>
								</>
							)}
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
