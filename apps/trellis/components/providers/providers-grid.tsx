"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AwsConnection } from "@/components/onboarding/aws-connection";
import type { AwsConnectionStatus } from "@/app/(private)/dashboard/providers/actions";
import {
	disconnectAwsIdentity,
	saveAwsIdentity,
} from "@/app/(private)/dashboard/providers/actions";
import {
	CheckCircle2,
	ExternalLink,
	Loader2,
	Unplug,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

interface ProvidersGridProps {
	awsStatus: AwsConnectionStatus;
	awsSetup: { externalId: string; identityId: string } | null;
}

type Provider = {
	id: string;
	name: string;
	description: string;
	status: "available" | "connected" | "coming_soon";
	logo: string;
	docsUrl?: string;
};

export function ProvidersGrid({ awsStatus, awsSetup }: ProvidersGridProps) {
	const router = useRouter();
	const [sheetOpen, setSheetOpen] = useState(false);
	const [disconnectOpen, setDisconnectOpen] = useState(false);
	const [isDisconnecting, setIsDisconnecting] = useState(false);

	const providers: Provider[] = [
		{
			id: "aws",
			name: "Amazon Web Services",
			description:
				"Cross-account IAM role for EKS clusters, VPCs, and infrastructure provisioning.",
			status: awsStatus.connected ? "connected" : "available",
			logo: "/aws/favicon_64x64.png",
			docsUrl: "https://console.aws.amazon.com/iam/home#/roles",
		},
		{
			id: "gcp",
			name: "Google Cloud Platform",
			description:
				"Service account with Workload Identity Federation for GKE clusters and Google Cloud resources.",
			status: "coming_soon",
			logo: "/gcp/favicon_64x64.png",
		},
		{
			id: "azure",
			name: "Microsoft Azure",
			description:
				"Service principal with federated credentials for AKS clusters and Azure resources.",
			status: "coming_soon",
			logo: "/azure/favicon_64x64.png",
		},
		{
			id: "alibaba",
			name: "Alibaba Cloud",
			description:
				"RAM role with cross-account access for ACK clusters and Alibaba Cloud resources.",
			status: "coming_soon",
			logo: "/alibaba/favicon_64x64.png",
		},
	];

	const handleAwsConnect = async (roleArn: string) => {
		if (!awsSetup) throw new Error("AWS setup not initialized");
		await saveAwsIdentity(awsSetup.identityId, roleArn);
		setSheetOpen(false);
		localStorage.removeItem("aws_onboarding_skipped");
		router.refresh();
	};

	const handleDisconnect = async () => {
		if (!awsStatus.identityId) return;
		setIsDisconnecting(true);
		try {
			await disconnectAwsIdentity(awsStatus.identityId);
			toast.success("AWS account disconnected.");
			setDisconnectOpen(false);
			router.refresh();
		} catch {
			toast.error("Failed to disconnect AWS account.");
		} finally {
			setIsDisconnecting(false);
		}
	};

	return (
		<>
			<div className="border border-border/50 rounded-lg divide-y divide-border/50 bg-background">
				{providers.map((provider) => {
					const isComingSoon = provider.status === "coming_soon";
					const isConnected = provider.status === "connected";

					return (
						<div
							key={provider.id}
							className={`flex items-center gap-4 px-5 py-4 transition-colors ${
								isComingSoon
									? "opacity-50"
									: "hover:bg-muted/30"
							}`}
						>
							<div className="shrink-0 w-10 h-10 rounded-lg border border-border/50 bg-background flex items-center justify-center overflow-hidden p-1.5">
								<Image
									src={provider.logo}
									alt={provider.name}
									width={28}
									height={28}
									className="object-contain"
								/>
							</div>

							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2.5">
									<span className="text-sm font-medium text-foreground">
										{provider.name}
									</span>
									{isConnected && (
										<Badge
											variant="outline"
											className="text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950 text-[10px] py-0"
										>
											<CheckCircle2 className="w-3 h-3 mr-1" />
											Connected
										</Badge>
									)}
									{isComingSoon && (
										<Badge
											variant="secondary"
											className="text-[10px] py-0"
										>
											Coming Soon
										</Badge>
									)}
								</div>
								<p className="text-xs text-muted-foreground mt-0.5 truncate pr-4">
									{provider.description}
								</p>
								{isConnected && awsStatus.accountId && (
									<p className="text-[11px] text-muted-foreground font-mono mt-1">
										Account {awsStatus.accountId}
									</p>
								)}
							</div>

							<div className="shrink-0 flex items-center gap-2">
								{provider.id === "aws" && isConnected && (
									<>
										{provider.docsUrl && (
											<Button
												variant="ghost"
												size="sm"
												className="text-xs h-8 text-muted-foreground hover:text-foreground"
												onClick={() =>
													window.open(
														provider.docsUrl,
														"_blank",
													)
												}
											>
												<ExternalLink className="w-3.5 h-3.5" />
											</Button>
										)}
										<Button
											variant="outline"
											size="sm"
											className="text-xs h-8 text-destructive hover:text-destructive hover:bg-destructive/10 border-border/50"
											onClick={() =>
												setDisconnectOpen(true)
											}
										>
											Disconnect
										</Button>
									</>
								)}

								{provider.id === "aws" && !isConnected && (
									<Button
										size="sm"
										className="text-xs h-8"
										onClick={() => setSheetOpen(true)}
										disabled={!awsSetup}
									>
										Connect
									</Button>
								)}
							</div>
						</div>
					);
				})}
			</div>

			<Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
				<SheetContent
					side="right"
					className="w-full sm:max-w-2xl overflow-y-auto p-0"
				>
					<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
						<SheetTitle>Connect AWS Account</SheetTitle>
						<SheetDescription>
							Set up a cross-account IAM role to allow Grape to
							provision infrastructure in your AWS account.
						</SheetDescription>
					</SheetHeader>
					<div className="px-6 py-6">
						{awsSetup && (
							<AwsConnection
								externalId={awsSetup.externalId}
								onComplete={handleAwsConnect}
							/>
						)}
					</div>
				</SheetContent>
			</Sheet>

			<AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Disconnect AWS Account?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This will remove the stored IAM role ARN. You won't
							be able to provision new infrastructure until you
							reconnect. Existing resources are not affected.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDisconnecting}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleDisconnect}
							disabled={isDisconnecting}
							className="bg-destructive text-white hover:bg-destructive/90"
						>
							{isDisconnecting ? (
								<Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
							) : (
								<Unplug className="w-3.5 h-3.5 mr-1.5" />
							)}
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
