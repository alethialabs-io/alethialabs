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
import {
	ConnectionTestStatus,
	InfoNote,
	StatusCallout,
} from "@/components/connector/connection-ui";
import {
	type VerifyOutcome,
	useConnectionTest,
} from "@/components/connector/use-connection-test";
import { connectorAssetUrl } from "@/components/connector/connector-assets";
import { CopyButton } from "@repo/ui/copy-button";
import { FieldHelp } from "@repo/ui/field-help";
import {
	ClipboardPaste,
	Download,
	ExternalLink,
	ShieldCheck,
	Terminal,
} from "lucide-react";
import { type ClipboardEvent, useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

const GUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bare GUID (no anchors) — for scraping the setup-script output. */
const GUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * Extracts the tenant/client/subscription GUIDs from a pasted setup-script output
 * block (`Tenant ID: … / Client ID: … / Subscription ID: …`). Falls back to "three
 * bare GUIDs in order" when the labels aren't present.
 */
function parseAzureIds(text: string): Partial<AzureFormValues> {
	const grab = (label: string) =>
		text.match(new RegExp(`${label}[^0-9a-fA-F]*(${GUID})`, "i"))?.[1];
	let tenantId = grab("tenant");
	let clientId = grab("client");
	let subscriptionId = grab("subscription");
	if (!tenantId && !clientId && !subscriptionId) {
		const all = text.match(new RegExp(GUID, "g")) ?? [];
		if (all.length >= 3) [tenantId, clientId, subscriptionId] = all;
	}
	return { tenantId, clientId, subscriptionId };
}

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
	) => Promise<VerifyOutcome>;
}

export function AzureConnection({ onComplete }: AzureConnectionProps) {
	const [method, setMethod] = useState<"cli" | "terraform">("cli");
	const { state: verifyState, run, cancel } = useConnectionTest();

	const scriptUrl = connectorAssetUrl("alethia-azure-setup.sh");
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

	const onSubmit = async (data: AzureFormValues) => {
		await run(() =>
			onComplete(data.tenantId, data.clientId, data.subscriptionId),
		);
	};

	// True when "Paste all" found nothing on the clipboard — a quiet inline hint (no toast).
	const [pasteMissed, setPasteMissed] = useState(false);

	/** Fills the GUID fields from a pasted block; returns how many were set. */
	const fillFromText = (text: string): number => {
		const ids = parseAzureIds(text);
		let n = 0;
		for (const key of ["tenantId", "clientId", "subscriptionId"] as const) {
			const value = ids[key];
			if (value) {
				form.setValue(key, value, { shouldValidate: true, shouldDirty: true });
				n++;
			}
		}
		return n;
	};

	/** "Paste all" — read the clipboard and fill every field at once (best-effort). */
	const handlePasteAll = async () => {
		try {
			setPasteMissed(fillFromText(await navigator.clipboard.readText()) < 1);
		} catch {
			setPasteMissed(true);
		}
	};

	/** Paste into any field: if it's the whole block, split it across all three. */
	const handleFieldPaste = (e: ClipboardEvent<HTMLInputElement>) => {
		const text = e.clipboardData.getData("text");
		const ids = parseAzureIds(text);
		const found = [ids.tenantId, ids.clientId, ids.subscriptionId].filter(
			Boolean,
		).length;
		if (found >= 2) {
			e.preventDefault();
			fillFromText(text);
			setPasteMissed(false);
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
										<div className="mt-3 flex flex-wrap items-center gap-3">
											<Button
												type="button"
												size="sm"
												className="h-8 text-xs font-medium"
												onClick={() => {
													const a = document.createElement("a");
													a.href = "/connector-terraform/azure.tf";
													a.download = "alethia-azure.tf";
													document.body.appendChild(a);
													a.click();
													document.body.removeChild(a);
												}}
											>
												<Download className="w-3.5 h-3.5 mr-1.5 opacity-70" />
												Download module
											</Button>
											<a
												href="/docs/console/connectors/azure"
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
							{verifyState.phase === "success" ||
							verifyState.phase === "saving" ? (
								<ConnectionTestStatus
									phase={verifyState.phase}
									status={verifyState.status}
									missingPermissions={verifyState.missingPermissions}
									successText="Alethia can authenticate into your Azure subscription via federated identity. You're ready to provision infrastructure."
									verifyingText="Testing federated identity authentication into your Azure subscription."
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
											<div className="flex items-center justify-between gap-2">
												<p className="text-[11px] text-muted-foreground">
													{pasteMissed
														? "No IDs found on the clipboard — paste the script output, or fill the fields manually."
														: "Paste all three at once — we'll split them across the fields."}
												</p>
												<Button
													type="button"
													variant="outline"
													size="sm"
													className="h-7 text-xs"
													onClick={handlePasteAll}
												>
													<ClipboardPaste className="w-3.5 h-3.5 mr-1.5 opacity-70" />
													Paste all
												</Button>
											</div>
											<FormField
												control={form.control}
												name="tenantId"
												render={({ field }) => (
													<FormItem>
														<div className="flex items-center gap-1.5">
															<FormLabel className="text-xs font-medium">
																Tenant ID
															</FormLabel>
															<FieldHelp title="Tenant ID">
																Your Microsoft Entra ID{" "}
																<b className="text-foreground">
																	directory (tenant) ID
																</b>{" "}
																— the first value the setup script prints
																(Azure Portal → Microsoft Entra ID → Overview).
															</FieldHelp>
														</div>
														<FormControl>
															<Input
																placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
																className="h-9 text-sm font-mono border-border/50"
																{...field}
																onPaste={handleFieldPaste}
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
														<div className="flex items-center gap-1.5">
															<FormLabel className="text-xs font-medium">
																Client ID (Application ID)
															</FormLabel>
															<FieldHelp title="Client ID (Application ID)">
																The{" "}
																<b className="text-foreground">
																	Application (client) ID
																</b>{" "}
																of the{" "}
																<code className="text-foreground">
																	alethia-provisioner
																</code>{" "}
																app registration — the second value the script
																prints.
															</FieldHelp>
														</div>
														<FormControl>
															<Input
																placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
																className="h-9 text-sm font-mono border-border/50"
																{...field}
																onPaste={handleFieldPaste}
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
														<div className="flex items-center gap-1.5">
															<FormLabel className="text-xs font-medium">
																Subscription ID
															</FormLabel>
															<FieldHelp title="Subscription ID">
																The Azure{" "}
																<b className="text-foreground">subscription</b>{" "}
																Alethia provisions into — the third value the
																script prints (the ID you passed to it).
															</FieldHelp>
														</div>
														<FormControl>
															<Input
																placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
																className="h-9 text-sm font-mono border-border/50"
																{...field}
																onPaste={handleFieldPaste}
															/>
														</FormControl>
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
												{verifyState.phase ===
												"failed"
													? "Retry"
													: "Connect"}
											</Button>
										</form>
									</Form>

									<div className="mt-5">
										<InfoNote>
											Alethia uses Azure federated identity credentials for
											keyless authentication. No client secrets are stored —
											only the trust configuration between Alethia&apos;s
											infrastructure and your Azure tenant.
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
