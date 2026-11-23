"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import { Button } from "@repo/ui/button";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { ConnectSheetShell, MethodTabs, Step, StoredNote } from "@/components/connectors/connection-ui";
import { FieldHelp } from "@repo/ui/field-help";
import { CopyButton } from "@repo/ui/copy-button";
import { useConnectorAssets } from "@/components/connectors/connector-assets";
import { ConnectForm } from "@/components/cloud-connect/connect-form";
import { awsConnectWizard, extractAwsRoleArn } from "@/components/cloud-connect/cloud-connect.wizard";
import { type ConnectSession, useConnectWizard } from "@/components/cloud-connect/use-connect-wizard";
import { downloadFile } from "@/components/cloud-connect/download-file";
import { Download, ExternalLink, Terminal } from "lucide-react";
import { type ClipboardEvent, useState } from "react";

/** The AWS CloudShell console. It cannot preload a command, so the command is copied. */
const CLOUD_SHELL_URL = "https://console.aws.amazon.com/cloudshell/home";

/**
 * Connect an AWS account. Nothing is asked before the setup runs: the command is complete as
 * shown (it names this console's issuer). The one value asked for is the role ARN the setup
 * prints, in the step that produces it, and pasting the whole output there takes the ARN out of it.
 */
export function AwsConnection({ session }: { session: ConnectSession }) {
	// OIDC-only + cloud-shell, at GCP parity: the browser CloudShell script is the default path,
	// Terraform for IaC teams.
	const [method, setMethod] = useState<"terraform" | "cli">("cli");
	const flow = useConnectWizard(awsConnectWizard, { roleArn: "" }, {
		session,
		toInput: (values, identityId) => ({ method: "aws", identityId, roleArn: values.roleArn }),
	});
	const { form } = flow.wizard;

	const { assetUrl, issuerUrl } = useConnectorAssets();
	const scriptUrl = assetUrl("alethia-aws-setup.sh");
	// Pass the issuer explicitly so a self-hosted console points the customer's trust at its OWN
	// issuer (the script also defaults it). Creates the OIDC provider + role.
	const cloudShellCmd = `curl -sO ${scriptUrl} && bash alethia-aws-setup.sh ${issuerUrl}`;

	/** A paste of the script's whole output keeps only the role ARN in it. */
	const onArnPaste = (event: ClipboardEvent<HTMLInputElement>) => {
		const text = event.clipboardData.getData("text");
		const arn = extractAwsRoleArn(text);
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
						<FormLabel className="font-medium text-xs">IAM Role ARN</FormLabel>
						<FieldHelp title="IAM Role ARN">
							The ARN of the role the setup created. Paste the{" "}
							<code className="text-foreground">role_arn</code> it prints — or its whole output;
							the ARN is taken from it. Looks like{" "}
							<code className="text-foreground">arn:aws:iam::123456789012:role/AlethiaProvisionerRole</code>.
						</FieldHelp>
					</div>
					<FormControl>
						<Input
							placeholder="arn:aws:iam::123456789012:role/AlethiaProvisionerRole"
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
			intro="You create an IAM role in your own AWS account that trusts Alethia's issuer. Alethia signs in with a short-lived, minted token — no access keys and no external id are ever shared or stored."
			howItWorks={
				<>
					<p>
						1. Run the setup script in AWS CloudShell (or apply the Terraform module) — it
						creates an IAM OIDC provider trusting Alethia&apos;s issuer and a role that trusts it.
					</p>
					<p>
						2. Alethia authenticates with a signed token its issuer mints (≤10 min); AWS STS
						verifies it via <code>AssumeRoleWithWebIdentity</code> and returns a ~1-hour
						credential — no key on either side.
					</p>
					<p>
						3. The only thing stored is the role ARN (a public identifier). Delete the role to
						revoke access.
					</p>
				</>
			}
		>
			<ConnectForm
				flow={flow}
				successText="Alethia can assume the IAM role in your account. You're ready to provision infrastructure."
				verifyingText="Testing role assumption into your AWS account."
				stored={
					<StoredNote
						stored="only the IAM role ARN (a public identifier) — no access keys, secrets, or external id."
						revoke="delete the IAM role (and its OIDC provider) to cut Alethia's access."
					/>
				}
			>
				<MethodTabs
					value={method}
					onChange={(id) => setMethod(coerceEnum(id, ["terraform", "cli"] as const, "terraform"))}
					help={
						<>
							<b className="text-foreground">AWS CLI / CloudShell</b> runs a script from the
							browser (nothing to install).{" "}
							<b className="text-foreground">Terraform</b> is for teams that manage
							infrastructure as code. Both create the same keyless role.
						</>
					}
					tabs={[
						{ id: "cli", label: "AWS CLI / CloudShell", sub: "Run a script in the browser", icon: <Terminal className="h-3.5 w-3.5" /> },
						{ id: "terraform", label: "Terraform / IaC", sub: "Infrastructure as Code", icon: <Terminal className="h-3.5 w-3.5" /> },
					]}
				/>

				{method === "cli" ? (
					<div className="space-y-6">
						<Step n={1} title="Run the setup in AWS CloudShell">
							<p className="max-w-sm text-muted-foreground text-xs">
								CloudShell has the aws CLI installed and signed in. Paste this command there; it
								creates the IAM OIDC provider and role, and prints the role ARN.
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
									Open CloudShell
								</Button>
								<Button
									onClick={() => downloadFile("/alethia-aws-setup.sh", "alethia-aws-setup.sh")}
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
						<Step n={1} title="Apply the Terraform module">
							<p className="max-w-sm text-muted-foreground text-xs">
								Creates the IAM OIDC provider + role that trust the Alethia issuer. No variables are
								required — the defaults pin the issuer, audience, and subject.
							</p>
							<div className="flex flex-wrap items-center gap-3">
								<Button
									type="button"
									size="sm"
									className="h-8 font-medium text-xs"
									onClick={() => downloadFile("/connector-terraform/aws.tf", "alethia-aws.tf")}
								>
									<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
									Download module
								</Button>
								<a
									href="/docs/guides/connectors/aws"
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
