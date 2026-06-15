"use client";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { verifyAwsIdentity } from "@/app/(private)/dashboard/providers/actions";
import { getJobStatus } from "@/app/server/actions/jobs";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { zodResolver } from "@hookform/resolvers/zod";
import {
	AlertCircle,
	CheckCircle2,
	CloudIcon,
	Copy,
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
					"Invalid IAM Role ARN format. Example: arn:aws:iam::123456789012:role/GrapeProvisionerRole",
			});
		}
	}),
});

type AwsRoleFormValues = z.infer<typeof awsRoleSchema>;

interface AwsConnectionProps {
	onComplete: (
		roleArn: string,
	) => Promise<{ jobId: string; identityId: string }>;
	externalId: string;
}

type VerifyState =
	| { phase: "idle" }
	| { phase: "verifying"; jobId: string; identityId: string }
	| { phase: "success" }
	| { phase: "failed"; error: string };

export function AwsConnection({ onComplete, externalId }: AwsConnectionProps) {
	const router = useRouter();
	const [method, setMethod] = useState<"cloudformation" | "terraform">(
		"cloudformation",
	);
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
						await verifyAwsIdentity(identityId, jobId);
						setVerifyState({ phase: "success" });
						toast.success("AWS connection verified!");
						router.refresh();
					} else if (result.status === "FAILED") {
						stopPolling();
						setVerifyState({
							phase: "failed",
							error:
								result.error_message ||
								"Connection test failed. Check the Role ARN and External ID.",
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

	const templateUrl =
		"https://alethia-onboarding-templates.s3.eu-west-1.amazonaws.com/alethia-bootstrap.yaml";
	const launchStackUrl = `https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=${encodeURIComponent(templateUrl)}&stackName=GrapeConnect&param_ExternalId=${encodeURIComponent(externalId)}&param_GrapeAwsAccountId=787587782604`;

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

	const copyToClipboard = (text: string, label: string) => {
		navigator.clipboard.writeText(text);
		toast.success(`${label} copied to clipboard`);
	};

	const onSubmit = async (data: AwsRoleFormValues) => {
		setVerifyState({ phase: "verifying", jobId: "", identityId: "" });
		try {
			const { jobId, identityId } = await onComplete(data.roleArn);
			setVerifyState({ phase: "verifying", jobId, identityId });
			startPolling(jobId, identityId);
		} catch (error: any) {
			setVerifyState({
				phase: "failed",
				error: error.message || "Failed to save connection.",
			});
		}
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
							Follow these steps to authorize Grape in your AWS
							account.
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
												Click below to open AWS
												CloudFormation with the template
												and parameters pre-filled.
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
										<div className="mt-4 p-3 bg-muted/30 border border-border/40 rounded-md text-[11px] text-muted-foreground flex items-center gap-2">
											<strong className="text-foreground">
												External ID:
											</strong>
											<code className="bg-background px-1.5 py-0.5 border border-border/50 rounded text-foreground">
												{externalId}
											</code>
											<button
												onClick={() =>
													copyToClipboard(
														externalId,
														"External ID",
													)
												}
												className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
												type="button"
											>
												<Copy className="w-3 h-3" />
											</button>
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
											Apply Terraform Template
										</div>
										<p className="text-xs text-muted-foreground mt-1 max-w-sm">
											Use the following External ID in
											your Terraform variables:
										</p>
										<div className="mt-3 flex items-center gap-2 p-3 bg-muted/30 border border-border/40 rounded-md text-foreground font-mono text-[11px] overflow-hidden">
											<span className="truncate">
												{externalId}
											</span>
											<button
												onClick={() =>
													copyToClipboard(
														externalId,
														"External ID",
													)
												}
												className="ml-auto p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
												type="button"
											>
												<Copy className="w-3.5 h-3.5" />
											</button>
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
							{verifyState.phase === "success" ? (
								<div className="flex items-center gap-3 p-4 bg-muted/50 border border-border rounded-md">
									<CheckCircle2 className="w-5 h-5 text-foreground shrink-0" />
									<div>
										<p className="text-sm font-medium text-foreground">
											Connection verified
										</p>
										<p className="text-xs text-muted-foreground mt-0.5">
											Grape can assume the IAM role in
											your account. You're ready to
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
											Testing role assumption into your
											AWS account. This takes a few
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
												name="roleArn"
												render={({ field }) => (
													<FormItem>
														<FormLabel className="text-xs font-medium text-foreground mb-2 block">
															IAM Role ARN
														</FormLabel>
														<div className="flex gap-2 items-start">
															<div className="relative flex-1">
																<FormControl>
																	<Input
																		placeholder="arn:aws:iam::123456789012:role/GrapeProvisionerRole"
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
													</FormItem>
												)}
											/>
										</form>
									</Form>

									<div className="mt-5 flex items-start gap-2.5 p-3 bg-muted/20 rounded-md border border-border/40 text-[11px] text-muted-foreground">
										<AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
										<p className="leading-relaxed">
											Grape will verify it can assume this
											role using the unique External ID.
											This prevents unauthorized
											cross-account access.
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
