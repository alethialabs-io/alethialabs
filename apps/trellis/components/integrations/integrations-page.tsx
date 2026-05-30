"use client";

import type { IntegrationWithConnection } from "@/app/server/actions/integrations";
import { deleteProviderToken } from "@/app/server/actions/identities";
import {
	disconnectAwsIdentity,
	saveAwsIdentity,
} from "@/app/(private)/dashboard/providers/actions";
import {
	disconnectGcpIdentity,
	saveGcpIdentity,
} from "@/app/(private)/dashboard/providers/gcp-actions";
import { AwsConnection } from "@/components/onboarding/aws-connection";
import { GcpConnection } from "@/components/onboarding/gcp-connection";
import { IntegrationDetailSheet } from "@/components/integrations/integration-detail-sheet";
import { IntegrationsList } from "@/components/integrations/integrations-list";
import {
	IntegrationsSidebar,
	type CategoryFilter,
} from "@/components/integrations/integrations-sidebar";
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
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/client";
import type { PublicGitProvider } from "@/lib/validations/db.schemas";
import { Loader2, Search, Unplug } from "lucide-react";
import { env } from "next-runtime-env";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

interface IntegrationsPageProps {
	integrations: IntegrationWithConnection[];
	awsSetup: { externalId: string; identityId: string } | null;
	gcpSetup: { identityId: string } | null;
}

