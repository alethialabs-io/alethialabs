"use client";

import { Button } from "@/components/ui/button";
import { FileArchive, FileText, Loader2 } from "lucide-react";
import { useState } from "react";
import { downloadConfigurationYaml, downloadConfigurationZip } from "@/app/server/actions/configurations";

interface ConfigurationDownloadButtonsProps {
	configId: string;
}

export function ConfigurationDownloadButtons({ configId }: ConfigurationDownloadButtonsProps) {
	const [downloadingConfig, setDownloadingConfig] = useState(false);
	const [downloadingZip, setDownloadingZip] = useState(false);

	const handleDownloadConfig = async () => {
		try {
			setDownloadingConfig(true);
			const { content, filename } = await downloadConfigurationYaml(configId);
			const blob = new Blob([content], { type: "application/x-yaml" });
			const url = window.URL.createObjectURL(blob);
			const element = document.createElement("a");
			element.href = url;
			element.download = filename;
			document.body.appendChild(element);
			element.click();
			document.body.removeChild(element);
			window.URL.revokeObjectURL(url);
		} catch (error) {
			console.error(error);
			alert("Failed to download YAML");
		} finally {
			setDownloadingConfig(false);
		}
	};

	const handleDownloadZip = async () => {
		try {
			setDownloadingZip(true);
			const { content, filename } = await downloadConfigurationZip(configId);
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
		} catch (error) {
			console.error(error);
			alert("Failed to download ZIP");
		} finally {
			setDownloadingZip(false);
		}
	};

	return (
		<div className="flex items-center gap-2 w-full">
			<Button
				onClick={handleDownloadConfig}
				disabled={downloadingConfig || downloadingZip}
				size="sm"
				variant="outline"
				className="h-8 text-xs font-medium flex-1"
			>
				{downloadingConfig ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <FileText className="w-3.5 h-3.5 mr-1.5" />}
				YAML
			</Button>
			<Button
				onClick={handleDownloadZip}
				disabled={downloadingConfig || downloadingZip}
				size="sm"
				variant="default"
				className="h-8 text-xs font-medium flex-1"
			>
				{downloadingZip ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <FileArchive className="w-3.5 h-3.5 mr-1.5" />}
				ZIP
			</Button>
		</div>
	);
}