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
import { Input } from "@repo/ui/input";
import { zodResolver } from "@hookform/resolvers/zod";
import { getJobStatus } from "@/app/server/actions/jobs";
import { verifyAzureIdentity } from "@/app/(private)/dashboard/providers/azure-actions";
import {
	AlertCircle,
	CheckCircle2,
	Copy,
	Download,
	ExternalLink,
	Loader2,
	ShieldCheck,
	Terminal,
	XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";

const GUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const azureSchema = z.object({
	tenantId: z.string().regex(GUID_REGEX, "Invalid Tenant ID. Expected a UUID."),
	clientId: z.string().regex(GUID_REGEX, "Invalid Client ID. Expected a UUID."),
	subscriptionId: z.string().regex(GUID_REGEX, "Invalid Subscription ID. Expected a UUID."),
});

type AzureFormValues = z.infer<typeof azureSchema>;

interface AzureConnectionProps {
	onComplete: (
		tenantId: string,
		clientId: string,
		subscriptionId: string,
	) => Promise<{ jobId: string; identityId: string }>;
}

type VerifyState =
	| { phase: "idle" }
	| { phase: "verifying"; jobId: string; identityId: string }
	| { phase: "success" }
	| { phase: "failed"; error: string };

export function AzureConnection({ onComplete }: AzureConnectionProps) {
	const router = useRouter();
	const [method, setMethod] = useState<"cli" | "terraform">("cli");
	const [verifyState, setVerifyState] = useState<VerifyState>({
		phase: "idle",
	});
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	useEffect(() => {
		return () => stopPolling();
	}, [stopPolling]);

	const startPolling = useCallback(
		(jobId: string, identityId: string) => {
			stopPolling();
			pollRef.current = setInterval(async () => {
				try {
					const result = await getJobStatus(jobId);
					if (!result) return;

					if (result.status === "SUCCESS") {
						stopPolling();
						await verifyAzureIdentity(identityId, jobId);
						setVerifyState({ phase: "success" });
						toast.success("Azure connection verified!");
						router.refresh();
					} else if (result.status === "FAILED") {
						stopPolling();
						setVerifyState({
							phase: "failed",
							error:
								result.error_message ||
								"Connection test failed. Check the federated identity credential setup.",
						});
					}
				} catch {
					stopPolling();
					setVerifyState({
						phase: "failed",
						error: "Failed to check verification status.",
					});
				}
			}, 2000);
		},
		[stopPolling],
	);

	const scriptUrl =
		"https://alethia-onboarding-templates.s3.eu-west-1.amazonaws.com/alethia-azure-setup.sh";
	const cloudShellCmd = `curl -sO ${scriptUrl} && bash alethia-azure-setup.sh YOUR_SUBSCRIPTION_ID`;
	const cloudShellUrl =
		"https://shell.azure.com";

	const form = useForm<AzureFormValues>({
		resolver: zodResolver(azureSchema),
		defaultValues: {
			tenantId: "",
			clientId: "",
			subscriptionId: "",
		},
		mode: "onChange",
	});

	const handleDownload = () => {
		const link = document.createElement("a");
		link.href = "/alethia-azure-setup.sh";
		link.download = "alethia-azure-setup.sh";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	};

	const copyToClipboard = (text: string, label: string) => {
		navigator.clipboard.writeText(text);
		toast.success(`${label} copied to clipboard`);
	};

	const onSubmit = async (data: AzureFormValues) => {
		setVerifyState({ phase: "verifying", jobId: "", identityId: "" });
		try {
			const { jobId, identityId } = await onComplete(
				data.tenantId,
				data.clientId,
				data.subscriptionId,
			);
			setVerifyState({ phase: "verifying", jobId, identityId });
			startPolling(jobId, identityId);
		} catch (error: unknown) {
			const message =
				error instanceof Error
					? error.message
					: "Failed to save connection.";
			setVerifyState({ phase: "failed", error: message });
		}
	};

	return (
		<div className="max-w-[800px] mx-auto space-y-6 w-full">
			<div className="flex flex-col gap-4">
				{/* Method Selection */}
				<div className="flex gap-3">
					<button
						onClick={() => setMethod("cli")}
						className={`flex-1 p-3 rounded-lg border text-left transition-all duration-200 ${
							method === "cli"
								? "border-foreground bg-muted/20"
								: "border-border/50 bg-background hover:border-border/80 hover:bg-muted/10"
						}`}
						type="button"
					>
						<div className="flex items-center gap-2.5">
							<div
								className={`p-1.5 rounded-md border ${method === "cli" ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border/50"}`}
							>
								<Terminal className="w-3.5 h-3.5" />
							</div>
							<div>
								<div className="font-medium text-sm text-foreground">
									Azure CLI
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
							Follow these steps to authorize Alethia in your Azure
							subscription using federated identity credentials.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-6 pt-6">
						{method === "cli" ? (
							<div className="space-y-8">
								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										1
									</div>
									<div className="space-y-3">
										<div>
											<div className="font-medium text-sm text-foreground">
												Open Azure Cloud Shell
											</div>
											<p className="text-xs text-muted-foreground mt-1 mb-3 max-w-sm">
												Click below to open Azure Cloud
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
												YOUR_SUBSCRIPTION_ID
											</b>{" "}
											with your Azure subscription ID.
										</p>
										<div className="flex items-start gap-2 p-3 bg-muted/30 border border-border/40 rounded-md font-mono text-[11px] text-foreground">
											<span className="break-all min-w-0">
												{cloudShellCmd}
											</span>
											<button
												onClick={() =>
													copyToClipboard(
														cloudShellCmd,
														"Command",
													)
												}
												className="mt-0.5 p-1 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
												type="button"
											>
												<Copy className="w-3.5 h-3.5" />
											</button>
										</div>
									</div>
								</div>

								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										3
									</div>
									<div className="flex-1">
										<div className="font-medium text-sm text-foreground">
											Enter Connection Details
										</div>
										<p className="text-xs text-muted-foreground mt-1 max-w-sm">
											Copy the{" "}
											<b className="text-foreground font-medium">
												Tenant ID
											</b>
											,{" "}
											<b className="text-foreground font-medium">
												Client ID
											</b>
											, and{" "}
											<b className="text-foreground font-medium">
												Subscription ID
											</b>{" "}
											from the script output and paste them
											below.
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
											Set your subscription ID in the
											Terraform variables and apply:
										</p>
										<div className="mt-3 p-3 bg-muted/30 border border-border/40 rounded-md font-mono text-[11px] text-foreground space-y-1 overflow-x-auto">
											<div>
												terraform init && terraform
												apply \
											</div>
											<div className="pl-4">
												-var
												&quot;subscription_id=YOUR_SUBSCRIPTION_ID&quot;
											</div>
										</div>
									</div>
								</div>

								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										2
									</div>
									<div className="flex-1">
										<div className="font-medium text-sm text-foreground">
											Copy Output Values
										</div>
										<p className="text-xs text-muted-foreground mt-1 max-w-sm">
											Run{" "}
											<code className="bg-muted px-1 py-0.5 border border-border/50 rounded text-foreground">
												terraform output
											</code>{" "}
											and paste the tenant_id, client_id,
											and subscription_id below.
										</p>
									</div>
								</div>
							</div>
						)}

						<div className="pt-6 border-t border-border/40">
							{verifyState.phase === "success" ? (
								<div className="flex items-center gap-3 p-4 bg-muted/50 border border-border rounded-md">
									<CheckCircle2 className="w-5 h-5 text-foreground shrink-0" />
									<div>
										<p className="text-sm font-medium text-foreground">
											Connection verified
										</p>
										<p className="text-xs text-muted-foreground mt-0.5">
											Alethia can authenticate into your
											Azure subscription via federated
											identity. You&apos;re ready to
											provision infrastructure.
										</p>
									</div>
								</div>
							) : verifyState.phase === "verifying" ? (
								<div className="flex items-center gap-3 p-4 bg-muted/30 border border-border/40 rounded-md">
									<Loader2 className="w-5 h-5 animate-spin text-muted-foreground shrink-0" />
									<div>
										<p className="text-sm font-medium text-foreground">
											Verifying connection...
										</p>
										<p className="text-xs text-muted-foreground mt-0.5">
											Testing federated identity
											authentication into your Azure
											subscription. This takes a few
											seconds.
										</p>
									</div>
								</div>
							) : (
								<>
									{verifyState.phase === "failed" && (
										<div className="flex items-start gap-3 p-4 mb-4 bg-destructive/5 border border-destructive/20 rounded-md">
											<XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
											<div>
												<p className="text-sm font-medium text-destructive">
													Verification failed
												</p>
												<p className="text-xs text-muted-foreground mt-0.5">
													{verifyState.error}
												</p>
											</div>
										</div>
									)}
									<Form {...form}>
										<form
											onSubmit={form.handleSubmit(
												onSubmit,
											)}
											className="space-y-4"
										>
											<FormField
												control={form.control}
												name="tenantId"
												render={({ field }) => (
													<FormItem>
														<FormLabel className="text-xs font-medium">
															Tenant ID
														</FormLabel>
														<FormControl>
															<Input
																placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
																className="h-9 text-sm font-mono border-border/50"
																{...field}
															/>
														</FormControl>
														<FormMessage className="text-xs" />
													</FormItem>
												)}
											/>
											<FormField
												control={form.control}
												name="clientId"
												render={({ field }) => (
													<FormItem>
														<FormLabel className="text-xs font-medium">
															Client ID
															(Application ID)
														</FormLabel>
														<FormControl>
															<Input
																placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
																className="h-9 text-sm font-mono border-border/50"
																{...field}
															/>
														</FormControl>
														<FormMessage className="text-xs" />
													</FormItem>
												)}
											/>
											<FormField
												control={form.control}
												name="subscriptionId"
												render={({ field }) => (
													<FormItem>
														<FormLabel className="text-xs font-medium">
															Subscription ID
														</FormLabel>
														<FormControl>
															<Input
																placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
																className="h-9 text-sm font-mono border-border/50"
																{...field}
															/>
														</FormControl>
														<FormMessage className="text-xs" />
													</FormItem>
												)}
											/>
											<Button
												disabled={
													!form.formState.isValid
												}
												type="submit"
												className="w-full h-9 text-xs font-medium"
											>
												{verifyState.phase ===
												"failed"
													? "Retry"
													: "Connect"}
											</Button>
										</form>
									</Form>

									<div className="mt-5 flex items-start gap-2.5 p-3 bg-muted/20 rounded-md border border-border/40 text-[11px] text-muted-foreground">
										<AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
										<p className="leading-relaxed">
											Alethia uses Azure federated identity
											credentials for keyless
											authentication. No client secrets
											are stored — only the trust
											configuration between Alethia&apos;s
											AWS infrastructure and your Azure
											tenant.
										</p>
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
