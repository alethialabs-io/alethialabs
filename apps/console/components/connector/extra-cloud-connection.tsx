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
import { getJobStatus } from "@/app/server/actions/jobs";
import { verifyExtraCloudIdentity } from "@/app/(private)/dashboard/providers/extra-cloud-actions";
import {
	AlertCircle,
	CheckCircle2,
	Copy,
	ExternalLink,
	KeyRound,
	Loader2,
	Server,
	ShieldCheck,
	XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";

type VerifyState =
	| { phase: "idle" }
	| { phase: "verifying" }
	| { phase: "success" }
	| { phase: "failed"; error: string };

type SaveResult = { jobId: string; identityId: string };

/** Save → poll the CONNECTION_TEST job → verify. Shared by both forms. */
function useVerifyPoll() {
	const router = useRouter();
	const [state, setState] = useState<VerifyState>({ phase: "idle" });
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const stop = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);
	useEffect(() => () => stop(), [stop]);

	const run = useCallback(
		async (save: () => Promise<SaveResult>) => {
			setState({ phase: "verifying" });
			let jobId = "";
			let identityId = "";
			try {
				({ jobId, identityId } = await save());
			} catch (e) {
				setState({
					phase: "failed",
					error: e instanceof Error ? e.message : "Failed to save connection.",
				});
				return;
			}
			stop();
			pollRef.current = setInterval(async () => {
				try {
					const r = await getJobStatus(jobId);
					if (!r) return;
					if (r.status === "SUCCESS") {
						stop();
						await verifyExtraCloudIdentity(identityId, jobId);
						setState({ phase: "success" });
						toast.success("Connection verified!");
						router.refresh();
					} else if (r.status === "FAILED") {
						stop();
						setState({
							phase: "failed",
							error: r.error_message || "Connection test failed.",
						});
					}
				} catch {
					stop();
					setState({ phase: "failed", error: "Failed to check verification status." });
				}
			}, 2000);
		},
		[stop, router],
	);

	return { state, run };
}

/** Numbered step, identical to the aws/gcp/azure sheets. */
function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
	return (
		<div className="flex gap-4">
			<div className="shrink-0 w-7 h-7 rounded-full bg-muted border border-border/50 text-foreground flex items-center justify-center font-medium text-xs">
				{n}
			</div>
			<div className="space-y-3 flex-1 min-w-0">
				<div className="font-medium text-sm text-foreground">{title}</div>
				{children}
			</div>
		</div>
	);
}

/** One of the two method-selection tabs (mirrors aws/gcp/azure). */
function MethodTab({
	active,
	onClick,
	icon,
	title,
	subtitle,
}: {
	active: boolean;
	onClick: () => void;
	icon: ReactNode;
	title: string;
	subtitle: string;
}) {
	return (
		<button
			onClick={onClick}
			type="button"
			className={`flex-1 p-3 rounded-lg border text-left transition-all duration-200 ${
				active
					? "border-foreground bg-muted/20"
					: "border-border/50 bg-background hover:border-border/80 hover:bg-muted/10"
			}`}
		>
			<div className="flex items-center gap-2.5">
				<div
					className={`p-1.5 rounded-md border ${active ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border/50"}`}
				>
					{icon}
				</div>
				<div>
					<div className="font-medium text-sm text-foreground">{title}</div>
					<div className="text-[11px] text-muted-foreground">{subtitle}</div>
				</div>
			</div>
		</button>
	);
}

/**
 * Verify section + form, styled exactly like the success/verifying/failed blocks
 * in aws/gcp/azure-connection. `children` is the provider-specific form.
 */
