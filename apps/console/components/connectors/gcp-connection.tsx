"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import { Button } from "@repo/ui/button";
import { CopyButton } from "@repo/ui/copy-button";
import { FieldHelp } from "@repo/ui/field-help";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { Textarea } from "@repo/ui/textarea";
import { ConnectSheetShell, MethodTabs, Step, StoredNote } from "@/components/connectors/connection-ui";
import { useConnectorAssets } from "@/components/connectors/connector-assets";
import { ConnectForm } from "@/components/cloud-connect/connect-form";
import {
	commandWith,
	type GcpConnectValues,
	gcpConnectWizard,
	parseGcpIds,
} from "@/components/cloud-connect/cloud-connect.wizard";
import { type ConnectSession, useConnectWizard } from "@/components/cloud-connect/use-connect-wizard";
import { downloadFile } from "@/components/cloud-connect/download-file";
import { GCP_PROJECT_ID_REGEX } from "@/lib/cloud-providers/gcp-wif";
import { Download, ExternalLink, Terminal } from "lucide-react";
import { type ClipboardEvent, useState } from "react";
import { useWatch } from "react-hook-form";

/** Google Cloud Shell, opened on a bare terminal. */
const CLOUD_SHELL_URL = "https://shell.cloud.google.com/cloudshell/open?shellonly=true&show=terminal";

/** What the form starts with: the two-id path, nothing typed. */
const DEFAULTS: GcpConnectValues = { mode: "ids", projectId: "", projectNumber: "", wifConfigJson: "" };

/**
 * Connect a GCP project. The project ID is asked FIRST, because the setup command needs it: typed
 * once here, it is written into the command to copy, so the person never types it twice. The
 * project number is the one value only the script can tell them; pasting the script's whole output
 * into either field fills both. A Terraform or custom setup can paste the credential config instead.
 * Every field says what is wrong with it — nothing is a disabled button with no reason (B-04).
 */
