"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";

type SesQueue = { name: string; visibility_timeout: number };
type SesTopic = { name: string; subscriptions: string[] };

interface SesConfigInputProps {
	queues: SesQueue[];
	topics: SesTopic[];
	onQueuesChange: (queues: SesQueue[]) => void;
	onTopicsChange: (topics: SesTopic[]) => void;
}

export function SesConfigInput({
	queues,
	topics,
	onQueuesChange,
	onTopicsChange,
}: SesConfigInputProps) {
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
					SQS Queues
				</p>
				{queues.map((q, i) => (
					<div key={i} className="flex items-center gap-2">
						<Input
							placeholder="Queue name"
							value={q.name}
							onChange={(e) => {
								const updated = [...queues];
								updated[i] = {
									...updated[i],
									name: e.target.value,
								};
								onQueuesChange(updated);
							}}
							className="h-8 text-sm flex-1"
						/>
						<Input
							type="number"
							placeholder="Timeout"
							value={q.visibility_timeout}
							onChange={(e) => {
								const updated = [...queues];
								updated[i] = {
									...updated[i],
									visibility_timeout:
										parseInt(e.target.value) || 300,
								};
								onQueuesChange(updated);
							}}
							className="h-8 text-sm w-24"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
							onClick={() =>
								onQueuesChange(
									queues.filter((_, j) => j !== i),
								)
							}
						>
							<X className="h-3.5 w-3.5" />
						</Button>
					</div>
				))}
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-7 text-xs"
					onClick={() =>
						onQueuesChange([
							...queues,
							{ name: "", visibility_timeout: 300 },
						])
					}
				>
					<Plus className="h-3 w-3 mr-1" />
					Add Queue
				</Button>
			</div>

			<div className="space-y-2">
				<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
					SNS Topics
				</p>
				{topics.map((t, i) => (
					<div key={i} className="flex items-center gap-2">
						<Input
							placeholder="Topic name"
							value={t.name}
							onChange={(e) => {
								const updated = [...topics];
								updated[i] = {
									...updated[i],
									name: e.target.value,
								};
								onTopicsChange(updated);
							}}
							className="h-8 text-sm flex-1"
						/>
						<Input
							placeholder="Subscriptions (comma-sep)"
							value={t.subscriptions.join(", ")}
							onChange={(e) => {
								const updated = [...topics];
								updated[i] = {
									...updated[i],
									subscriptions: e.target.value
										.split(",")
										.map((s) => s.trim())
										.filter(Boolean),
								};
								onTopicsChange(updated);
							}}
							className="h-8 text-sm flex-1"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
							onClick={() =>
								onTopicsChange(
									topics.filter((_, j) => j !== i),
								)
							}
						>
							<X className="h-3.5 w-3.5" />
						</Button>
					</div>
				))}
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-7 text-xs"
					onClick={() =>
						onTopicsChange([
							...topics,
							{ name: "", subscriptions: [] },
						])
					}
				>
					<Plus className="h-3 w-3 mr-1" />
					Add Topic
				</Button>
			</div>
		</div>
	);
}

export function serializeSesConfig(
	queues: SesQueue[],
	topics: SesTopic[],
): string {
	if (queues.length === 0 && topics.length === 0) return "";
	const parts: string[] = [];
	if (queues.length > 0) {
		parts.push("queues:");
		for (const q of queues.filter((q) => q.name)) {
			parts.push(`  - name: ${q.name}`);
			parts.push(`    visibility_timeout: ${q.visibility_timeout}`);
		}
	}
	if (topics.length > 0) {
		parts.push("topics:");
		for (const t of topics.filter((t) => t.name)) {
			parts.push(`  - name: ${t.name}`);
			if (t.subscriptions.length > 0) {
				parts.push("    subscriptions:");
				for (const s of t.subscriptions) {
					parts.push(`      - ${s}`);
				}
			}
		}
	}
	return parts.join("\n");
}

export function parseSesConfig(yaml: string): {
	queues: SesQueue[];
	topics: SesTopic[];
} {
	if (!yaml) return { queues: [], topics: [] };
	const queues: SesQueue[] = [];
	const topics: SesTopic[] = [];

	const queueMatches = [
		...yaml.matchAll(
			/- name:\s*(\S+)\s*\n\s*visibility_timeout:\s*(\d+)/g,
		),
	];
	for (const m of queueMatches) {
		queues.push({
			name: m[1],
			visibility_timeout: parseInt(m[2]),
		});
	}

	const topicSection = yaml.split("topics:")[1];
	if (topicSection) {
		const topicBlocks = topicSection.split(/\n\s*- name:\s*/);
		for (const block of topicBlocks.filter(Boolean)) {
			const nameMatch = block.match(/^(\S+)/);
			if (!nameMatch) continue;
			const subs: string[] = [];
			const subMatches = [...block.matchAll(/^\s+- (\S+)/gm)];
			for (const s of subMatches) {
				subs.push(s[1]);
			}
			topics.push({ name: nameMatch[1], subscriptions: subs });
		}
	}

	return { queues, topics };
}
