"use client";

import type { DatabaseEntry } from "./plant-vine-form";
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
import { Database, Plus, Trash2 } from "lucide-react";

interface Props {
	databases: DatabaseEntry[];
	onDatabasesChange: (v: DatabaseEntry[]) => void;
}

export function SectionDatabases({ databases, onDatabasesChange }: Props) {
	const addDatabase = () => {
		onDatabasesChange([
			...databases,
			{
				name: databases.length === 0 ? "primary" : `db-${databases.length + 1}`,
				engine: "aurora-postgresql",
				min_capacity: 0.5,
				max_capacity: 4,
				port: 5432,
				iam_auth: false,
			},
		]);
	};

	const removeDatabase = (index: number) => {
		onDatabasesChange(databases.filter((_, i) => i !== index));
	};

	const updateDatabase = (index: number, field: keyof DatabaseEntry, value: any) => {
		const updated = [...databases];
		updated[index] = { ...updated[index], [field]: value };
		onDatabasesChange(updated);
	};

	const estimateCost = (db: DatabaseEntry) => {
		return (db.min_capacity * 0.12 * 730).toFixed(0);
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Database className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Databases</CardTitle>
					</div>
					<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addDatabase}>
						<Plus className="h-3.5 w-3.5 mr-1.5" />
						Add Database
					</Button>
				</div>
				<CardDescription className="text-xs">
					Aurora Serverless v2 PostgreSQL. Add multiple databases for different services.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{databases.length === 0 ? (
					<div className="text-center py-8 text-muted-foreground">
						<Database className="h-8 w-8 mx-auto mb-2 opacity-20" />
						<p className="text-sm">No databases configured.</p>
						<p className="text-[11px] mt-1">Click "Add Database" to include an Aurora cluster.</p>
					</div>
				) : (
					databases.map((db, i) => (
						<div key={i} className="p-4 border border-border/50 rounded-lg space-y-3">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium">{db.name || "Unnamed"}</span>
									<span className="text-[11px] text-muted-foreground">
										~${estimateCost(db)}/mo
									</span>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-7 w-7 text-muted-foreground hover:text-destructive"
									onClick={() => removeDatabase(i)}
								>
									<Trash2 className="h-3.5 w-3.5" />
								</Button>
							</div>

							<div className="grid md:grid-cols-4 gap-3">
								<div className="space-y-1">
									<Label className="text-[11px]">Name</Label>
									<Input
										value={db.name}
										onChange={(e) => updateDatabase(i, "name", e.target.value)}
										className="h-8 text-xs"
										placeholder="primary"
									/>
								</div>
								<div className="space-y-1">
									<Label className="text-[11px]">Engine</Label>
									<Select value={db.engine} onValueChange={(v) => updateDatabase(i, "engine", v)}>
										<SelectTrigger className="h-8 text-xs">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="aurora-postgresql">Aurora PostgreSQL</SelectItem>
											<SelectItem value="aurora-mysql">Aurora MySQL</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-1">
									<Label className="text-[11px]">Min ACU</Label>
									<Input
										type="number"
										min={0.5}
										max={128}
										step={0.5}
										value={db.min_capacity}
										onChange={(e) => updateDatabase(i, "min_capacity", parseFloat(e.target.value) || 0.5)}
										className="h-8 text-xs"
									/>
								</div>
								<div className="space-y-1">
									<Label className="text-[11px]">Max ACU</Label>
									<Input
										type="number"
										min={0.5}
										max={128}
										step={0.5}
										value={db.max_capacity}
										onChange={(e) => updateDatabase(i, "max_capacity", parseFloat(e.target.value) || 4)}
										className="h-8 text-xs"
									/>
								</div>
							</div>

							<div className="flex items-center justify-between p-2 bg-muted/20 rounded">
								<span className="text-[11px] text-muted-foreground">IAM Authentication</span>
								<Switch
									checked={db.iam_auth}
									onCheckedChange={(v) => updateDatabase(i, "iam_auth", v)}
								/>
							</div>
						</div>
					))
				)}
			</CardContent>
		</Card>
	);
}
