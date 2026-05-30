"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
	getVerifiedCloudIdentities,
	type CloudIdentityOption,
} from "@/app/server/actions/aws/identities";
import { duplicateVineForProvider } from "@/app/server/actions/vines";
import {
	getProvider,
	REGION_LABELS,
	REGION_MAP,
	type CloudProviderSlug,
	type ConversionWarning,
} from "@/lib/cloud-providers";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
	AlertTriangle,
	ArrowRightLeft,
	CheckCircle2,
	Info,
	Loader2,
	XCircle,
} from "lucide-react";
import Image from "next/image";
import { toast } from "sonner";

interface DuplicateVineDialogProps {
	vineId: string;
	vineName: string;
	sourceProvider: string;
}

/** Dialog for duplicating a vine configuration to another cloud provider. */
export function DuplicateVineDialog({
	vineId,
	vineName,
	sourceProvider,
}: DuplicateVineDialogProps) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [identities, setIdentities] = useState<CloudIdentityOption[]>([]);
	const [selectedIdentityId, setSelectedIdentityId] = useState<string>("");
	const [selectedRegion, setSelectedRegion] = useState<string>("");
	const [isConverting, setIsConverting] = useState(false);
	const [warnings, setWarnings] = useState<ConversionWarning[] | null>(null);

	useEffect(() => {
		if (open) {
			getVerifiedCloudIdentities().then((all) => {
				const otherProviders = all.filter(
					(i) => i.provider !== sourceProvider,
				);
				setIdentities(otherProviders);
			});
		}
	}, [open, sourceProvider]);

	const selectedIdentity = identities.find(
		(i) => i.id === selectedIdentityId,
	);
	const targetProvider = (selectedIdentity?.provider ??
		"aws") as CloudProviderSlug;
	const targetMeta = getProvider(targetProvider);
	const sourceMeta = getProvider(sourceProvider);

	const regionMap =
		REGION_MAP[sourceProvider as CloudProviderSlug]?.[targetProvider] ?? {};
	const suggestedRegion = Object.values(regionMap)[0] ?? "";
	const targetRegionLabels = REGION_LABELS[targetProvider] ?? {};
	const targetRegions = Object.entries(targetRegionLabels).map(
		([code, meta]) => ({
			value: code,
			label: `${meta.label} (${code})`,
		}),
	);

	useEffect(() => {
		if (selectedIdentity && !selectedRegion) {
			setSelectedRegion(suggestedRegion);
		}
	}, [selectedIdentity, suggestedRegion, selectedRegion]);

	const handleConvert = async () => {
		if (!selectedIdentityId || !selectedRegion) return;
		setIsConverting(true);
		try {
			const result = await duplicateVineForProvider(
				vineId,
				selectedIdentityId,
				selectedRegion,
			);
			setWarnings(result.warnings);
			toast.success(
				`Vine duplicated for ${targetMeta.shortName}!`,
			);
			setOpen(false);
			router.refresh();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to duplicate vine",
			);
		} finally {
			setIsConverting(false);
		}
	};

	const severityIcon = (severity: string) => {
		switch (severity) {
			case "error":
				return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
			case "warning":
				return (
					<AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
				);
			default:
				return <Info className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm" className="h-8 text-xs">
					<ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
					Duplicate for Provider
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-base">
						Duplicate Vine
					</DialogTitle>
					<DialogDescription className="text-xs">
						Create a copy of{" "}
						<span className="font-mono font-medium text-foreground">
							{vineName}
						</span>{" "}
						for another cloud provider. Values will be automatically
						mapped.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-2">
					<div className="flex items-center gap-3 text-xs text-muted-foreground">
						<div className="flex items-center gap-1.5">
							<Image
								src={sourceMeta.icon}
								alt={sourceMeta.shortName}
								width={16}
								height={16}
							/>
							<span>{sourceMeta.shortName}</span>
						</div>
						<ArrowRightLeft className="h-3 w-3" />
						{selectedIdentity ? (
							<div className="flex items-center gap-1.5">
								<Image
									src={targetMeta.icon}
									alt={targetMeta.shortName}
									width={16}
									height={16}
								/>
								<span>{targetMeta.shortName}</span>
							</div>
						) : (
							<span>Select target</span>
						)}
					</div>

					<div className="space-y-1.5">
						<Label className="text-xs">Target Cloud Account</Label>
						<Select
							value={selectedIdentityId}
							onValueChange={(id) => {
								setSelectedIdentityId(id);
								setSelectedRegion("");
								setWarnings(null);
							}}
						>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue placeholder="Select target account" />
							</SelectTrigger>
							<SelectContent>
								{identities.length === 0 ? (
									<div className="p-3 text-xs text-muted-foreground text-center">
										No other cloud accounts connected
									</div>
								) : (
									identities.map((identity) => {
										const meta = getProvider(
											identity.provider,
										);
										return (
											<SelectItem
												key={identity.id}
												value={identity.id}
											>
												<div className="flex items-center gap-2">
													<Image
														src={meta.icon}
														alt={meta.shortName}
														width={14}
														height={14}
													/>
													<span>{identity.name}</span>
													<span className="text-xs text-muted-foreground font-mono">
														{identity.displayId}
													</span>
												</div>
											</SelectItem>
										);
									})
								)}
							</SelectContent>
						</Select>
					</div>

					{selectedIdentity && (
						<div className="space-y-1.5">
							<Label className="text-xs">Target Region</Label>
							<Select
								value={selectedRegion}
								onValueChange={setSelectedRegion}
							>
								<SelectTrigger className="h-9 text-sm">
									<SelectValue placeholder="Select region" />
								</SelectTrigger>
								<SelectContent>
									{targetRegions.map((r) => (
										<SelectItem
											key={r.value}
											value={r.value}
											className="text-xs"
										>
											{r.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{warnings && warnings.length > 0 && (
						<div className="space-y-1.5 max-h-48 overflow-y-auto">
							<Label className="text-xs text-muted-foreground">
								Conversion Notes
							</Label>
							{warnings.map((w, i) => (
								<div
									key={i}
									className="flex items-start gap-2 p-2 rounded-md bg-muted/30 text-[11px]"
								>
									{severityIcon(w.severity)}
									<div>
										<span className="font-medium">
											{w.component}:
										</span>{" "}
										{w.message}
									</div>
								</div>
							))}
						</div>
					)}
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setOpen(false)}
					>
						Cancel
					</Button>
					<Button
						size="sm"
						disabled={
							!selectedIdentityId ||
							!selectedRegion ||
							isConverting
						}
						onClick={handleConvert}
					>
						{isConverting ? (
							<>
								<Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
								Converting...
							</>
						) : (
							<>
								<CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
								Create Draft
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
