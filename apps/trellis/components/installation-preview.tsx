"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Copy, ExternalLink, Terminal } from "lucide-react";
import { useState } from "react";

export function InstallationPreview() {
	const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

	const copyToClipboard = (text: string, commandId: string) => {
		navigator.clipboard.writeText(text);
		setCopiedCommand(commandId);
		setTimeout(() => setCopiedCommand(null), 2000);
	};

	const installationSteps = [
		{
			id: "setup",
			title: "1. Install Grape CLI",
			commands: [
				"brew tap bobikenobi12/bb-thesis-2026 https://github.com/bobikenobi12/bb-thesis-2026",
				"brew install grape",
			],
		},
		{
			id: "auth",
			title: "2. Authenticate",
			commands: ["grape login", "grape bootstrap"],
		},
		{
			id: "deploy",
			title: "3. Deploy Infrastructure",
			commands: ["grape provision <project_name>"],
		},
	];

	return (
		<Card className="mb-8 border border-border shadow-sm">
			<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
				<div className="flex items-center justify-between">
					<div>
						<CardTitle className="text-lg font-semibold tracking-tight">
							Quick Installation Guide
						</CardTitle>
						<CardDescription>
							Get started with the powerful Grape CLI
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className="pt-6">
				<div className="space-y-6">
					{installationSteps.map((step, stepIndex) => (
						<div key={step.id} className="space-y-3">
							<div className="flex items-center gap-2">
								<Badge variant="outline" className="font-normal text-xs bg-muted/30">
									Step {stepIndex + 1}
								</Badge>
								<h4 className="font-medium text-sm text-foreground">
									{step.title}
								</h4>
							</div>
							<div className="space-y-2 pl-2 border-l border-border/60 ml-3">
								{step.commands.map((command, commandIndex) => (
									<div
										key={commandIndex}
										className="group relative flex items-center justify-between px-4 py-2 bg-muted/30 rounded-md border border-border/40 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
									>
										<div className="flex items-center gap-3 overflow-x-auto">
											<span className="select-none opacity-50">$</span>
											<code className="whitespace-nowrap">
												{command}
											</code>
										</div>
										<Button
											size="sm"
											variant="ghost"
											className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
											onClick={() =>
												copyToClipboard(
													command,
													`${step.id}-${commandIndex}`,
												)
											}
										>
											{copiedCommand ===
											`${step.id}-${commandIndex}` ? (
												<span className="text-xs">
													✓
												</span>
											) : (
												<Copy className="w-3 h-3 text-muted-foreground" />
											)}
										</Button>
									</div>
								))}
							</div>
						</div>
					))}
				</div>

				<div className="mt-8 pt-4 border-t border-border/40">
					<div className="flex items-start gap-3">
						<div className="p-1.5 bg-background border border-border/40 rounded-md">
							<Terminal className="w-4 h-4 text-muted-foreground" />
						</div>
						<div>
							<h4 className="font-medium text-sm text-foreground mb-1">
								Prerequisites
							</h4>
							<ul className="text-xs text-muted-foreground space-y-1.5">
								<li>• Homebrew installed on your system</li>
								<li>
									• AWS CLI configured with appropriate
									permissions
								</li>
								<li>• Active ADP ItGix Platform account</li>
							</ul>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
