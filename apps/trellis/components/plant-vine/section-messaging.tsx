"use client";

import type { QueueEntry, TopicEntry } from "./plant-vine-form";
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
import { Switch } from "@/components/ui/switch";
import { MessageSquare, Plus, Trash2 } from "lucide-react";

interface Props {
	queues: QueueEntry[];
	onQueuesChange: (v: QueueEntry[]) => void;
	topics: TopicEntry[];
	onTopicsChange: (v: TopicEntry[]) => void;
}

export function SectionMessaging({
	queues,
	onQueuesChange,
	topics,
	onTopicsChange,
}: Props) {
	const addQueue = () => {
		onQueuesChange([
			...queues,
			{ name: "", fifo: false, visibility_timeout: 30 },
		]);
	};

	const removeQueue = (index: number) => {
		onQueuesChange(queues.filter((_, i) => i !== index));
	};

	const updateQueue = (index: number, field: keyof QueueEntry, value: any) => {
		const updated = [...queues];
		updated[index] = { ...updated[index], [field]: value };
		onQueuesChange(updated);
	};

	const addTopic = () => {
		onTopicsChange([...topics, { name: "", subscriptions: [] }]);
	};

	const removeTopic = (index: number) => {
		onTopicsChange(topics.filter((_, i) => i !== index));
	};

	const updateTopic = (index: number, field: keyof TopicEntry, value: any) => {
		const updated = [...topics];
		updated[index] = { ...updated[index], [field]: value };
		onTopicsChange(updated);
	};

	const isEmpty = queues.length === 0 && topics.length === 0;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<MessageSquare className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Messaging</CardTitle>
					</div>
					<div className="flex gap-2">
						<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addQueue}>
							<Plus className="h-3.5 w-3.5 mr-1" />
							Queue
						</Button>
						<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addTopic}>
							<Plus className="h-3.5 w-3.5 mr-1" />
							Topic
						</Button>
					</div>
				</div>
				<CardDescription className="text-xs">
					SQS queues and SNS topics for event-driven architectures.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{isEmpty ? (
					<div className="text-center py-8 text-muted-foreground">
						<MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-20" />
						<p className="text-sm">No messaging configured.</p>
						<p className="text-[11px] mt-1">Add SQS queues or SNS topics as needed.</p>
					</div>
				) : (
					<>
						{queues.length > 0 && (
							<div className="space-y-2">
								<Label className="text-xs text-muted-foreground">SQS Queues</Label>
								{queues.map((q, i) => (
									<div key={i} className="flex items-center gap-3 p-3 border border-border/50 rounded-lg">
										<div className="flex-1 grid grid-cols-3 gap-2">
											<Input
												placeholder="queue-name"
												value={q.name}
												onChange={(e) => updateQueue(i, "name", e.target.value)}
												className="h-8 text-xs"
											/>
											<Input
												type="number"
												min={0}
												max={43200}
												value={q.visibility_timeout}
												onChange={(e) => updateQueue(i, "visibility_timeout", parseInt(e.target.value) || 30)}
												className="h-8 text-xs"
												title="Visibility timeout (seconds)"
											/>
											<div className="flex items-center gap-2">
												<span className="text-[11px] text-muted-foreground">FIFO</span>
												<Switch
													checked={q.fifo}
													onCheckedChange={(v) => updateQueue(i, "fifo", v)}
												/>
											</div>
										</div>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
											onClick={() => removeQueue(i)}
										>
											<Trash2 className="h-3.5 w-3.5" />
										</Button>
									</div>
								))}
							</div>
						)}

						{topics.length > 0 && (
							<div className="space-y-2">
								<Label className="text-xs text-muted-foreground">SNS Topics</Label>
								{topics.map((t, i) => (
									<div key={i} className="flex items-center gap-3 p-3 border border-border/50 rounded-lg">
										<Input
											placeholder="topic-name"
											value={t.name}
											onChange={(e) => updateTopic(i, "name", e.target.value)}
											className="h-8 text-xs flex-1"
										/>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
											onClick={() => removeTopic(i)}
										>
											<Trash2 className="h-3.5 w-3.5" />
										</Button>
									</div>
								))}
							</div>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
