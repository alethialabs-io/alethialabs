"use client";

import {
	downloadConfigurationYaml,
	downloadConfigurationZip,
	getConfigurations,
	GetConfigurationsData,
} from "@/app/server/actions/configurations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Archive,
	CheckCircle,
	Download,
	FileText,
	Loader2,
	Package,
} from "lucide-react";
import { useEffect, useState } from "react";

interface DownloadOptionsProps {
	configurationData?: { id: string; project_name: string; [key: string]: unknown };
}

export function DownloadOptions({ configurationData }: DownloadOptionsProps) {
	const [downloadedItems, setDownloadedItems] = useState<string[]>([]);
	const [loadingItems, setLoadingItems] = useState<string[]>([]);
	const [fetchedConfig, setFetchedConfig] = useState<
		GetConfigurationsData[0] | null
	>(null);

	useEffect(() => {
		if (!configurationData) {
			getConfigurations({ limit: 1 })
				.then((data) => {
					setFetchedConfig(data.configurations[0] || null);
				})
				.catch((err) =>
					console.error("Failed to fetch latest configuration:", err),
				);
		}
	}, [configurationData]);

	const handleDownload = async (itemType: string) => {
		const dataToUse = configurationData || fetchedConfig;
		if (!dataToUse?.id) {
			alert(
				"No configuration data available. Please complete the configuration form first.",
			);
			return;
		}

		setLoadingItems((prev) => [...prev, itemType]);

		try {
			if (itemType === "config") {
				const { content, filename } = await downloadConfigurationYaml(
					dataToUse.id,
				);
				const blob = new Blob([content], {
					type: "application/x-yaml",
				});
				const url = window.URL.createObjectURL(blob);
				const element = document.createElement("a");
				element.href = url;
				element.download = filename;
				document.body.appendChild(element);
				element.click();
				document.body.removeChild(element);
				window.URL.revokeObjectURL(url);
			} else if (itemType === "terraform") {
				const { content, filename } = await downloadConfigurationZip(
					dataToUse.id,
				);
				// Convert base64 string to Blob
				const byteCharacters = atob(content);
				const byteNumbers = new Array(byteCharacters.length);
				for (let i = 0; i < byteCharacters.length; i++) {
					byteNumbers[i] = byteCharacters.charCodeAt(i);
				}
				const byteArray = new Uint8Array(byteNumbers);
				const blob = new Blob([byteArray], { type: "application/zip" });
				const url = window.URL.createObjectURL(blob);
				const element = document.createElement("a");
				element.href = url;
				element.download = filename;
				document.body.appendChild(element);
				element.click();
				document.body.removeChild(element);
				window.URL.revokeObjectURL(url);
			} else if (itemType === "docker") {
				alert(
					"Docker image generation will be available in the next release.",
				);
				setLoadingItems((prev) =>
					prev.filter((item) => item !== itemType),
				);
				return;
			}

			// Mark as downloaded
			setDownloadedItems((prev) => [...prev, itemType]);
		} catch (error) {
			console.error("Download error:", error);
			alert(
				`Failed to download file: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
			);
		} finally {
			setLoadingItems((prev) => prev.filter((item) => item !== itemType));
		}
	};

	const downloadOptions = [
		{
			id: "config",
			title: "Configuration File",
			description: "YAML configuration with all your settings",
			filename: "output-file.yaml",
			icon: <FileText className="w-5 h-5 text-muted-foreground" />,
			size: "~2-5 KB",
		},
		{
			id: "terraform",
			title: "Installer Package",
			description:
				"IDP installer (v1.2.6) bundled with your configuration",
			filename: "idp-installer-v1.2.6.zip",
			icon: <Archive className="w-5 h-5 text-muted-foreground" />,
			size: "~1-2 MB",
		},
		{
			id: "docker",
			title: "Container Image",
			description: "Docker configuration and deployment files",
			filename: "docker-deployment.tar.gz",
			icon: <Package className="w-5 h-5 text-muted-foreground" />,
			size: "~45 MB",
			disabled: true, // Temporarily disabled until implementation
		},
	];

	return (
		<Card className="mb-8 border border-border shadow-sm">
			<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
				<CardTitle className="text-lg font-semibold tracking-tight">
					Download Files
				</CardTitle>
				<CardDescription>
					Get all the generated files you need to deploy your platform
				</CardDescription>
			</CardHeader>
			<CardContent className="pt-6">
				<div className="grid md:grid-cols-3 gap-4">
					{downloadOptions.map((option) => (
						<Card
							key={option.id}
							className={`border border-border/60 bg-card hover:border-border/80 transition-all ${
								option.disabled
									? "opacity-50 pointer-events-none"
									: ""
							}`}
						>
							<CardHeader className="p-4 pb-3">
								<div className="flex items-center justify-between mb-2">
									<div className="p-2 bg-muted/50 rounded-md">
										{option.icon}
									</div>
									<Badge
										variant="secondary"
										className="font-mono text-[10px] px-1.5 bg-muted"
									>
										{option.size}
									</Badge>
								</div>
								<CardTitle className="text-sm font-semibold">
									{option.title}
								</CardTitle>
								<CardDescription className="text-xs line-clamp-2 min-h-8 mt-1">
									{option.description}
								</CardDescription>
							</CardHeader>
							<CardContent className="p-4 pt-0">
								{option.disabled ? (
									<Badge
										variant="outline"
										className="w-full justify-center h-8 font-normal text-xs text-muted-foreground rounded-md border-dashed"
									>
										Coming Soon
									</Badge>
								) : (
									<Button
										onClick={() =>
											handleDownload(option.id)
										}
										disabled={
											downloadedItems.includes(
												option.id,
											) ||
											loadingItems.includes(option.id)
										}
										className="w-full h-8 text-xs font-medium"
										variant={
											downloadedItems.includes(option.id)
												? "secondary"
												: "outline"
										}
									>
										{loadingItems.includes(option.id) ? (
											<>
												<Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
												Generating...
											</>
										) : downloadedItems.includes(
												option.id,
										  ) ? (
											<>
												<CheckCircle className="w-3.5 h-3.5 mr-1.5" />
												Downloaded
											</>
										) : (
											<>
												<Download className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
												Download
											</>
										)}
									</Button>
								)}
							</CardContent>
						</Card>
					))}
				</div>

				<div className="mt-6 p-4 bg-muted/20 border border-border/50 rounded-lg">
					<div className="flex items-start gap-3">
						<div className="p-1.5 bg-background border border-border/40 rounded-md">
							<FileText className="w-4 h-4 text-muted-foreground" />
						</div>
						<div>
							<h4 className="font-medium text-sm text-foreground mb-1">
								Important Notes
							</h4>
							<ul className="text-xs text-muted-foreground space-y-1.5">
								<li>
									• Keep your configuration files secure and
									version controlled
								</li>
								<li>
									• Review the Terraform plan before applying
									changes
								</li>
								<li>
									• Ensure your AWS credentials have the
									necessary permissions
								</li>
								<li>
									• The installer ZIP includes your
									configuration pre-loaded in the config
									directory
								</li>
							</ul>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
