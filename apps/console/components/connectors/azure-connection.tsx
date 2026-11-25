"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import { Button } from "@repo/ui/button";
import { CopyButton } from "@repo/ui/copy-button";
import { FieldHelp } from "@repo/ui/field-help";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { ConnectSheetShell, MethodTabs, Step, StoredNote } from "@/components/connectors/connection-ui";
import { useConnectorAssets } from "@/components/connectors/connector-assets";
import { ConnectForm } from "@/components/cloud-connect/connect-form";
import {
	type AzureConnectValues,
	azureConnectWizard,
	commandWith,
} from "@/components/cloud-connect/cloud-connect.wizard";
import { type ConnectSession, useConnectWizard } from "@/components/cloud-connect/use-connect-wizard";
import { downloadFile } from "@/components/cloud-connect/download-file";
import { AZURE_GUID_REGEX, parseAzureIds } from "@/lib/cloud-providers/azure-ids";
import { ClipboardPaste, Download, ExternalLink, Terminal } from "lucide-react";
import { type ClipboardEvent, useState } from "react";
import { useWatch } from "react-hook-form";

/** Azure Cloud Shell. */
const CLOUD_SHELL_URL = "https://shell.azure.com";

/** The three ids, in the order the form asks for them. */
const AZURE_FIELDS = ["subscriptionId", "tenantId", "clientId"] as const;

/** What the form starts with: nothing typed. */
const DEFAULTS: AzureConnectValues = { subscriptionId: "", tenantId: "", clientId: "" };

/** Each id field's label and help. */
const FIELD_COPY: Record<(typeof AZURE_FIELDS)[number], { label: string; help: string }> = {
	subscriptionId: {
		label: "Subscription ID",
		help: "The Azure subscription Alethia provisions into — the setup runs against it (Azure Portal → Subscriptions).",
	},
	tenantId: {
		label: "Tenant ID",
		help: "Your Microsoft Entra ID directory (tenant) ID — the setup prints it as Tenant ID.",
	},
	clientId: {
		label: "Client ID",
		help: "The client ID of the managed identity the setup created in your subscription — printed as Client ID.",
	},
};

/**
 * Connect an Azure subscription. The subscription ID is asked FIRST, because the setup command
 * needs it: typed once, it is written into the command to copy. The tenant and client IDs are what
 * the script prints; pasting its whole output into any field — or "Paste all" — fills every field
 * it labels.
 */
