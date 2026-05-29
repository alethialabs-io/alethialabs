"use client";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

interface CidrTagInputProps {
	value: string[];
	onChange: (cidrs: string[]) => void;
	placeholder?: string;
}

const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export function CidrTagInput({
	value,
	onChange,
	placeholder = "e.g. 10.0.0.0/16",
}: CidrTagInputProps) {
	const [input, setInput] = useState("");
	const [error, setError] = useState("");

	const addCidr = (cidr: string) => {
		const trimmed = cidr.trim();
		if (!trimmed) return;
		if (!CIDR_REGEX.test(trimmed)) {
			setError("Invalid CIDR format");
			return;
		}
		if (value.includes(trimmed)) {
			setError("Already added");
			return;
		}
		setError("");
		onChange([...value, trimmed]);
		setInput("");
	};

	const removeCidr = (cidr: string) => {
		onChange(value.filter((c) => c !== cidr));
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault();
			addCidr(input);
		}
		if (e.key === "Backspace" && !input && value.length > 0) {
			onChange(value.slice(0, -1));
		}
	};

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-1.5 min-h-[28px]">
				{value.map((cidr) => (
					<Badge
						key={cidr}
						variant="secondary"
						className="text-xs font-mono gap-1 pr-1"
					>
						{cidr}
						<button
							type="button"
							onClick={() => removeCidr(cidr)}
							className="ml-0.5 hover:text-destructive"
						>
							<X className="h-3 w-3" />
						</button>
					</Badge>
				))}
			</div>
			<Input
				value={input}
				onChange={(e) => {
					setInput(e.target.value);
					setError("");
				}}
				onKeyDown={handleKeyDown}
				onBlur={() => input && addCidr(input)}
				placeholder={placeholder}
				className="h-8 text-sm font-mono"
			/>
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}

export function serializeCidrTags(cidrs: string[]): string {
	return cidrs.join(",");
}

export function parseCidrTags(value: string): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean);
}
