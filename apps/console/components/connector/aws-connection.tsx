"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
import {
	ConnectionTestStatus,
	InfoNote,
	StatusCallout,
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
	ShieldCheck,
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
		defaultValues: {
			roleArn: "",
		},
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
		<div className="max-w-200 mx-auto space-y-6 w-full">
			<div className="flex flex-col gap-4">
				{/* Method Selection */}
				<div className="flex gap-3">
					<button
						onClick={() => setMethod("cloudformation")}
						className={`flex-1 p-3 rounded-lg border text-left transition-all duration-200 ${
							method === "cloudformation"
								? "border-foreground bg-muted/20"
								: "border-border/50 bg-background hover:border-border/80 hover:bg-muted/10"
						}`}
						type="button"
					>
						<div className="flex items-center gap-2.5">
							<div
								className={`p-1.5 rounded-md border ${method === "cloudformation" ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border/50"}`}
							>
								<CloudIcon className="w-3.5 h-3.5" />
							</div>
							<div>
								<div className="font-medium text-sm text-foreground">
									CloudFormation
								</div>
								<div className="text-[11px] text-muted-foreground">
									Quick setup via AWS Console
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
							Create a keyless IAM role that trusts the Alethia
							issuer — no access keys, no external id.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-6 pt-6">
						{method === "cloudformation" ? (
							<div className="space-y-8">
								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										1
									</div>
									<div className="space-y-3">
										<div>
											<div className="font-medium text-sm text-foreground">
												Launch Stack
											</div>
											<p className="text-xs text-muted-foreground mt-1 mb-3 max-w-sm">
												Opens AWS CloudFormation with the
												template pre-filled. It creates an
												IAM OIDC provider that trusts the
												Alethia issuer and a role Alethia
												assumes via web identity.
												Acknowledge the IAM capabilities
												and create the stack.
											</p>
										</div>
										<div className="flex gap-3">
											<Button
												onClick={() =>
													window.open(
														launchStackUrl,
														"_blank",
													)
												}
												size="sm"
												className="h-8 text-xs font-medium"
												type="button"
											>
												<ExternalLink className="w-3.5 h-3.5 mr-1.5 opacity-70" />
												Launch Stack in AWS
											</Button>
											<Button
												onClick={handleDownload}
												variant="outline"
												size="sm"
												className="h-8 text-xs font-medium border-border/50"
												type="button"
											>
												<CloudIcon className="w-3.5 h-3.5 mr-1.5 opacity-70" />
												Download Template
											</Button>
										</div>
									</div>
								</div>

								<div className="flex gap-4">
									<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
										2
									</div>
									<div className="flex-1">
										<div className="font-medium text-sm text-foreground">
											Copy Role ARN
										</div>
										<p className="text-xs text-muted-foreground mt-1 max-w-sm">
											Once the stack is created, go to the{" "}
											<b className="text-foreground font-medium">
												Outputs
											</b>{" "}
											tab and copy the{" "}
											<b className="text-foreground font-medium">
												RoleArn
											</b>
											.
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
											Creates the IAM OIDC provider + role
											that trust the Alethia issuer. No
											variables are required — the defaults
											pin the issuer, audience, and subject.
										</p>
										<div className="mt-3 flex flex-wrap items-center gap-3">
											<Button
												type="button"
												size="sm"
												className="h-8 text-xs font-medium"
												onClick={() => {
													const a = document.createElement("a");
													a.href = "/connector-terraform/aws.tf";
													a.download = "alethia-aws.tf";
													document.body.appendChild(a);
													a.click();
													document.body.removeChild(a);
												}}
											>
												<Download className="w-3.5 h-3.5 mr-1.5 opacity-70" />
												Download module
											</Button>
											<a
												href="/docs/console/connectors/aws"
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
											Deploy & Extract ARN
										</div>
										<p className="text-xs text-muted-foreground mt-1 max-w-sm">
											Run{" "}
											<code className="bg-muted px-1 py-0.5 border border-border/50 rounded text-foreground">
												terraform apply
											</code>{" "}
											and copy the output{" "}
											<b className="text-foreground font-medium">
												role_arn
											</b>
											.
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
									successText="Alethia can assume the IAM role in your account. You're ready to provision infrastructure."
									verifyingText="Testing role assumption into your AWS account."
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
												name="roleArn"
												render={({ field }) => (
													<FormItem>
														<div className="mb-2 flex items-center gap-1.5">
															<FormLabel className="text-xs font-medium text-foreground">
																IAM Role ARN
															</FormLabel>
															<FieldHelp title="IAM Role ARN">
																The ARN of the role the setup created. Copy it
																from the CloudFormation{" "}
																<b className="text-foreground">Outputs</b> tab
																(<code className="text-foreground">RoleArn</code>),
																or from{" "}
																<code className="text-foreground">
																	terraform output role_arn
																</code>
																. Looks like{" "}
																<code className="text-foreground">
																	arn:aws:iam::123456789012:role/AlethiaProvisionerRole
																</code>
																.
															</FieldHelp>
														</div>
														<div className="flex gap-2 items-start">
															<div className="relative flex-1">
																<FormControl>
																	<Input
																		placeholder="arn:aws:iam::123456789012:role/AlethiaProvisionerRole"
																		className="h-9 text-sm border-border/50"
																		{...field}
																	/>
																</FormControl>
																{!form.formState
																	.errors
																	.roleArn &&
																	field.value &&
																	field.value.startsWith(
																		"arn:aws:iam::",
																	) && (
																		<CheckCircle2 className="absolute right-3 top-2 h-5 w-5 text-foreground" />
																	)}
															</div>
															<Button
																disabled={
																	!form
																		.formState
																		.isValid
																}
																type="submit"
																className="min-w-25 h-9 text-xs font-medium"
															>
																{verifyState.phase ===
																"failed"
																	? "Retry"
																	: "Connect"}
															</Button>
														</div>
														<FormMessage className="text-xs" />
														{verifyState.phase === "failed" && (
															<div className="mt-3">
																<StatusCallout
																	variant="error"
																	title="Verification failed"
																>
																	{verifyState.error}
																</StatusCallout>
															</div>
														)}
													</FormItem>
												)}
											/>
										</form>
									</Form>

									<div className="mt-5">
										<InfoNote>
											Alethia assumes this role via
											AssumeRoleWithWebIdentity, presenting a
											short-lived token signed by the Alethia
											issuer — no access keys and no shared
											secret ever leave your account.
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