function VerifySection({
	state,
	successText,
	verifyingText,
	children,
}: {
	state: VerifyState;
	successText: string;
	verifyingText: string;
	children: ReactNode;
}) {
	return (
		<div className="pt-6 border-t border-border/40">
			{state.phase === "success" ? (
				<div className="flex items-center gap-3 p-4 bg-muted/50 border border-border rounded-md">
					<CheckCircle2 className="w-5 h-5 text-foreground shrink-0" />
					<div>
						<p className="text-sm font-medium text-foreground">Connection verified</p>
						<p className="text-xs text-muted-foreground mt-0.5">{successText}</p>
					</div>
				</div>
			) : state.phase === "verifying" ? (
				<div className="flex items-center gap-3 p-4 bg-muted/30 border border-border/40 rounded-md">
					<Loader2 className="w-5 h-5 animate-spin text-muted-foreground shrink-0" />
					<div>
						<p className="text-sm font-medium text-foreground">Verifying connection…</p>
						<p className="text-xs text-muted-foreground mt-0.5">{verifyingText}</p>
					</div>
				</div>
			) : (
				<>
					{state.phase === "failed" && (
						<div className="flex items-start gap-3 p-4 mb-4 bg-destructive/5 border border-destructive/20 rounded-md">
							<XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
							<div>
								<p className="text-sm font-medium text-destructive">Verification failed</p>
								<p className="text-xs text-muted-foreground mt-0.5">{state.error}</p>
							</div>
						</div>
					)}
					{children}
				</>
			)}
		</div>
	);
}

// --- Token clouds: DigitalOcean / Hetzner / Civo ---

const tokenSchema = z.object({ token: z.string().min(16, "Enter a valid API token.") });

