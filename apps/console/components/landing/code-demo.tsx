"use client";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { ProviderIcon } from "@/components/provider-icon";
import { useState } from "react";

interface CodeLine {
	text: string;
	color?: "green" | "blue" | "yellow" | "muted" | "white";
}

interface OutputLine {
	text: string;
	color?: "green" | "blue" | "muted" | "yellow" | "white";
}

interface DemoTab {
	id: string;
	label: string;
	code: CodeLine[];
	output: OutputLine[];
}

interface Provider {
	id: string;
	name: string;
}

interface CodeDemoProps {
	tabs: DemoTab[];
	providers?: Provider[];
	onProviderChange?: (providerId: string) => void;
	activeProvider?: string;
}

function colorClass(color?: string, isCode?: boolean) {
	switch (color) {
		case "green":
			return "text-foreground";
		case "blue":
			return "text-muted-foreground";
		case "yellow":
			return "text-foreground/70";
		case "muted":
			return isCode ? "text-white/30" : "text-white/40";
		default:
			return isCode ? "text-white/90" : "text-white/70";
	}
}

export function CodeDemo({
	tabs,
	providers,
	onProviderChange,
	activeProvider,
}: CodeDemoProps) {
	const [activeTab, setActiveTab] = useState(tabs[0]?.id ?? "");

	const current = tabs.find((t) => t.id === activeTab) ?? tabs[0];
	if (!current) return null;

	return (
		<div className="rounded-xl border border-white/10 bg-neutral-950 overflow-hidden shadow-2xl">
			{/* Provider selector */}
			{providers && providers.length > 0 && (
				<div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5">
					<span className="text-xs text-white/30">Provider:</span>
					<div className="flex items-center gap-1">
						{providers.map((p) => (
							<button
								key={p.id}
								onClick={() => onProviderChange?.(p.id)}
								className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
									activeProvider === p.id
										? "bg-white/10 text-white"
										: "text-white/40 hover:text-white/70"
								}`}
							>
								<ProviderIcon provider={p.id} size={14} />
								{p.name}
							</button>
						))}
					</div>
				</div>
			)}

			{/* Tab bar */}
			<div className="flex items-center gap-0 border-b border-white/5 px-1 overflow-x-auto">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						onClick={() => setActiveTab(tab.id)}
						className={`shrink-0 px-3 py-2 text-xs font-medium transition-colors border-b-2 ${
							activeTab === tab.id
								? "border-white/80 text-white"
								: "border-transparent text-white/40 hover:text-white/60"
						}`}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Two-pane content */}
			<div className="grid md:grid-cols-2 divide-x divide-white/5 min-h-[280px]">
				{/* Left: code */}
				<div className="p-4 font-mono text-[13px] leading-relaxed overflow-x-auto">
					<div className="flex gap-3">
						<div className="select-none text-right text-white/15 w-5 shrink-0">
							{current.code.map((_, i) => (
								<div key={i}>{i + 1}</div>
							))}
						</div>
						<div className="flex-1 min-w-0">
							{current.code.map((line, i) => (
								<div
									key={i}
									className={colorClass(line.color, true)}
								>
									{line.text || " "}
								</div>
							))}
						</div>
					</div>
				</div>

				{/* Right: output */}
				<div className="p-4 font-mono text-[13px] leading-relaxed bg-white/[0.02] overflow-x-auto">
					<div className="text-white/20 text-xs mb-2 uppercase tracking-wider">
						Output
					</div>
					{current.output.map((line, i) => (
						<div key={i} className={colorClass(line.color, false)}>
							{line.text || " "}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
