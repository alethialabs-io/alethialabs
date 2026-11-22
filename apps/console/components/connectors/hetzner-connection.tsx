"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { FieldHelp } from "@repo/ui/field-help";
import { WizardDisclosure } from "@repo/ui/wizard";
import { ConnectSheetShell, Step, StoredNote } from "@/components/connectors/connection-ui";
import { ConnectForm } from "@/components/cloud-connect/connect-form";
import { type HetznerConnectValues, hetznerConnectWizard } from "@/components/cloud-connect/cloud-connect.wizard";
import { type ConnectSession, useConnectWizard } from "@/components/cloud-connect/use-connect-wizard";
import { ExternalLink, ServerCog } from "lucide-react";

/** Where a customer creates a Hetzner Cloud API token (Console → project → Security → API Tokens). */
const HETZNER_CONSOLE_URL = "https://console.hetzner.cloud/";
/** The Alethia connect guide for Hetzner. */
const HETZNER_DOCS_URL = "/docs/guides/connectors/hetzner";

/** What the form starts with: nothing typed. Nothing here is ever kept in a draft. */
const DEFAULTS: HetznerConnectValues = { token: "", s3AccessKey: "", s3SecretKey: "" };

/** The two optional Object Storage key fields. */
const S3_FIELDS = [
	{ name: "s3AccessKey", label: "S3 access key", placeholder: "Paste your Object Storage access key" },
	{ name: "s3SecretKey", label: "S3 secret key", placeholder: "Paste your Object Storage secret key" },
] as const;

/**
 * The Hetzner Cloud connect sheet. Hetzner has no OIDC / workload-identity federation (unlike
 * AWS/GCP/Azure), so its best-available auth is a project-scoped API token — encrypted at rest
 * (AES-GCM) and decrypted only on the runner at provision time. One field is asked for; the
 * optional Object Storage key pair waits behind a disclosure that opens itself when one of its
 * fields is wrong. No field here is ever kept in a draft (`draft: null`).
 */
export function HetznerConnection({ session }: { session: ConnectSession }) {
	const flow = useConnectWizard(hetznerConnectWizard, DEFAULTS, {
		session,
		toInput: (values, identityId) => ({
			method: "token",
			identityId,
			provider: "hetzner",
			token: values.token,
			s3AccessKey: values.s3AccessKey || undefined,
			s3SecretKey: values.s3SecretKey || undefined,
		}),
	});
	const { form } = flow.wizard;
	const { errors } = form.formState;
	const s3Error = errors.s3AccessKey !== undefined || errors.s3SecretKey !== undefined;

	return (
		<ConnectSheetShell
			badgeLabel="Encrypted"
			intro="Hetzner Cloud has no role federation, so Alethia connects with a project-scoped API token you create. It's encrypted at rest (AES-GCM) and only decrypted on the runner at provision time — never in a project snapshot. Alethia uses it to provision a self-managed Talos Linux Kubernetes cluster on Hetzner's cheap VMs."
			howItWorks={
				<>
					<p>
						1. Create a <b className="text-foreground">Read &amp; Write</b>, project-scoped API token
						in the Hetzner Cloud Console (Security → API Tokens).
					</p>
					<p>
						2. Paste it here. Alethia verifies it against the Hetzner Cloud API and stores it
						encrypted (AES-GCM) — decrypted only on the runner at provision time.
					</p>
					<p>
						3. Rotate or revoke the token in Hetzner at any time to instantly cut Alethia&apos;s
						access. A token is scoped to a single Hetzner project — the tightest boundary Hetzner
						offers.
					</p>
				</>
			}
		>
			<ConnectForm
				flow={flow}
				successText="Alethia can authenticate into Hetzner Cloud with your token. You're ready to provision a Talos Kubernetes cluster."
				verifyingText="Testing your token against the Hetzner Cloud API."
				stored={
					<StoredNote
						stored="your Hetzner API token, encrypted at rest (AES-GCM) — decrypted only on the runner at provision time, never in a project snapshot."
						revoke="delete the token in the Hetzner Cloud Console at any time to instantly cut Alethia's access."
					/>
				}
			>
				<Step n={1} title="Create a project-scoped API token">
					<p className="max-w-md text-muted-foreground text-xs">
						In the Hetzner Cloud Console, open your project, then{" "}
						<b className="font-medium text-foreground">Security → API Tokens → Generate API token</b>.
						Give it <b className="font-medium text-foreground">Read &amp; Write</b> permission —
						provisioning creates servers, networks, and volumes.
					</p>
					<div className="flex flex-wrap items-center gap-3">
						<Button
							onClick={() => window.open(HETZNER_CONSOLE_URL, "_blank", "noopener,noreferrer")}
							size="sm"
							className="h-8 font-medium text-xs"
							type="button"
						>
							<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
							Open Hetzner Console
						</Button>
						<a
							href={HETZNER_DOCS_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
						>
							Full guide
							<ExternalLink className="h-3 w-3" />
						</a>
					</div>
				</Step>
				<Step n={2} title="Paste the token">
					<FormField
						control={form.control}
						name="token"
						render={({ field }) => (
							<FormItem>
								<div className="flex items-center gap-1.5">
									<FormLabel className="font-medium text-xs">API Token</FormLabel>
									<FieldHelp title="Hetzner Cloud API token">
										A Read &amp; Write, project-scoped token from the Hetzner Cloud Console (Security →
										API Tokens). Alethia encrypts it at rest and only decrypts it on the runner at
										provision time.
									</FieldHelp>
								</div>
								<FormControl>
									<Input
										type="password"
										placeholder="Paste your Read & Write API token"
										autoComplete="off"
										className="h-9 border-border/60 font-mono text-sm"
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-xs" />
							</FormItem>
						)}
					/>
					<WizardDisclosure label="Object Storage keys (optional)" forceOpen={s3Error}>
						<div className="space-y-3">
							<p className="text-ui-xs text-muted-foreground leading-relaxed">
								To provision Hetzner Object Storage buckets, paste an S3 key pair. Hetzner has no API
								to mint these — generate them in the Hetzner Console (Object Storage → S3
								credentials). Leave both blank if you don&apos;t use buckets.
							</p>
							{S3_FIELDS.map((s3) => (
								<FormField
									key={s3.name}
									control={form.control}
									name={s3.name}
									render={({ field }) => (
										<FormItem>
											<FormLabel className="font-medium text-xs">{s3.label}</FormLabel>
											<FormControl>
												<Input
													type="password"
													placeholder={s3.placeholder}
													autoComplete="off"
													className="h-9 border-border/60 font-mono text-sm"
													{...field}
												/>
											</FormControl>
											<FormMessage className="text-xs" />
										</FormItem>
									)}
								/>
							))}
						</div>
					</WizardDisclosure>
					<div className="flex items-start gap-2.5 rounded-md border border-border/40 bg-muted/20 p-3 text-ui-xs text-muted-foreground">
						<ServerCog className="mt-0.5 size-3.5 shrink-0" />
						<p className="leading-relaxed">
							<b className="font-medium text-foreground">Running a self-hosted runner?</b> Set{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5">HCLOUD_TOKEN</code>{" "}
							in the runner&apos;s own environment instead — then Alethia stores no token at all.
						</p>
					</div>
				</Step>
			</ConnectForm>
		</ConnectSheetShell>
	);
}