export function TokenCloudConnection({
	providerName,
	tokenHelp,
	docsUrl,
	envVar,
	onSave,
	onSaveSelfManaged,
}: {
	providerName: string;
	tokenHelp: string;
	docsUrl?: string;
	envVar: string;
	onSave: (token: string) => Promise<SaveResult>;
	onSaveSelfManaged: () => Promise<SaveResult>;
}) {
	const { state, run } = useVerifyPoll();
	const [method, setMethod] = useState<"token" | "self">("token");
	const form = useForm<{ token: string }>({
		resolver: zodResolver(tokenSchema),
		defaultValues: { token: "" },
		mode: "onChange",
	});

	const retry = state.phase === "failed";

	return (
		<div className="max-w-[800px] mx-auto space-y-6 w-full">
			{/* Method Selection — store a token vs. self-hosted-runner (zero stored). */}
			<div className="flex gap-3">
				<MethodTab
					active={method === "token"}
					onClick={() => setMethod("token")}
					icon={<KeyRound className="w-3.5 h-3.5" />}
					title="Store a scoped token"
					subtitle="Encrypted at rest in Alethia"
				/>
				<MethodTab
					active={method === "self"}
					onClick={() => setMethod("self")}
					icon={<Server className="w-3.5 h-3.5" />}
					title="Self-hosted runner"
					subtitle="Token stays in your infra"
				/>
			</div>

			<Card className="border-border/40 shadow-sm bg-background">
				<CardHeader className="border-b border-border/40 pb-4 bg-muted/5">
					<CardTitle className="text-base font-medium flex items-center gap-2">
						<ShieldCheck className="w-4.5 h-4.5 text-muted-foreground" />
						Setup Instructions
					</CardTitle>
					<CardDescription className="text-xs">
						{method === "self"
							? `${providerName} has no role federation. Run a self-hosted runner with the token in its environment — Alethia stores nothing.`
							: `${providerName} has no role federation, so Alethia connects with a scoped API token. Grant it only the permissions provisioning needs.`}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6 pt-6">
					{method === "token" ? (
						<>
							<div className="space-y-8">
								<Step n={1} title={`Create an API token in ${providerName}`}>
									<p className="text-xs text-muted-foreground max-w-sm">{tokenHelp}</p>
									{docsUrl && (
										<Button
											onClick={() => window.open(docsUrl, "_blank")}
											size="sm"
											className="h-8 text-xs font-medium"
											type="button"
										>
											<ExternalLink className="w-3.5 h-3.5 mr-1.5 opacity-70" />
											Open {providerName} token settings
										</Button>
									)}
								</Step>
								<Step n={2} title="Paste the token below">
									<p className="text-xs text-muted-foreground max-w-sm">
										Alethia verifies it immediately and stores it encrypted (AES-GCM) — it is
										only decrypted on the runner at provision time, never in a spec snapshot.
									</p>
								</Step>
							</div>

							<VerifySection
								state={state}
								successText={`Alethia can authenticate into ${providerName} with your token. You're ready to provision infrastructure.`}
								verifyingText={`Testing your ${providerName} token against the ${providerName} API. This takes a few seconds.`}
							>
								<Form {...form}>
									<form
										onSubmit={form.handleSubmit((d) => run(() => onSave(d.token)))}
										className="space-y-4"
									>
										<FormField
											control={form.control}
											name="token"
											render={({ field }) => (
												<FormItem>
													<FormLabel className="text-xs font-medium">API Token</FormLabel>
													<FormControl>
														<Input
															type="password"
															placeholder="Paste your scoped API token"
															className="h-9 text-sm font-mono border-border/50"
															{...field}
														/>
													</FormControl>
													<FormMessage className="text-xs" />
												</FormItem>
											)}
										/>
										<Button
											disabled={!form.formState.isValid}
											type="submit"
											className="w-full h-9 text-xs font-medium"
										>
											{retry ? "Retry" : "Connect"}
										</Button>
									</form>
								</Form>
								<div className="mt-5 flex items-start gap-2.5 p-3 bg-muted/20 rounded-md border border-border/40 text-[11px] text-muted-foreground">
									<AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
									<p className="leading-relaxed">
										Revoke the token in {providerName} at any time to cut Alethia&apos;s access.
									</p>
								</div>
							</VerifySection>
						</>
					) : (
						<>
							<div className="space-y-8">
								<Step n={1} title="Set the token in your self-hosted runner">
									<p className="text-xs text-muted-foreground max-w-sm">
										Export the token in the environment of a runner you operate (`operator=self`).
										Alethia never receives or stores it.
									</p>
									<div className="flex items-center gap-2 p-2.5 bg-muted/30 border border-border/40 rounded-md font-mono text-[11px]">
										<span className="break-all min-w-0">{envVar}=&lt;your-token&gt;</span>
										<button
											type="button"
											onClick={() => {
												navigator.clipboard.writeText(`${envVar}=`);
												toast.success("Copied");
											}}
											className="ml-auto p-1 shrink-0 text-muted-foreground hover:text-foreground rounded"
										>
											<Copy className="w-3.5 h-3.5" />
										</button>
									</div>
								</Step>
								<Step n={2} title="Connect">
									<p className="text-xs text-muted-foreground max-w-sm">
										Alethia records the account with <b>no credential</b>. A self-hosted runner
										with {envVar} set verifies it — managed runners can never claim it.
									</p>
								</Step>
							</div>

							<VerifySection
								state={state}
								successText={`${providerName} connected — your self-hosted runner authenticated with its own token. Alethia stored nothing.`}
								verifyingText={`Waiting for a self-hosted runner with ${envVar} set to claim the connection test.`}
							>
								<Button
									type="button"
									onClick={() => run(() => onSaveSelfManaged())}
									className="w-full h-9 text-xs font-medium"
								>
									{retry ? "Retry" : "Connect (no token stored)"}
								</Button>
								<div className="mt-5 flex items-start gap-2.5 p-3 bg-muted/20 rounded-md border border-border/40 text-[11px] text-muted-foreground">
									<AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
									<p className="leading-relaxed">
										True zero-trust for clouds without federation: the secret never enters
										Alethia&apos;s database — it stays in your own infrastructure.
									</p>
								</div>
							</VerifySection>
						</>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

// --- Alibaba: RAM role (zero stored credentials) ---

const alibabaSchema = z.object({
	roleArn: z
		.string()
		.regex(/^acs:ram::\d+:role\/[\w+=,.@-]+$/, "Expected acs:ram::<account-id>:role/<role-name>"),
});

export function AlibabaConnection({
	externalId,
	onSave,
}: {
	externalId?: string;
	onSave: (roleArn: string) => Promise<SaveResult>;
}) {
	const { state, run } = useVerifyPoll();
	const form = useForm<{ roleArn: string }>({
		resolver: zodResolver(alibabaSchema),
		defaultValues: { roleArn: "" },
		mode: "onChange",
	});

	const retry = state.phase === "failed";

	return (
		<div className="max-w-[800px] mx-auto space-y-6 w-full">
			<Card className="border-border/40 shadow-sm bg-background">
				<CardHeader className="border-b border-border/40 pb-4 bg-muted/5">
					<CardTitle className="text-base font-medium flex items-center gap-2">
						<ShieldCheck className="w-4.5 h-4.5 text-muted-foreground" />
						Setup Instructions
					</CardTitle>
					<CardDescription className="text-xs">
						Alethia assumes a RAM role in your account — no Alibaba credentials are stored.
						Create the role, then paste its ARN.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6 pt-6">
					<div className="space-y-8">
						<Step n={1} title="Create a RAM role that trusts Alethia">
							<p className="text-xs text-muted-foreground max-w-sm">
								In the RAM console, create a role for a trusted Alibaba Cloud account and
								add a condition requiring the External ID below (prevents the
								confused-deputy problem).
							</p>
							{externalId && (
								<div className="flex items-center gap-2 p-2.5 bg-muted/30 border border-border/40 rounded-md font-mono text-[11px]">
									<span className="text-muted-foreground shrink-0">External ID:</span>
									<span className="break-all min-w-0">{externalId}</span>
									<button
										type="button"
										onClick={() => {
											navigator.clipboard.writeText(externalId);
											toast.success("External ID copied");
										}}
										className="ml-auto p-1 shrink-0 text-muted-foreground hover:text-foreground rounded"
									>
										<Copy className="w-3.5 h-3.5" />
									</button>
								</div>
							)}
						</Step>

						<Step n={2} title="Attach provisioning permissions">
							<p className="text-xs text-muted-foreground max-w-sm">
								Grant the role the permissions Alethia needs (ACK, VPC, and the managed
								services your Specs use).
							</p>
						</Step>

						<Step n={3} title="Paste the role ARN below">
							<p className="text-xs text-muted-foreground max-w-sm">
								Copy the role ARN from the RAM console — it looks like
								<code className="mx-1 bg-muted px-1 py-0.5 border border-border/50 rounded">acs:ram::&lt;account&gt;:role/&lt;name&gt;</code>.
							</p>
						</Step>
					</div>

					<VerifySection
						state={state}
						successText="Alethia recorded your RAM role and verified it with a real STS AssumeRole — zero stored credentials."
						verifyingText="Assuming the RAM role via Alibaba STS."
					>
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit((d) => run(() => onSave(d.roleArn)))}
								className="space-y-4"
							>
								<FormField
									control={form.control}
									name="roleArn"
									render={({ field }) => (
										<FormItem>
											<FormLabel className="text-xs font-medium">RAM Role ARN</FormLabel>
											<FormControl>
												<Input
													placeholder="acs:ram::5123456789012345:role/AlethiaProvisioner"
													className="h-9 text-sm font-mono border-border/50"
													{...field}
												/>
											</FormControl>
											<FormMessage className="text-xs" />
										</FormItem>
									)}
								/>
								<Button
									disabled={!form.formState.isValid}
									type="submit"
									className="w-full h-9 text-xs font-medium"
								>
									{retry ? "Retry" : "Connect"}
								</Button>
							</form>
						</Form>
					</VerifySection>
				</CardContent>
			</Card>
		</div>
	);
}
