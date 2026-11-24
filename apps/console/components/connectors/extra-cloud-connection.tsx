"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connect forms of the clouds this release does not offer: Alibaba Cloud, DigitalOcean and
// Civo. Their code is kept, and a sheet only ever shows one when the server says the cloud is
// offered — which, for these, takes an operator re-enabling it (`lib/cloud-providers/availability.ts`).

import { coerceEnum } from "@/lib/coerce";
import { Button } from "@repo/ui/button";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { FieldHelp } from "@repo/ui/field-help";
import { CopyButton } from "@repo/ui/copy-button";
import { ConnectSheetShell, MethodTabs, Step, StoredNote } from "@/components/connectors/connection-ui";
import { useConnectorAssets } from "@/components/connectors/connector-assets";
import { ConnectForm } from "@/components/cloud-connect/connect-form";
import {
	alibabaConnectWizard,
	civoConnectWizard,
	digitaloceanConnectWizard,
	extractAlibabaRoleArn,
	type TokenOnlyCloud,
} from "@/components/cloud-connect/cloud-connect.wizard";
import { type ConnectSession, useConnectWizard } from "@/components/cloud-connect/use-connect-wizard";
import { downloadFile } from "@/components/cloud-connect/download-file";
import { Download, ExternalLink, Terminal } from "lucide-react";
import { type ClipboardEvent, useState } from "react";

// --- Token clouds: DigitalOcean / Civo ---

/** What a token cloud's sheet says about where its token comes from. */
const TOKEN_CLOUD_META: Record<TokenOnlyCloud, { name: string; docsUrl: string; tokenHelp: string }> = {
	digitalocean: {
		name: "DigitalOcean",
		docsUrl: "https://cloud.digitalocean.com/account/api/tokens",
		tokenHelp: "Create a Personal Access Token with read + write scopes.",
	},
	civo: {
		name: "Civo",
		docsUrl: "https://dashboard.civo.com/security",
		tokenHelp: "Copy your API key from the Security page.",
	},
};

/** Each token cloud's wizard definition. */
const TOKEN_WIZARDS = { digitalocean: digitaloceanConnectWizard, civo: civoConnectWizard } as const;

/** Connect a cloud with a scoped API token (DigitalOcean, Civo). The token is never kept in a draft. */
export function TokenCloudConnection({ cloud, session }: { cloud: TokenOnlyCloud; session: ConnectSession }) {
	const meta = TOKEN_CLOUD_META[cloud];
	const flow = useConnectWizard(TOKEN_WIZARDS[cloud], { token: "" }, {
		session,
		toInput: (values, identityId) => ({ method: "token", identityId, provider: cloud, token: values.token }),
	});
	const { form } = flow.wizard;

	return (
		<ConnectSheetShell
			badgeLabel="Encrypted"
			intro={`${meta.name} has no role federation, so Alethia connects with a scoped API token you create. It's encrypted at rest and only decrypted on the runner at provision time — never in a project snapshot.`}
			howItWorks={
				<>
					<p>1. Create an API token in {meta.name}, scoped to just what provisioning needs.</p>
					<p>
						2. Paste it here. Alethia verifies it against the {meta.name} API and stores it encrypted
						(AES-GCM).
					</p>
					<p>3. Revoke the token in {meta.name} at any time to instantly cut Alethia&apos;s access.</p>
				</>
			}
		>
			<ConnectForm
				flow={flow}
				successText={`Alethia can authenticate into ${meta.name} with your token. You're ready to provision infrastructure.`}
				verifyingText={`Testing your ${meta.name} token against the ${meta.name} API.`}
				stored={
					<StoredNote
						stored={`your ${meta.name} API token, encrypted at rest (AES-GCM) — decrypted only on the runner at provision time.`}
						revoke={`delete the token in ${meta.name} at any time to cut Alethia's access.`}
					/>
				}
			>
				<Step n={1} title={`Create an API token in ${meta.name}`}>
					<p className="max-w-sm text-muted-foreground text-xs">{meta.tokenHelp}</p>
					<Button
						onClick={() => window.open(meta.docsUrl, "_blank", "noopener,noreferrer")}
						size="sm"
						className="h-8 font-medium text-xs"
						type="button"
					>
						<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
						Open {meta.name} token settings
					</Button>
				</Step>
				<Step n={2} title="Paste the token">
					<FormField
						control={form.control}
						name="token"
						render={({ field }) => (
							<FormItem>
								<div className="flex items-center gap-1.5">
									<FormLabel className="font-medium text-xs">API Token</FormLabel>
									<FieldHelp title={`${meta.name} API token`}>
										{meta.tokenHelp} Alethia encrypts it at rest and only decrypts it on the runner at
										provision time.
									</FieldHelp>
								</div>
								<FormControl>
									<Input
										type="password"
										placeholder="Paste your scoped API token"
										autoComplete="off"
										className="h-9 border-border/60 font-mono text-sm"
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-xs" />
							</FormItem>
						)}
					/>
				</Step>
			</ConnectForm>
		</ConnectSheetShell>
	);
}

// --- Alibaba: RAM role (zero stored credentials) ---

