"use client";

import type { CacheEntry } from "./plant-vine-form";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { HelpTooltip } from "./help-tooltip";
import { Cpu, Plus, Trash2 } from "lucide-react";

const NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

interface Props {
	caches: CacheEntry[];
	onCachesChange: (v: CacheEntry[]) => void;
}

export function SectionCaches({ caches, onCachesChange }: Props) {
	const addCache = () => {
		onCachesChange([
			...caches,
			{
				name: caches.length === 0 ? "primary" : `cache-${caches.length + 1}`,
				engine: "redis",
				node_type: "cache.t3.medium",
				num_cache_nodes: 1,
				multi_az: false,
			},
		]);
	};

	const removeCache = (index: number) => {
		onCachesChange(caches.filter((_, i) => i !== index));
	};

	const updateCache = (index: number, field: keyof CacheEntry, value: any) => {
		const updated = [...caches];
		updated[index] = { ...updated[index], [field]: value };
		onCachesChange(updated);
	};

	const getNameError = (name: string, index: number) => {
		if (!name) return "Name is required";
		if (!NAME_REGEX.test(name)) return "Lowercase, numbers, hyphens only";
		const dup = caches.findIndex((c, i) => i !== index && c.name === name);
		if (dup >= 0) return "Duplicate name";
		return null;
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Cpu className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Caches</CardTitle>
					</div>
					<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addCache}>
						<Plus className="h-3.5 w-3.5 mr-1.5" />
						Add Cache
					</Button>
				</div>
				<CardDescription className="text-xs">
					In-memory caching for your applications.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{caches.length === 0 ? (
					<div className="text-center py-8 text-muted-foreground">
						<Cpu className="h-8 w-8 mx-auto mb-2 opacity-20" />
						<p className="text-sm">No caches configured.</p>
						<p className="text-[11px] mt-1">Click "Add Cache" to include a Redis or Valkey cluster.</p>
					</div>
				) : (
					caches.map((cache, i) => {
						const nameError = getNameError(cache.name, i);

						return (
							<div key={i} className="p-4 border border-border/50 rounded-lg space-y-3">
								<div className="flex items-center justify-between">
									<span className="text-sm font-medium">{cache.name || "Unnamed"}</span>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="h-7 w-7 text-muted-foreground hover:text-destructive"
										onClick={() => removeCache(i)}
									>
										<Trash2 className="h-3.5 w-3.5" />
									</Button>
								</div>

								<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
									<div className="space-y-1">
										<Label className="text-[11px]">Name <span className="text-destructive">*</span></Label>
										<Input
											value={cache.name}
											onChange={(e) => updateCache(i, "name", e.target.value.toLowerCase())}
											className={`h-8 text-xs font-mono ${nameError ? "border-destructive" : ""}`}
										/>
										{nameError && <p className="text-[10px] text-destructive">{nameError}</p>}
									</div>
									<div className="space-y-1">
										<div className="flex items-center gap-1">
											<Label className="text-[11px]">Engine</Label>
											<HelpTooltip topic="cache-engine" />
										</div>
										<Select value={cache.engine} onValueChange={(v) => updateCache(i, "engine", v)}>
											<SelectTrigger className="h-8 text-xs">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="redis">Redis</SelectItem>
												<SelectItem value="valkey">Valkey</SelectItem>
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-1">
										<Label className="text-[11px]">Node Type</Label>
										<Select value={cache.node_type} onValueChange={(v) => updateCache(i, "node_type", v)}>
											<SelectTrigger className="h-8 text-xs">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="cache.t3.micro">t3.micro (~$12/mo each)</SelectItem>
												<SelectItem value="cache.t3.small">t3.small (~$18/mo each)</SelectItem>
												<SelectItem value="cache.t3.medium">t3.medium (~$25/mo each)</SelectItem>
												<SelectItem value="cache.r6g.large">r6g.large (~$108/mo each)</SelectItem>
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-1">
										<Label className="text-[11px]">Nodes</Label>
										<Input
											type="number"
											min={1}
											max={6}
											value={cache.num_cache_nodes}
											onChange={(e) => updateCache(i, "num_cache_nodes", parseInt(e.target.value) || 1)}
											className="h-8 text-xs"
										/>
									</div>
								</div>

								<div className="flex items-center justify-between p-2 bg-muted/20 rounded">
									<div className="flex items-center gap-1.5">
										<span className="text-[11px] text-muted-foreground">Multi-AZ Failover</span>
										<HelpTooltip topic="multi-az" />
									</div>
									<Switch
										checked={cache.multi_az}
										onCheckedChange={(v) => updateCache(i, "multi_az", v)}
									/>
								</div>
							</div>
						);
					})
				)}
			</CardContent>
		</Card>
	);
}
