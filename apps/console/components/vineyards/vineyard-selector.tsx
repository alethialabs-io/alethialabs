"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { createVineyard, getVineyards } from "@/app/server/actions/vineyards";
import type { Zone } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, Loader2, Map, Plus } from "lucide-react";
import { useEffect, useState } from "react";

interface VineyardSelectorProps {
	value?: string;
	onChange: (value: string) => void;
}

export function VineyardSelector({ value, onChange }: VineyardSelectorProps) {
	const [vineyards, setVineyards] = useState<Zone[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isCreating, setIsCreating] = useState(false);
	const [_error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");

	useEffect(() => {
		const fetchVineyards = async () => {
			try {
				const { vineyards } = await getVineyards();
				setVineyards(vineyards || []);

				// Auto-select if there is only one vineyard and no value is selected
				if (vineyards && vineyards.length === 1 && !value) {
					onChange(vineyards[0].id);
				}
			} catch (err) {
				console.error("Failed to load vineyards:", err);
			} finally {
				setIsLoading(false);
			}
		};

		fetchVineyards();
	}, [value, onChange]);

	const handleCreate = async (nameToCreate: string) => {
		if (!nameToCreate.trim()) return;

		setIsCreating(true);
		setError(null);
		try {
			const { vineyard } = await createVineyard({
				name: nameToCreate.trim(),
				description: "Created via Configuration Wizard",
			});

			setVineyards((prev) => [vineyard, ...prev]);
			onChange(vineyard.id);
			setSearchQuery("");
			setOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create zone");
		} finally {
			setIsCreating(false);
		}
	};

	if (isLoading) {
		return (
			<div className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm opacity-50">
				<div className="flex items-center gap-2 text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					Loading zones...
				</div>
			</div>
		);
	}

	const selectedVineyard = vineyards.find((v) => v.id === value);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					role="combobox"
					aria-expanded={open}
					className={cn(
						"w-full justify-between font-normal bg-background h-9 border-border/50",
						!value && "text-muted-foreground",
					)}
				>
					<div className="flex items-center gap-2 truncate">
						<Map className="h-4 w-4 shrink-0 opacity-50" />
						{value && selectedVineyard
							? selectedVineyard.name
							: "Select a zone"}
					</div>
					<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[400px] p-0" align="start">
				<Command>
					<CommandInput
						placeholder="Search zones..."
						value={searchQuery}
						onValueChange={setSearchQuery}
					/>
					<CommandList>
						<CommandEmpty className="py-2 text-center text-sm">
							<p className="text-muted-foreground mb-2">No zone found.</p>
							{searchQuery.trim() && (
								<Button
									variant="outline"
									size="sm"
									className="h-8 text-xs w-[calc(100%-16px)]"
									onClick={() => handleCreate(searchQuery)}
									disabled={isCreating}
								>
									{isCreating ? (
										<Loader2 className="mr-2 h-3 w-3 animate-spin" />
									) : (
										<Plus className="mr-2 h-3 w-3" />
									)}
									Create &quot;{searchQuery.trim()}&quot;
								</Button>
							)}
						</CommandEmpty>
						<CommandGroup>
							{vineyards.map((v) => (
								<CommandItem
									key={v.id}
									value={v.name}
									onSelect={() => {
										onChange(v.id);
										setOpen(false);
									}}
								>
									<Check
										className={cn(
											"mr-2 h-4 w-4",
											value === v.id
												? "opacity-100"
												: "opacity-0",
										)}
									/>
									{v.name}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
