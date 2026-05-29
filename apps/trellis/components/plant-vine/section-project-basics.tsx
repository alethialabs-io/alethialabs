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
import { Grape } from "lucide-react";

interface Props {
	projectName: string;
	onProjectNameChange: (v: string) => void;
	environment: string;
	onEnvironmentChange: (v: string) => void;
	vineyardId: string | null;
	onVineyardIdChange: (v: string | null) => void;
}

export function SectionProjectBasics({
	projectName,
	onProjectNameChange,
	environment,
	onEnvironmentChange,
	vineyardId,
	onVineyardIdChange,
}: Props) {
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
					<Label className="text-xs">Vineyard Workspace</Label>
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
							onChange={(e) => onProjectNameChange(e.target.value)}
							className="h-9 text-sm"
						/>
						<p className="text-[11px] text-muted-foreground">
							{projectName.length}/25 characters
						</p>
					</div>

					<div className="space-y-1.5">
						<Label className="text-xs">
							Environment <span className="text-destructive">*</span>
						</Label>
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
