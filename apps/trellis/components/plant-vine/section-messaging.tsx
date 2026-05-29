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
import { HelpTooltip } from "./help-tooltip";
import { MessageSquare, Plus, Trash2 } from "lucide-react";

const NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

function formatTimeout(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	return `${Math.floor(seconds / 3600)}h`;
}

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

	const updateTopic = (index: number, name: string) => {
		const updated = [...topics];
		updated[index] = { ...updated[index], name };
		onTopicsChange(updated);
	};

	const isEmpty = queues.length === 0 && topics.length === 0;

	const getNameError = (name: string, allNames: string[], index: number) => {
		if (!name) return "Name is required";
		if (!NAME_REGEX.test(name)) return "Lowercase, numbers, hyphens only";
		const dup = allNames.findIndex((n, i) => i !== index && n === name);
		if (dup >= 0) return "Duplicate name";
		return null;
	};

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
								{queues.map((q, i) => {
									const nameError = getNameError(q.name, queues.map((x) => x.name), i);
									return (
										<div key={i} className="p-3 border border-border/50 rounded-lg space-y-2">
											<div className="flex items-center gap-3">
												<div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-2">
													<div className="space-y-1">
														<Label className="text-[10px] text-muted-foreground">Name <span className="text-destructive">*</span></Label>
														<Input
															placeholder="email-processing"
															value={q.name}
															onChange={(e) => updateQueue(i, "name", e.target.value.toLowerCase())}
															className={`h-8 text-xs font-mono ${nameError ? "border-destructive" : ""}`}
														/>
														{nameError && <p className="text-[10px] text-destructive">{nameError}</p>}
													</div>
													<div className="space-y-1">
														<div className="flex items-center gap-1">
															<Label className="text-[10px] text-muted-foreground">Visibility Timeout</Label>
															<HelpTooltip topic="visibility-timeout" />
														</div>
														<div className="flex items-center gap-1.5">
															<Input
																type="number"
																min={0}
																max={43200}
																value={q.visibility_timeout}
																onChange={(e) => updateQueue(i, "visibility_timeout", parseInt(e.target.value) || 30)}
																className="h-8 text-xs"
															/>
															<span className="text-[10px] text-muted-foreground shrink-0 w-6">
																{formatTimeout(q.visibility_timeout)}
															</span>
														</div>
													</div>
													<div className="space-y-1">
														<div className="flex items-center gap-1">
															<Label className="text-[10px] text-muted-foreground">FIFO</Label>
															<HelpTooltip topic="fifo" />
														</div>
														<div className="flex items-center h-8">
															<Switch
																checked={q.fifo}
																onCheckedChange={(v) => updateQueue(i, "fifo", v)}
															/>
														</div>
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
										</div>
									);
								})}
							</div>
						)}

						{topics.length > 0 && (
							<div className="space-y-2">
								<Label className="text-xs text-muted-foreground">SNS Topics</Label>
								{topics.map((t, i) => {
									const nameError = getNameError(t.name, topics.map((x) => x.name), i);
									return (
										<div key={i} className="flex items-center gap-3 p-3 border border-border/50 rounded-lg">
											<div className="flex-1 space-y-1">
												<Label className="text-[10px] text-muted-foreground">Name <span className="text-destructive">*</span></Label>
												<Input
													placeholder="user-events"
													value={t.name}
													onChange={(e) => updateTopic(i, e.target.value.toLowerCase())}
													className={`h-8 text-xs font-mono ${nameError ? "border-destructive" : ""}`}
												/>
												{nameError && <p className="text-[10px] text-destructive">{nameError}</p>}
											</div>
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
									);
								})}
							</div>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
