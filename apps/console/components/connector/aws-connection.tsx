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
import { FieldHelp } from "@repo/ui/field-help";
import {
	ALETHIA_ISSUER_URL,
	connectorAssetUrl,
} from "@/components/connector/connector-assets";
import { zodResolver } from "@hookform/resolvers/zod";
import {
	CheckCircle2,
	CloudIcon,
	Download,
	ExternalLink,
	Terminal,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

// Zod schema for Role ARN validation
const awsRoleSchema = z.object({
	roleArn: z.string().superRefine((val, ctx) => {
		if (val.startsWith("arn:aws:cloudformation:")) {
			ctx.addIssue({
				code: "custom",
				message:
					"You have pasted a CloudFormation Stack ARN. Please go to the 'Outputs' tab in the AWS Console and copy the 'RoleArn' instead.",
			});
			return;
		}

		const iamRoleRegex = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
		if (!iamRoleRegex.test(val)) {
			ctx.addIssue({
				code: "custom",
				message:
					"Invalid IAM Role ARN format. Example: arn:aws:iam::123456789012:role/AlethiaProvisionerRole",
			});
		}
	}),
});

type AwsRoleFormValues = z.infer<typeof awsRoleSchema>;

interface AwsConnectionProps {
	onComplete: (roleArn: string) => Promise<VerifyOutcome>;
}

export function AwsConnection({ onComplete }: AwsConnectionProps) {
	const [method, setMethod] = useState<"cloudformation" | "terraform">(
		"cloudformation",
	);
	const { state: verifyState, run, cancel } = useConnectionTest();

	const templateUrl = connectorAssetUrl("alethia-bootstrap.yaml");
	// Pre-fill the issuer so a self-hosted console points the customer's trust at its OWN issuer. No
	// ExternalId / platform-account params — the customer's role trusts the Alethia issuer directly.
	const launchStackUrl = `https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=${encodeURIComponent(templateUrl)}&stackName=AlethiaConnect&param_IssuerUrl=${encodeURIComponent(ALETHIA_ISSUER_URL)}`;

	const form = useForm<AwsRoleFormValues>({
		resolver: zodResolver(awsRoleSchema),
		defaultValues: { roleArn: "" },
		mode: "onChange",
	});

	const handleDownload = () => {
		const link = document.createElement("a");
		link.href = "/alethia-bootstrap.yaml";
		link.download = "alethia-bootstrap.yaml";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	};

	const onSubmit = async (data: AwsRoleFormValues) => {
		await run(() => onComplete(data.roleArn));
	};

	return (
		<ConnectSheetShell
			intro="You create an IAM role in your own AWS account that trusts Alethia's issuer. Alethia signs in with a short-lived, minted token — no access keys and no external id are ever shared or stored."
			howItWorks={
				<>
					<p>
						1. Launch the CloudFormation stack (or apply the Terraform module) — it creates
						an IAM OIDC provider trusting Alethia&apos;s issuer and a role that trusts it.
					</p>
					<p>
						2. Alethia authenticates with a signed token its issuer mints (≤10 min); AWS STS
						verifies it via <code>AssumeRoleWithWebIdentity</code> and returns a ~1-hour
						credential — no key on either side.
					</p>
					<p>
						3. The only thing stored is the role ARN (a public identifier). Delete the stack
						or role to revoke access.
					</p>
				</>
			}
		>
			<MethodTabs
				value={method}
				onChange={(id) => setMethod(id as "cloudformation" | "terraform")}
				help={
					<>
						<b className="text-foreground">CloudFormation</b> is one click — it opens the AWS
						console with everything pre-filled; nothing to install.{" "}
						<b className="text-foreground">Terraform</b> is for teams that manage
						infrastructure as code: download the module and <code>apply</code> it. Both create
						the same role.
					</>
				}
				tabs={[
					{
						id: "cloudformation",
						label: "CloudFormation",
						sub: "Quick setup via AWS Console",
						icon: <CloudIcon className="h-3.5 w-3.5" />,
					},
					{
						id: "terraform",
						label: "Terraform / IaC",
						sub: "Infrastructure as Code",
						icon: <Terminal className="h-3.5 w-3.5" />,
					},
				]}
			/>

			{method === "cloudformation" ? (
				<div className="space-y-6">
					<Step n={1} title="Launch Stack">
						<p className="max-w-sm text-muted-foreground text-xs">
							Opens AWS CloudFormation with the template pre-filled. It creates an IAM OIDC
							provider that trusts the Alethia issuer and a role Alethia assumes via web
							identity. Acknowledge the IAM capabilities and create the stack.
						</p>
						<div className="flex gap-3">
							<Button
								onClick={() => window.open(launchStackUrl, "_blank")}
								size="sm"
								className="h-8 font-medium text-xs"
								type="button"
							>
								<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Launch Stack in AWS
							</Button>
							<Button
								onClick={handleDownload}
								variant="outline"
								size="sm"
								className="h-8 border-border/60 font-medium text-xs"
								type="button"
							>
								<CloudIcon className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download Template
							</Button>
						</div>
					</Step>
					<Step n={2} title="Copy Role ARN">
						<p className="max-w-sm text-muted-foreground text-xs">
							Once the stack is created, go to the{" "}
							<b className="font-medium text-foreground">Outputs</b> tab and copy the{" "}
							<b className="font-medium text-foreground">RoleArn</b>.
						</p>
					</Step>
				</div>
			) : (
				<div className="space-y-6">
					<Step n={1} title="Apply Terraform Module">
						<p className="max-w-sm text-muted-foreground text-xs">
							Creates the IAM OIDC provider + role that trust the Alethia issuer. No
							variables are required — the defaults pin the issuer, audience, and subject.
						</p>
						<div className="mt-2 flex flex-wrap items-center gap-3">
							<Button
								type="button"
								size="sm"
								className="h-8 font-medium text-xs"
								onClick={() => {
									const a = document.createElement("a");
									a.href = "/connector-terraform/aws.tf";
									a.download = "alethia-aws.tf";
									document.body.appendChild(a);
									a.click();
									document.body.removeChild(a);
								}}
							>
								<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download module
							</Button>
							<a
								href="/docs/console/connectors/aws"
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
							>
								Full guide
								<ExternalLink className="h-3 w-3" />
							</a>
						</div>
					</Step>
					<Step n={2} title="Deploy & Extract ARN">
						<p className="max-w-sm text-muted-foreground text-xs">
							Run{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5 text-foreground">
								terraform apply
							</code>{" "}
							and copy the output{" "}
							<b className="font-medium text-foreground">role_arn</b>.
						</p>
					</Step>
				</div>
			)}

			<VerifySection
				state={verifyState}
				onCancel={cancel}
				successText="Alethia can assume the IAM role in your account. You're ready to provision infrastructure."
				verifyingText="Testing role assumption into your AWS account."
			>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="roleArn"
							render={({ field }) => (
								<FormItem>
									<div className="mb-2 flex items-center gap-1.5">
										<FormLabel className="font-medium text-foreground text-xs">
											IAM Role ARN
										</FormLabel>
										<FieldHelp title="IAM Role ARN">
											The ARN of the role the setup created. Copy it from the
											CloudFormation <b className="text-foreground">Outputs</b> tab (
											<code className="text-foreground">RoleArn</code>), or from{" "}
											<code className="text-foreground">terraform output role_arn</code>
											. Looks like{" "}
											<code className="text-foreground">
												arn:aws:iam::123456789012:role/AlethiaProvisionerRole
											</code>
											.
										</FieldHelp>
									</div>
									<div className="flex items-start gap-2">
										<div className="relative flex-1">
											<FormControl>
												<Input
													placeholder="arn:aws:iam::123456789012:role/AlethiaProvisionerRole"
													className="h-9 border-border/60 text-sm"
													{...field}
												/>
											</FormControl>
											{!form.formState.errors.roleArn &&
												field.value &&
												field.value.startsWith("arn:aws:iam::") && (
													<CheckCircle2 className="absolute top-2 right-3 h-5 w-5 text-foreground" />
												)}
										</div>
										<Button
											disabled={!form.formState.isValid}
											type="submit"
											className="h-9 min-w-25 font-medium text-xs"
										>
											{verifyState.phase === "failed" ? "Retry" : "Connect"}
										</Button>
									</div>
									<FormMessage className="text-xs" />
								</FormItem>
							)}
						/>
					</form>
				</Form>
				<StoredNote
					stored="only the IAM role ARN (a public identifier) — no access keys, secrets, or external id."
					revoke="delete the CloudFormation stack (or the role) to cut Alethia's access."
				/>
			</VerifySection>
		</ConnectSheetShell>
	);
}