export function AzureConnection({ session }: { session: ConnectSession }) {
	const [method, setMethod] = useState<"cli" | "terraform">("cli");
	// What "Paste all" last found — a quiet inline hint (no toast). `unreadable` is a page that may
	// not read the clipboard at all: `navigator.clipboard` is undefined outside a secure context
	// (a self-host over plain HTTP), and a paste into a field still works there.
	const [pasteHint, setPasteHint] = useState<"none" | "missed" | "unreadable">("none");
	const flow = useConnectWizard(azureConnectWizard, DEFAULTS, {
		session,
		// Every id is the customer's own — the tenant, their managed-identity client id, and the subscription.
		toInput: (values, identityId) => ({ method: "azure", identityId, ...values }),
	});
	const { form } = flow.wizard;
	const subscriptionId = useWatch({ control: form.control, name: "subscriptionId" }) ?? "";

	const { assetUrl } = useConnectorAssets();
	const scriptUrl = assetUrl("alethia-azure-setup.sh");
	// No platform app id — the script creates a managed identity in the customer's subscription and
	// prints its client id, which the form collects.
	const cloudShellCmd = commandWith(
		`curl -sO ${scriptUrl} && bash alethia-azure-setup.sh YOUR_SUBSCRIPTION_ID`,
		"YOUR_SUBSCRIPTION_ID",
		subscriptionId,
		AZURE_GUID_REGEX,
	);
	const terraformCmd = commandWith(
		'terraform init && terraform apply -var "subscription_id=YOUR_SUBSCRIPTION_ID"',
		"YOUR_SUBSCRIPTION_ID",
		subscriptionId,
		AZURE_GUID_REGEX,
	);
	const commandReady = AZURE_GUID_REGEX.test(subscriptionId.trim());

	/** Fills every field the text labels; returns how many were set. */
	const fillFromText = (text: string): number => {
		const ids = parseAzureIds(text);
		let filled = 0;
		for (const key of AZURE_FIELDS) {
			const value = ids[key];
			if (value) {
				form.setValue(key, value, { shouldDirty: true });
				filled++;
			}
		}
		return filled;
	};

	/** "Paste all" — read the clipboard and fill every field at once (best-effort). */
	const pasteAll = async () => {
		const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
		if (!clipboard?.readText) {
			setPasteHint("unreadable");
			return;
		}
		try {
			setPasteHint(fillFromText(await clipboard.readText()) < 1 ? "missed" : "none");
		} catch {
			setPasteHint("missed");
		}
	};

	/** A paste of the whole output into any field is split across the fields it labels. */
	const onFieldPaste = (event: ClipboardEvent<HTMLInputElement>) => {
		const text = event.clipboardData.getData("text");
		const ids = parseAzureIds(text);
		if ([ids.tenantId, ids.clientId, ids.subscriptionId].filter(Boolean).length < 2) return;
		event.preventDefault();
		fillFromText(text);
		setPasteHint("none");
	};

	/** One id field. */
	const idField = (name: (typeof AZURE_FIELDS)[number]) => (
		<FormField
			key={name}
			control={form.control}
			name={name}
			render={({ field }) => (
				<FormItem>
					<div className="flex items-center gap-1.5">
						<FormLabel className="font-medium text-xs">{FIELD_COPY[name].label}</FormLabel>
						<FieldHelp title={FIELD_COPY[name].label}>{FIELD_COPY[name].help}</FieldHelp>
					</div>
					<FormControl>
						<Input
							placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
							className="h-9 border-border/60 font-mono text-sm"
							autoComplete="off"
							spellCheck={false}
							{...field}
							onPaste={onFieldPaste}
						/>
					</FormControl>
					<FormMessage className="text-xs" />
				</FormItem>
			)}
		/>
	);

	const outputFields = (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<p className="text-ui-xs text-muted-foreground" aria-live="polite">
					{pasteHint === "unreadable"
						? "This page cannot read the clipboard. Paste the output into any field and it is split."
						: pasteHint === "missed"
							? "No IDs found on the clipboard — paste the script output, or fill the fields by hand."
							: "Paste the whole output once — it is split across the fields."}
				</p>
				<Button type="button" variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={pasteAll}>
					<ClipboardPaste className="mr-1.5 h-3.5 w-3.5 opacity-70" />
					Paste all
				</Button>
			</div>
			{idField("tenantId")}
			{idField("clientId")}
		</div>
	);

	return (
		<ConnectSheetShell
			intro="You create a managed identity in your own Azure subscription that trusts Alethia's issuer via a federated credential — no App Registration, no client secret. Alethia signs in with a short-lived, minted token; nothing is ever stored."
			howItWorks={
				<>
					<p>
						1. Run the setup script (or apply the Terraform module) — it creates a user-assigned
						managed identity in your subscription, adds a federated credential trusting
						Alethia&apos;s issuer, and grants it a least-privilege role.
					</p>
					<p>
						2. Alethia authenticates as that identity with a signed token its issuer mints (≤10 min);
						Entra ID verifies it and returns a ~1-hour credential — no secret.
					</p>
					<p>
						3. The only thing stored is your tenant, subscription, and managed-identity client id
						(all public). Delete the managed identity to revoke access.
					</p>
				</>
			}
		>
			<ConnectForm
				flow={flow}
				successText="Alethia can authenticate into your Azure subscription via federated identity. You're ready to provision infrastructure."
				verifyingText="Testing federated identity authentication into your Azure subscription."
				stored={
					<StoredNote
						stored="only your tenant, subscription, and managed-identity client id (public identifiers) — no client secret."
						revoke="delete the managed identity (or its role assignment) to cut access."
					/>
				}
			>
				{idField("subscriptionId")}
				<MethodTabs
					value={method}
					onChange={(id) => setMethod(coerceEnum(id, ["cli", "terraform"] as const, "terraform"))}
					help={
						<>
							<b className="text-foreground">Azure CLI</b> runs a script in Azure Cloud Shell —
							nothing to install, works from the browser.{" "}
							<b className="text-foreground">Terraform</b> is for teams that manage infrastructure as
							code: download the module and <code>apply</code> it. Both do the same thing.
						</>
					}
					tabs={[
						{ id: "cli", label: "Azure CLI", sub: "Quick setup via Cloud Shell", icon: <Terminal className="h-3.5 w-3.5" /> },
						{ id: "terraform", label: "Terraform / IaC", sub: "Infrastructure as Code", icon: <Terminal className="h-3.5 w-3.5" /> },
					]}
				/>
				{method === "cli" ? (
					<div className="space-y-6">
						<Step n={1} title="Run the setup in Azure Cloud Shell">
							<p className="max-w-sm text-muted-foreground text-xs">
								{commandReady
									? "The command below already names your subscription. Copy it into Cloud Shell."
									: "Enter the subscription ID above and the command fills it in. Then copy it into Cloud Shell."}
							</p>
							<div className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 p-3 font-mono text-ui-xs text-foreground">
								<span className="min-w-0 break-all">{cloudShellCmd}</span>
								<CopyButton text={cloudShellCmd} className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted" />
							</div>
							<div className="flex flex-wrap gap-2">
								<Button
									onClick={() => window.open(CLOUD_SHELL_URL, "_blank", "noopener,noreferrer")}
									size="sm"
									className="h-8 font-medium text-xs"
									type="button"
								>
									<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
									Open Cloud Shell
								</Button>
								<Button
									onClick={() => downloadFile("/alethia-azure-setup.sh", "alethia-azure-setup.sh")}
									variant="outline"
									size="sm"
									className="h-8 border-border/60 font-medium text-xs"
									type="button"
								>
									<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
									Download script
								</Button>
							</div>
						</Step>
						<Step n={2} title="Enter the IDs it prints">
							{outputFields}
						</Step>
					</div>
				) : (
					<div className="space-y-6">
						<Step n={1} title="Apply the Terraform module">
							<div className="flex items-start gap-2 overflow-x-auto rounded-md border border-border/50 bg-muted/20 p-3 font-mono text-ui-xs text-foreground">
								<span className="min-w-0 break-all">{terraformCmd}</span>
								<CopyButton text={terraformCmd} className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted" />
							</div>
							<div className="flex flex-wrap items-center gap-3">
								<Button
									type="button"
									size="sm"
									className="h-8 font-medium text-xs"
									onClick={() => downloadFile("/connector-terraform/azure.tf", "alethia-azure.tf")}
								>
									<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
									Download module
								</Button>
								<a
									href="/docs/guides/connectors/azure"
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
								>
									Full guide
									<ExternalLink className="h-3 w-3" />
								</a>
							</div>
						</Step>
						<Step n={2} title="Enter the tenant_id and client_id outputs">
							{outputFields}
						</Step>
					</div>
				)}
			</ConnectForm>
		</ConnectSheetShell>
	);
}