/** Connect Alibaba Cloud with a RAM role. Pasting the setup's whole output keeps only the ARN. */
export function AlibabaConnection({ session }: { session: ConnectSession }) {
	const [method, setMethod] = useState<"cli" | "terraform">("cli");
	const flow = useConnectWizard(alibabaConnectWizard, { roleArn: "" }, {
		session,
		toInput: (values, identityId) => ({ method: "alibaba", identityId, roleArn: values.roleArn }),
	});
	const { form } = flow.wizard;

	const { assetUrl, issuerUrl } = useConnectorAssets();
	const scriptUrl = assetUrl("alethia-alibaba-setup.sh");
	// Pass the issuer explicitly so a self-hosted console points the customer's trust at its OWN issuer.
	const cloudShellCmd = `curl -sO ${scriptUrl} && bash alethia-alibaba-setup.sh ${issuerUrl}`;
	const cloudShellUrl = "https://shell.aliyun.com";

	/** A paste of the script's whole output keeps only the RAM role ARN in it. */
	const onArnPaste = (event: ClipboardEvent<HTMLInputElement>) => {
		const text = event.clipboardData.getData("text");
		const arn = extractAlibabaRoleArn(text);
		if (arn === null || arn === text.trim()) return;
		event.preventDefault();
		form.setValue("roleArn", arn, { shouldDirty: true });
	};

	const arnField = (
		<FormField
			control={form.control}
			name="roleArn"
			render={({ field }) => (
				<FormItem>
					<div className="flex items-center gap-1.5">
						<FormLabel className="font-medium text-xs">RAM Role ARN</FormLabel>
						<FieldHelp title="RAM Role ARN">
							The ARN of the RAM role you created that trusts Alethia — looks like{" "}
							<code className="text-foreground">acs:ram::&lt;account&gt;:role/&lt;name&gt;</code>. Alethia
							assumes it via STS; no Alibaba credentials are stored.
						</FieldHelp>
					</div>
					<FormControl>
						<Input
							placeholder="acs:ram::5123456789012345:role/AlethiaProvisioner"
							className="h-9 border-border/60 font-mono text-sm"
							autoComplete="off"
							spellCheck={false}
							{...field}
							onPaste={onArnPaste}
						/>
					</FormControl>
					<FormMessage className="text-xs" />
				</FormItem>
			)}
		/>
	);

	return (
		<ConnectSheetShell
			intro="You create a RAM OIDC provider + role in your own Alibaba account that trusts Alethia. Alethia signs in with a short-lived, minted token — no Alibaba credentials are ever shared or stored."
			howItWorks={
				<>
					<p>
						1. Run the setup script (or apply the OpenTofu module) — it creates a RAM OIDC provider
						trusting Alethia&apos;s issuer and a role that trusts it.
					</p>
					<p>
						2. Alethia authenticates with a signed token its issuer mints (≤10 min); Alibaba STS
						verifies it and returns a ~1-hour credential — no AccessKey.
					</p>
					<p>
						3. The only thing stored is the role ARN (a public identifier). Delete the role to revoke
						access.
					</p>
				</>
			}
		>
			<ConnectForm
				flow={flow}
				successText="Alethia recorded your RAM role and verified it with a real STS AssumeRoleWithOIDC — zero stored credentials."
				verifyingText="Assuming the RAM role via Alibaba STS (AssumeRoleWithOIDC)."
				stored={
					<StoredNote
						stored="only the RAM role ARN (a public identifier) — no Alibaba account or AccessKey."
						revoke="delete the RAM role (or its OIDC-provider trust) to cut Alethia's access."
					/>
				}
			>
				<MethodTabs
					value={method}
					onChange={(id) => setMethod(coerceEnum(id, ["cli", "terraform"] as const, "terraform"))}
					help={
						<>
							<b className="text-foreground">Aliyun CLI</b> runs a script in the Alibaba Cloud Shell —
							nothing to install, works from the browser. <b className="text-foreground">OpenTofu</b> is
							for teams that manage infrastructure as code. Both do the same thing.
						</>
					}
					tabs={[
						{ id: "cli", label: "Aliyun CLI", sub: "Quick setup via Cloud Shell", icon: <Terminal className="h-3.5 w-3.5" /> },
						{ id: "terraform", label: "OpenTofu / IaC", sub: "Infrastructure as Code", icon: <Terminal className="h-3.5 w-3.5" /> },
					]}
				/>
				{method === "cli" ? (
					<div className="space-y-6">
						<Step n={1} title="Run the setup in the Alibaba Cloud Shell">
							<p className="max-w-sm text-muted-foreground text-xs">
								The aliyun CLI is installed and signed in there. Paste this command; it creates the RAM
								OIDC provider + role and prints the role ARN.
							</p>
							<div className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 p-3 font-mono text-ui-xs text-foreground">
								<span className="min-w-0 break-all">{cloudShellCmd}</span>
								<CopyButton text={cloudShellCmd} className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted" />
							</div>
							<div className="flex flex-wrap gap-2">
								<Button
									onClick={() => window.open(cloudShellUrl, "_blank", "noopener,noreferrer")}
									size="sm"
									className="h-8 font-medium text-xs"
									type="button"
								>
									<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
									Open Cloud Shell
								</Button>
								<Button
									onClick={() => downloadFile("/alethia-alibaba-setup.sh", "alethia-alibaba-setup.sh")}
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
						<Step n={2} title="Paste the role ARN it prints">
							{arnField}
						</Step>
					</div>
				) : (
					<div className="space-y-6">
						<Step n={1} title="Apply the OpenTofu module">
							<div className="flex flex-wrap items-center gap-3">
								<Button
									type="button"
									size="sm"
									className="h-8 font-medium text-xs"
									onClick={() => downloadFile("/connector-terraform/alibaba.tf", "alethia-alibaba.tf")}
								>
									<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
									Download module
								</Button>
								<a
									href="/docs/guides/connectors/alibaba"
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
								>
									Full guide
									<ExternalLink className="h-3 w-3" />
								</a>
							</div>
						</Step>
						<Step n={2} title="Paste the role_arn output">
							{arnField}
						</Step>
					</div>
				)}
			</ConnectForm>
		</ConnectSheetShell>
	);
}
