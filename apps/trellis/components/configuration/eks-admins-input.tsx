"use client";

import {
	getEksAdmins,
	createEksAdmin,
	type EksAdminOption,
} from "@/app/server/actions/eks-admins";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Plus, User, X } from "lucide-react";
import { useEffect, useState } from "react";

export type EksAdmin = { username: string; path: string };

interface EksAdminsInputProps {
	value: EksAdmin[];
	onChange: (admins: EksAdmin[]) => void;
}

export function EksAdminsInput({ value, onChange }: EksAdminsInputProps) {
	const [savedAdmins, setSavedAdmins] = useState<EksAdminOption[]>([]);
	const [openIndex, setOpenIndex] = useState<number | null>(null);
	const [searchValue, setSearchValue] = useState("");

	useEffect(() => {
		getEksAdmins().then(setSavedAdmins);
	}, []);

	const addAdmin = (email: string) => {
		if (!email || value.some((a) => a.username === email)) return;
		onChange([...value, { username: email, path: "/" }]);

		createEksAdmin(email).then((admin) => {
			if (admin && !savedAdmins.some((a) => a.email === admin.email)) {
				setSavedAdmins((prev) => [...prev, admin]);
			}
		});
	};

	const removeAdmin = (index: number) => {
		onChange(value.filter((_, i) => i !== index));
	};

	const availableAdmins = savedAdmins.filter(
		(saved) => !value.some((v) => v.username === saved.email),
	);

	return (
		<div className="space-y-2">
			{value.map((admin, i) => (
				<div
					key={i}
					className="flex items-center gap-2 p-2 rounded-md border border-border/40 bg-background"
				>
					<User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
					<span className="text-sm flex-1 truncate">
						{admin.username}
					</span>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
						onClick={() => removeAdmin(i)}
					>
						<X className="h-3 w-3" />
					</Button>
				</div>
			))}

			<Popover
				open={openIndex !== null}
				onOpenChange={(open) => {
					if (!open) {
						setOpenIndex(null);
						setSearchValue("");
					}
				}}
			>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-7 text-xs"
						onClick={() => setOpenIndex(value.length)}
					>
						<Plus className="h-3 w-3 mr-1" />
						Add Admin
					</Button>
				</PopoverTrigger>
				<PopoverContent className="p-0 w-72" align="start">
					<Command>
						<CommandInput
							placeholder="Search or type email..."
							value={searchValue}
							onValueChange={setSearchValue}
						/>
						<CommandList>
							<CommandEmpty>
								{searchValue.includes("@") ? (
									<button
										type="button"
										className="w-full p-2 text-left text-sm hover:bg-muted/50"
										onClick={() => {
											addAdmin(searchValue);
											setOpenIndex(null);
											setSearchValue("");
										}}
									>
										Add &quot;{searchValue}&quot;
									</button>
								) : (
									<span className="text-xs text-muted-foreground p-2">
										Type an email address
									</span>
								)}
							</CommandEmpty>
							{availableAdmins.length > 0 && (
								<CommandGroup heading="Previously used">
									{availableAdmins.map((admin) => (
										<CommandItem
											key={admin.id}
											value={admin.email}
											onSelect={() => {
												addAdmin(admin.email);
												setOpenIndex(null);
												setSearchValue("");
											}}
										>
											<User className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
											{admin.email}
										</CommandItem>
									))}
								</CommandGroup>
							)}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</div>
	);
}

export function serializeEksAdmins(admins: EksAdmin[]): string {
	const valid = admins.filter((a) => a.username);
	if (valid.length === 0) return "";
	const lines = valid.map(
		(a) =>
			`  - username: "${a.username}"\n    path: ${a.path || "/"}`,
	);
	return `eks_cluster_admins:\n${lines.join("\n")}`;
}

export function parseEksAdmins(yaml: string): EksAdmin[] {
	if (!yaml) return [];
	const matches = [
		...yaml.matchAll(/username:\s*"?([^"\n]+)"?\s*\n\s*path:\s*(\S+)/g),
	];
	return matches.map((m) => ({ username: m[1].trim(), path: m[2].trim() }));
}