export function GcpConnection({ session }: { session: ConnectSession }) {
	const [method, setMethod] = useState<"gcloud" | "terraform">("gcloud");
	const flow = useConnectWizard(gcpConnectWizard, DEFAULTS, {
		session,
		toInput: (values, identityId) =>
			values.mode === "config"
				? { method: "gcp-wif", identityId, wifConfigJson: values.wifConfigJson }
				: { method: "gcp-ids", identityId, projectId: values.projectId, projectNumber: values.projectNumber },
	});
	const { form } = flow.wizard;
	const mode = useWatch({ control: form.control, name: "mode" });
	const projectId = useWatch({ control: form.control, name: "projectId" }) ?? "";

	const { assetUrl } = useConnectorAssets();
	const scriptUrl = assetUrl("alethia-gcp-setup.sh");
	const cloudShellCmd = commandWith(
		`curl -sO ${scriptUrl} && bash alethia-gcp-setup.sh YOUR_PROJECT_ID`,
		"YOUR_PROJECT_ID",
		projectId,
		GCP_PROJECT_ID_REGEX,
	);
	const terraformCmd = commandWith(
		'terraform init && terraform apply -var "project_id=YOUR_PROJECT_ID"',
		"YOUR_PROJECT_ID",
		projectId,
		GCP_PROJECT_ID_REGEX,
	);
	const commandReady = GCP_PROJECT_ID_REGEX.test(projectId.trim());

	/** A paste of the script's output fills both ids; a single value is pasted as typed. */
	const onIdsPaste = (event: ClipboardEvent<HTMLInputElement>) => {
		const ids = parseGcpIds(event.clipboardData.getData("text"));
		if (ids.projectId === undefined && ids.projectNumber === undefined) return;
		event.preventDefault();
		if (ids.projectId !== undefined) form.setValue("projectId", ids.projectId, { shouldDirty: true });
		if (ids.projectNumber !== undefined) form.setValue("projectNumber", ids.projectNumber, { shouldDirty: true });
	};

	/** Switches between the two ids and a pasted credential config. */
	const toggleMode = () => {
		form.setValue("mode", mode === "config" ? "ids" : "config", { shouldDirty: true });
		form.clearErrors();
	};

	const projectIdField = (
		<FormField
			control={form.control}
			name="projectId"
			render={({ field }) => (
				<FormItem>
					<div className="flex items-center gap-1.5">
						<FormLabel className="font-medium text-xs">Project ID</FormLabel>
						<FieldHelp title="Project ID">
							The ID of the GCP project Alethia provisions into — the setup runs against it. Find it
							on the Cloud console&apos;s project picker. Looks like{" "}
							<code className="text-foreground">my-project-123</code>.
						</FieldHelp>
					</div>
					<FormControl>
						<Input
							placeholder="my-project-123"
							className="h-9 border-border/60 font-mono text-sm"
							autoComplete="off"
							spellCheck={false}
							{...field}
							onPaste={onIdsPaste}
						/>
					</FormControl>
					<FormMessage className="text-xs" />
				</FormItem>
			)}
		/>
	);

	const projectNumberField = (
		<FormField
			control={form.control}
			name="projectNumber"
			render={({ field }) => (
				<FormItem>
					<div className="flex items-center gap-1.5">
						<FormLabel className="font-medium text-xs">Project number</FormLabel>
						<FieldHelp title="Project number">
							The setup prints it as <code className="text-foreground">Project Number</code> (Terraform:
							the <code className="text-foreground">project_number</code> output). Paste the whole output
							here and both fields fill in.
						</FieldHelp>
					</div>
					<FormControl>
						<Input
							placeholder="123456789012"
							inputMode="numeric"
							className="h-9 border-border/60 font-mono text-sm"
							autoComplete="off"
							{...field}
							onPaste={onIdsPaste}
						/>
					</FormControl>
					<FormMessage className="text-xs" />
				</FormItem>
			)}
		/>
	);

	const configField = (
		<FormField
			control={form.control}
			name="wifConfigJson"
			render={({ field }) => (
				<FormItem>
					<div className="flex items-center gap-1.5">
						<FormLabel className="font-medium text-xs">Credential config JSON</FormLabel>
						<FieldHelp title="Credential config JSON">
							The full config from{" "}
							<code className="text-foreground">terraform output credential_config</code>, or what the script
							prints between START and END CONFIG. It holds no secret.
						</FieldHelp>
					</div>
					<FormControl>
						<Textarea
							placeholder='{"type": "external_account", "audience": "//iam.googleapis.com/projects/...", ...}'
							className="min-h-32 w-full resize-y whitespace-pre-wrap break-all border-border/60 font-mono text-xs"
							spellCheck={false}
							{...field}
						/>
					</FormControl>
					<FormMessage className="text-xs" />
				</FormItem>
			)}
		/>
	);

	return (
		<ConnectSheetShell
			badgeLabel="Keyless"
			intro="You create a Workload Identity Pool in your own GCP project that trusts Alethia's issuer. Alethia signs in with a short-lived, minted token — no service account keys are ever created, shared, or stored."
			howItWorks={
				<>
					<p>
						1. Run the setup script (or apply the Terraform module) — it creates a Workload Identity
						Pool + OIDC provider trusting Alethia&apos;s issuer and a provisioner service account.
					</p>
					<p>
						2. Alethia authenticates with a signed token its issuer mints (≤10 min); GCP STS verifies
						it and returns a ~1-hour access token — no JSON key.
					</p>
					<p>
						3. The only thing stored is the trust configuration (no secret). Delete the pool or unbind
						the service account to revoke access.
					</p>
				</>
			}
		>
			<ConnectForm
				flow={flow}
				successText="Alethia can authenticate into your GCP project via Workload Identity Federation. You're ready to provision infrastructure."
				verifyingText="Testing Workload Identity Federation authentication into your GCP project."
				stored={
					<StoredNote
						stored="only the WIF trust configuration (pool + provider audience, impersonation URL) — no service account key."
						revoke="delete the Workload Identity Pool or unbind the service account to cut Alethia's access."
					/>
				}
			>
				{mode === "config" ? (
					<div className="space-y-6">
						<Step n={1} title="Run the setup or apply the Terraform module">
							<p className="text-muted-foreground text-xs">
								Then paste the credential config it produces. Alethia stores only that trust
								configuration.
							</p>
						</Step>
						<Step n={2} title="Paste the credential config">
							{configField}
						</Step>
					</div>
				) : (
					<>
						{projectIdField}
						<MethodTabs
							value={method}
							onChange={(id) => setMethod(coerceEnum(id, ["gcloud", "terraform"] as const, "terraform"))}
							help={
								<>
									<b className="text-foreground">gcloud CLI</b> runs a script in Google Cloud Shell —
									nothing to install, works from the browser.{" "}
									<b className="text-foreground">Terraform</b> is for teams that manage infrastructure
									as code. Both create the same resources.
								</>
							}
							tabs={[
								{ id: "gcloud", label: "gcloud CLI", sub: "Cloud Shell", icon: <Terminal className="h-3.5 w-3.5" /> },
								{ id: "terraform", label: "Terraform", sub: "IaC", icon: <Terminal className="h-3.5 w-3.5" /> },
							]}
						/>
						{method === "gcloud" ? (
							<div className="space-y-6">
								<Step n={1} title="Run the setup in Cloud Shell">
									<p className="text-muted-foreground text-xs">
										{commandReady
											? "The command below already names your project. Copy it into Cloud Shell."
											: "Enter the project ID above and the command fills it in. Then copy it into Cloud Shell."}
									</p>
									<div className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 p-2.5 font-mono text-ui-xs text-foreground">
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
											onClick={() => downloadFile("/alethia-gcp-setup.sh", "alethia-gcp-setup.sh")}
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
								<Step n={2} title="Enter the project number it prints">
									{projectNumberField}
								</Step>
							</div>
						) : (
							<div className="space-y-6">
								<Step n={1} title="Apply the Terraform module">
									<div className="flex items-start gap-2 overflow-x-auto rounded-md border border-border/50 bg-muted/20 p-2.5 font-mono text-ui-xs text-foreground">
										<span className="min-w-0 break-all">{terraformCmd}</span>
										<CopyButton text={terraformCmd} className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted" />
									</div>
									<div className="flex flex-wrap items-center gap-3">
										<Button
											type="button"
											size="sm"
											className="h-8 font-medium text-xs"
											onClick={() => downloadFile("/connector-terraform/gcp.tf", "alethia-gcp.tf")}
										>
											<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
											Download module
										</Button>
										<a
											href="/docs/guides/connectors/gcp"
											target="_blank"
											rel="noopener noreferrer"
											className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
										>
											Full guide
											<ExternalLink className="h-3 w-3" />
										</a>
									</div>
								</Step>
								<Step n={2} title="Enter the project_number output">
									{projectNumberField}
								</Step>
							</div>
						)}
					</>
				)}
				<button
					type="button"
					onClick={toggleMode}
					className="rounded-sm text-ui-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					{mode === "config" ? "Use the project ID and number instead" : "Paste a credential config instead"}
				</button>
			</ConnectForm>
		</ConnectSheetShell>
	);
}
