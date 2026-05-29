"use client";

import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { VineyardSelector } from "@/components/vineyard-selector";
import { HelpTooltip } from "./help-tooltip";
import { Grape } from "lucide-react";

interface Props {
	projectName: string;
	onProjectNameChange: (v: string) => void;
	environment: string;
	onEnvironmentChange: (v: string) => void;
	vineyardId: string | null;
	onVineyardIdChange: (v: string | null) => void;
}

const PROJECT_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function SectionProjectBasics({
	projectName,
	onProjectNameChange,
	environment,
	onEnvironmentChange,
	vineyardId,
	onVineyardIdChange,
}: Props) {
	const nameError =
		projectName.length > 0 && !PROJECT_NAME_REGEX.test(projectName)
			? "Lowercase letters, numbers, and hyphens only. Must start with a letter or number."
			: null;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Grape className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Project Basics</CardTitle>
				</div>
				<CardDescription className="text-xs">
					Name your vine and choose where it grows.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-1.5">
					<div className="flex items-center gap-1.5">
						<Label className="text-xs">Vineyard Workspace (optional)</Label>
						<HelpTooltip topic="vineyard" />
					</div>
					<VineyardSelector
						value={vineyardId ?? undefined}
						onChange={(v) => onVineyardIdChange(v || null)}
					/>
				</div>

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-1.5">
						<Label className="text-xs">
							Project Name <span className="text-destructive">*</span>
						</Label>
						<Input
							placeholder="my-project"
							maxLength={25}
							value={projectName}
							onChange={(e) => onProjectNameChange(e.target.value.toLowerCase())}
							className={`h-9 text-sm font-mono ${nameError ? "border-destructive" : ""}`}
						/>
						<div className="flex items-center justify-between">
							{nameError ? (
								<p className="text-[11px] text-destructive">{nameError}</p>
							) : (
								<p className="text-[11px] text-muted-foreground">
									Lowercase, numbers, hyphens. Used in AWS resource names.
								</p>
							)}
							{projectName.length > 0 && (
								<p className="text-[11px] text-muted-foreground tabular-nums">
									{projectName.length}/25
								</p>
							)}
						</div>
					</div>

					<div className="space-y-1.5">
						<div className="flex items-center gap-1.5">
							<Label className="text-xs">
								Environment <span className="text-destructive">*</span>
							</Label>
							<HelpTooltip topic="environment" />
						</div>
						<Select value={environment} onValueChange={onEnvironmentChange}>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="development">Development</SelectItem>
								<SelectItem value="staging">Staging</SelectItem>
								<SelectItem value="production">Production</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