export function IntegrationsPage({
	integrations,
	awsSetup,
	gcpSetup,
}: IntegrationsPageProps) {
	const router = useRouter();
	const [selectedCategory, setSelectedCategory] =
		useState<CategoryFilter>("all");
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedIntegration, setSelectedIntegration] =
		useState<IntegrationWithConnection | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [awsSheetOpen, setAwsSheetOpen] = useState(false);
	const [gcpSheetOpen, setGcpSheetOpen] = useState(false);
	const [disconnectTarget, setDisconnectTarget] =
		useState<IntegrationWithConnection | null>(null);
	const [isDisconnecting, setIsDisconnecting] = useState(false);
	const [connectingSlug, setConnectingSlug] = useState<string | null>(null);

	const counts = useMemo(
		() => ({
			all: integrations.length,
			git: integrations.filter((i) => i.category === "git").length,
			cloud: integrations.filter((i) => i.category === "cloud").length,
		}),
		[integrations],
	);

	const filtered = useMemo(() => {
		let result = integrations;
		if (selectedCategory !== "all") {
			result = result.filter((i) => i.category === selectedCategory);
		}
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter(
				(i) =>
					i.name.toLowerCase().includes(q) ||
					i.description.toLowerCase().includes(q) ||
					i.organization.toLowerCase().includes(q),
			);
		}
		return result;
	}, [integrations, selectedCategory, searchQuery]);

	const handleConnect = async (integration: IntegrationWithConnection) => {
		if (integration.category === "git") {
			setConnectingSlug(integration.slug);
			try {
				const supabase = createClient();
				const {
					data: { user },
					error: userError,
				} = await supabase.auth.getUser();

				if (userError || !user) {
					await supabase.auth.signOut();
					window.location.href = "/auth/signin";
					return;
				}

				const provider = integration.slug as PublicGitProvider;
				const { error } = await supabase.auth.linkIdentity({
					provider,
					options: {
						redirectTo: `${env("NEXT_PUBLIC_APP_URL") || window.location.origin}/api/auth/callback?next=/dashboard/integrations&provider=${provider}`,
						scopes:
							provider === "github"
								? "repo"
								: provider === "gitlab"
									? "read_api read_user read_repository read_registry openid profile email"
									: undefined,
					},
				});
				if (error) throw error;
			} catch (err) {
				console.error(`Error linking ${integration.slug}:`, err);
				toast.error(`Failed to connect ${integration.name}`);
			} finally {
				setConnectingSlug(null);
			}
		} else if (integration.slug === "aws") {
			setAwsSheetOpen(true);
		} else if (integration.slug === "gcp") {
			setGcpSheetOpen(true);
		}
		setDetailOpen(false);
	};

	const handleDisconnect = (integration: IntegrationWithConnection) => {
		setDisconnectTarget(integration);
		setDetailOpen(false);
	};

	const confirmDisconnect = async () => {
		if (!disconnectTarget) return;
		setIsDisconnecting(true);

		try {
			if (disconnectTarget.category === "git") {
				const supabase = createClient();

				const {
					data: { user },
				} = await supabase.auth.getUser();
				const identity = user?.identities?.find(
					(i) => i.provider === disconnectTarget.slug,
				);

				if (identity) {
					const { error } =
						await supabase.auth.unlinkIdentity(identity);
					if (error) throw error;
				}

				await deleteProviderToken(
					disconnectTarget.slug as PublicGitProvider,
				);
				toast.success(
					`Successfully disconnected ${disconnectTarget.name}`,
				);
			} else if (disconnectTarget.slug === "aws") {
				const cloudIdentityId =
					disconnectTarget.connection_details?.cloud_identity_id;
				if (!cloudIdentityId) throw new Error("Missing identity ID");
				await disconnectAwsIdentity(cloudIdentityId);
				toast.success("AWS account disconnected.");
			} else if (disconnectTarget.slug === "gcp") {
				const cloudIdentityId =
					disconnectTarget.connection_details?.cloud_identity_id;
				if (!cloudIdentityId) throw new Error("Missing identity ID");
				await disconnectGcpIdentity(cloudIdentityId);
				toast.success("GCP project disconnected.");
			}

			setDisconnectTarget(null);
			router.refresh();
		} catch (err) {
			console.error("Disconnect error:", err);
			toast.error(
				`Failed to disconnect ${disconnectTarget?.name ?? "integration"}`,
			);
		} finally {
			setIsDisconnecting(false);
		}
	};

	const handleAwsConnect = async (roleArn: string) => {
		if (!awsSetup) throw new Error("AWS setup not initialized");
		const result = await saveAwsIdentity(awsSetup.identityId, roleArn);
		localStorage.removeItem("aws_onboarding_skipped");
		return result;
	};

	const handleGcpConnect = async (wifConfigJson: string) => {
		if (!gcpSetup) throw new Error("GCP setup not initialized");
		return await saveGcpIdentity(gcpSetup.identityId, wifConfigJson);
	};

	const openDetail = (integration: IntegrationWithConnection) => {
		setSelectedIntegration(integration);
		setDetailOpen(true);
	};

	return (
		<>
			<div className="flex gap-8">
				<IntegrationsSidebar
					selected={selectedCategory}
					onSelect={setSelectedCategory}
					counts={counts}
				/>

				<div className="flex-1 space-y-4">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<Input
							placeholder="Search integrations..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-9 h-9 text-sm bg-muted/30 border-border/50"
						/>
					</div>

					<IntegrationsList
						integrations={filtered}
						onCardClick={openDetail}
						onConnect={handleConnect}
						onDisconnect={handleDisconnect}
						connectingSlug={connectingSlug}
					/>
				</div>
			</div>

			<IntegrationDetailSheet
				integration={selectedIntegration}
				open={detailOpen}
				onOpenChange={setDetailOpen}
				onConnect={() =>
					selectedIntegration && handleConnect(selectedIntegration)
				}
				onDisconnect={() =>
					selectedIntegration &&
					handleDisconnect(selectedIntegration)
				}
				isConnecting={connectingSlug === selectedIntegration?.slug}
			/>

			{/* AWS Connection Sheet */}
			<Sheet open={awsSheetOpen} onOpenChange={(open) => {
				setAwsSheetOpen(open);
				if (!open) router.refresh();
			}}>
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

			{/* GCP Connection Sheet */}
			<Sheet open={gcpSheetOpen} onOpenChange={(open) => {
				setGcpSheetOpen(open);
				if (!open) router.refresh();
			}}>
				<SheetContent
					side="right"
					className="w-full sm:max-w-2xl overflow-y-auto p-0"
				>
					<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
						<SheetTitle>Connect GCP Project</SheetTitle>
						<SheetDescription>
							Set up Workload Identity Federation to allow Grape to
							provision infrastructure in your GCP project.
						</SheetDescription>
					</SheetHeader>
					<div className="px-6 py-6">
						{gcpSetup && (
							<GcpConnection
								onComplete={handleGcpConnect}
							/>
						)}
					</div>
				</SheetContent>
			</Sheet>

			{/* Disconnect Confirmation */}
			<AlertDialog
				open={!!disconnectTarget}
				onOpenChange={(open) => !open && setDisconnectTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Disconnect {disconnectTarget?.name}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{disconnectTarget?.slug === "aws"
								? "This will remove the stored IAM role ARN. You won't be able to provision new AWS infrastructure until you reconnect. Existing resources are not affected."
								: disconnectTarget?.slug === "gcp"
									? "This will remove the Workload Identity Federation configuration. You won't be able to provision new GCP infrastructure until you reconnect. Existing resources are not affected."
									: disconnectTarget?.category === "cloud"
										? "This will remove the stored credentials. You won't be able to provision new infrastructure until you reconnect. Existing resources are not affected."
										: `This will unlink your ${disconnectTarget?.name} account. You won't be able to access repositories from this provider until you reconnect.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDisconnecting}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={confirmDisconnect}
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
