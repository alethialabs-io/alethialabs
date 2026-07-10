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
import { zodResolver } from "@hookform/resolvers/zod";
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
import {
	ALETHIA_AZURE_CLIENT_ID,
	connectorAssetUrl,
} from "@/components/connector/connector-assets";
import { CopyButton } from "@repo/ui/copy-button";
import { FieldHelp } from "@repo/ui/field-help";
import { ClipboardPaste, Download, ExternalLink, Terminal } from "lucide-react";
import { type ClipboardEvent, useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

const GUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bare GUID (no anchors) — for scraping the setup-script output. */
const GUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * Extracts the tenant/subscription GUIDs from a pasted setup-script output block
 * (`Tenant ID: … / Subscription ID: …`). The Client ID is no longer collected — the
 * customer authorizes Alethia's own multi-tenant app, so its id is fixed. Falls back
 * to "two bare GUIDs in order" (tenant, then subscription) when the labels aren't present.
 */
function parseAzureIds(text: string): Partial<AzureFormValues> {
	const grab = (label: string) =>
		text.match(new RegExp(`${label}[^0-9a-fA-F]*(${GUID})`, "i"))?.[1];
	let tenantId = grab("tenant");
	let subscriptionId = grab("subscription");
	if (!tenantId && !subscriptionId) {
		const all = text.match(new RegExp(GUID, "g")) ?? [];
		if (all.length >= 2) [tenantId, subscriptionId] = all;
	}
	return { tenantId, subscriptionId };
}

const azureSchema = z.object({
	tenantId: z.string().regex(GUID_REGEX, "Invalid Tenant ID. Expected a UUID."),
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
	// The platform app id is baked into the command (the customer authorizes Alethia's app —
	// they don't create one). When the operator hasn't set NEXT_PUBLIC_ALETHIA_AZURE_CLIENT_ID
	// the script falls back to its own built-in default, so an empty value is still runnable.
	const cloudShellCmd = ALETHIA_AZURE_CLIENT_ID
		? `curl -sO ${scriptUrl} && ALETHIA_AZURE_CLIENT_ID=${ALETHIA_AZURE_CLIENT_ID} bash alethia-azure-setup.sh YOUR_SUBSCRIPTION_ID`
		: `curl -sO ${scriptUrl} && bash alethia-azure-setup.sh YOUR_SUBSCRIPTION_ID`;
	const cloudShellUrl = "https://shell.azure.com";

	const form = useForm<AzureFormValues>({
		resolver: zodResolver(azureSchema),
		defaultValues: { tenantId: "", subscriptionId: "" },
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
		// The client id is fixed — Alethia's own multi-tenant app, not a per-customer one.
		await run(() =>
			onComplete(data.tenantId, ALETHIA_AZURE_CLIENT_ID, data.subscriptionId),
		);
	};

	// True when "Paste all" found nothing on the clipboard — a quiet inline hint (no toast).
	const [pasteMissed, setPasteMissed] = useState(false);

	/** Fills the GUID fields from a pasted block; returns how many were set. */
	const fillFromText = (text: string): number => {
		const ids = parseAzureIds(text);
		let n = 0;
		for (const key of ["tenantId", "subscriptionId"] as const) {
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

	/** Paste into any field: if it's the whole block, split it across both fields. */
	const handleFieldPaste = (e: ClipboardEvent<HTMLInputElement>) => {
		const text = e.clipboardData.getData("text");
		const ids = parseAzureIds(text);
		const found = [ids.tenantId, ids.subscriptionId].filter(Boolean).length;
		if (found >= 2) {
			e.preventDefault();
			fillFromText(text);
			setPasteMissed(false);
		}
	};

	return (
		<ConnectSheetShell
			title="Connect Azure"
			intro="You grant Alethia's multi-tenant app a role in your own Azure subscription; it trusts Alethia's issuer via a federated credential. Alethia signs in with a short-lived, minted token — no client secret is ever created, shared, or stored."
			howItWorks={
				<>
					<p>
						1. Run the setup script (or apply the Terraform module) — it creates a service
						principal for Alethia&apos;s app in your tenant and grants it Contributor.
					</p>
					<p>
						2. Alethia authenticates as that app with a signed token its issuer mints (≤10
						min); Entra ID verifies it and returns a ~1-hour credential — no secret.
					</p>
					<p>
						3. The only thing stored is your tenant + subscription id (public). Remove the
						app&apos;s role assignment to revoke access.
					</p>
				</>
			}
		>
			<MethodTabs
				value={method}
				onChange={(id) => setMethod(id as "cli" | "terraform")}
				help={
					<>
						<b className="text-foreground">Azure CLI</b> runs a script in Azure Cloud Shell —
						nothing to install, works from the browser.{" "}
						<b className="text-foreground">Terraform</b> is for teams that manage
						infrastructure as code: download the module and <code>apply</code> it. Both do the
						same thing.
					</>
				}
				tabs={[
					{
						id: "cli",
						label: "Azure CLI",
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

			{method === "cli" ? (
				<div className="space-y-8">
					<Step n={1} title="Open Azure Cloud Shell">
						<p className="max-w-sm text-muted-foreground text-xs">
							Click below to open Azure Cloud Shell in your browser. No local tooling
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
							<b className="font-medium text-foreground">YOUR_SUBSCRIPTION_ID</b> with your
							Azure subscription ID.
						</p>
						<div className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 p-3 font-mono text-[11px] text-foreground">
							<span className="min-w-0 break-all">{cloudShellCmd}</span>
							<CopyButton
								text={cloudShellCmd}
								className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted"
							/>
						</div>
					</Step>
					<Step n={3} title="Enter Connection Details">
						<p className="max-w-sm text-muted-foreground text-xs">
							Copy the <b className="font-medium text-foreground">Tenant ID</b> and{" "}
							<b className="font-medium text-foreground">Subscription ID</b> from the script
							output and paste them below.
						</p>
					</Step>
				</div>
			) : (
				<div className="space-y-8">
					<Step n={1} title="Apply Terraform Module">
						<p className="max-w-sm text-muted-foreground text-xs">
							Set your subscription ID and the Alethia app id in the Terraform variables and
							apply:
						</p>
						<div className="mt-1 space-y-1 overflow-x-auto rounded-md border border-border/40 bg-muted/30 p-3 font-mono text-[11px] text-foreground">
							<div>terraform init && terraform apply \</div>
							<div className="pl-4">-var &quot;subscription_id=YOUR_SUBSCRIPTION_ID&quot; \</div>
							<div className="pl-4">
								-var &quot;alethia_client_id={ALETHIA_AZURE_CLIENT_ID || "ALETHIA_APP_ID"}
								&quot;
							</div>
						</div>
						<div className="mt-2 flex flex-wrap items-center gap-3">
							<Button
								type="button"
								size="sm"
								className="h-8 font-medium text-xs"
								onClick={() => {
									const a = document.createElement("a");
									a.href = "/connector-terraform/azure.tf";
									a.download = "alethia-azure.tf";
									document.body.appendChild(a);
									a.click();
									document.body.removeChild(a);
								}}
							>
								<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download module
							</Button>
							<a
								href="/docs/console/connectors/azure"
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
							>
								Full guide
								<ExternalLink className="h-3 w-3" />
							</a>
						</div>
					</Step>
					<Step n={2} title="Copy Output Values">
						<p className="max-w-sm text-muted-foreground text-xs">
							Run{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5 text-foreground">
								terraform output
							</code>{" "}
							and paste the tenant_id and subscription_id below.
						</p>
					</Step>
				</div>
			)}

			<VerifySection
				state={verifyState}
				onCancel={cancel}
				successText="Alethia can authenticate into your Azure subscription via federated identity. You're ready to provision infrastructure."
				verifyingText="Testing federated identity authentication into your Azure subscription."
			>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<div className="flex items-center justify-between gap-2">
							<p className="text-[11px] text-muted-foreground">
								{pasteMissed
									? "No IDs found on the clipboard — paste the script output, or fill the fields manually."
									: "Paste both at once — we'll split them across the fields."}
							</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 text-xs"
								onClick={handlePasteAll}
							>
								<ClipboardPaste className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Paste all
							</Button>
						</div>
						<FormField
							control={form.control}
							name="tenantId"
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel className="font-medium text-xs">Tenant ID</FormLabel>
										<FieldHelp title="Tenant ID">
											Your Microsoft Entra ID{" "}
											<b className="text-foreground">directory (tenant) ID</b> — the
											first value the setup script prints (Azure Portal → Microsoft
											Entra ID → Overview).
										</FieldHelp>
									</div>
									<FormControl>
										<Input
											placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
											className="h-9 border-border/50 font-mono text-sm"
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
										<FormLabel className="font-medium text-xs">Subscription ID</FormLabel>
										<FieldHelp title="Subscription ID">
											The Azure <b className="text-foreground">subscription</b> Alethia
											provisions into — the second value the script prints (the ID you
											passed to it).
										</FieldHelp>
									</div>
									<FormControl>
										<Input
											placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
											className="h-9 border-border/50 font-mono text-sm"
											{...field}
											onPaste={handleFieldPaste}
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
							{verifyState.phase === "failed" ? "Retry" : "Connect"}
						</Button>
					</form>
				</Form>
				<StoredNote
					stored="only your tenant + subscription id (public identifiers) — no client secret."
					revoke="remove Alethia's app role assignment (or its service principal) to cut access."
				/>
			</VerifySection>
		</ConnectSheetShell>
	);
}
