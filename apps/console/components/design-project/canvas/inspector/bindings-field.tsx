"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import { ArrowRight, Plus, X } from "lucide-react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { configName } from "../graph/node-config";
import type { NodeKind } from "../graph/types";

/**
 * A service→backing-infra binding. A service declares which resources it needs and which environment
 * variables each connection injects; the runner resolves them at deploy — non-secret facets
 * (endpoint/port) as templated values, credential facets as a Kubernetes `secretKeyRef`. The shape
 * mirrors `serviceBindingSchema` (lib/validations/project-form.schema.ts) exactly.
 */
const BINDING_TARGET_KINDS = ["database", "cache", "queue", "secret"] as const;
export type BindingTargetKind = (typeof BINDING_TARGET_KINDS)[number];
export type BindingFrom =
	| "endpoint"
	| "port"
	| "username"
	| "password"
	| "connection_string";
export interface ServiceBinding {
	target: { kind: BindingTargetKind; name: string };
	inject: { env: string; from: BindingFrom }[];
}

const TARGET_KINDS: { value: BindingTargetKind; label: string }[] = [
	{ value: "database", label: "Database" },
	{ value: "cache", label: "Cache" },
	{ value: "queue", label: "Queue" },
	{ value: "secret", label: "Secret" },
];

/** Which facets are credentials — delivered as a secretKeyRef, never written into the manifest. */
const FROM_FACETS: { value: BindingFrom; label: string; secret: boolean }[] = [
	{ value: "endpoint", label: "endpoint", secret: false },
	{ value: "port", label: "port", secret: false },
	{ value: "username", label: "username", secret: true },
	{ value: "password", label: "password", secret: true },
	{ value: "connection_string", label: "connection string", secret: true },
];

const isSecretFacet = (from: BindingFrom): boolean =>
	FROM_FACETS.find((f) => f.value === from)?.secret ?? false;

/**
 * The Bindings editor — a service's edges to the infrastructure it depends on. Each row picks a
 * backing resource (by kind + a real node on the canvas) and lists the env vars its connection
 * injects. Unlike the generic subresource row editor, a binding nests a variable-length `inject[]`,
 * so it gets its own field type.
 */
export function BindingsField({
	value,
	onChange,
}: {
	value: ServiceBinding[];
	onChange: (next: ServiceBinding[]) => void;
}) {
	const nodes = useCanvasStore((s) => s.nodes);
	const bindings = value ?? [];

	/** Canvas resources of a given kind, as target-name options. */
	const namesForKind = (kind: BindingTargetKind): string[] =>
		nodes
			.filter((n) => n.data.kind === kind)
			.map((n) => configName(n.data))
			.filter((name): name is string => !!name);

	const patchBinding = (index: number, next: ServiceBinding) =>
		onChange(bindings.map((b, i) => (i === index ? next : b)));
	const removeBinding = (index: number) =>
		onChange(bindings.filter((_, i) => i !== index));
	const addBinding = () =>
		onChange([
			...bindings,
			{ target: { kind: "database", name: "" }, inject: [] },
		]);

	return (
		<div className="space-y-2">
			{bindings.map((binding, bi) => {
				const names = namesForKind(binding.target.kind);
				return (
					// Bindings are positional — the array index is their identity.
					// eslint-disable-next-line react/no-array-index-key
					<div key={bi} className="space-y-2.5 border border-border bg-surface-sunken p-2.5">
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate font-mono text-xs">
								{binding.target.name
									? `${binding.target.kind} · ${binding.target.name}`
									: `Bind a ${binding.target.kind}`}
							</span>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
								aria-label="Remove binding"
								onClick={() => removeBinding(bi)}
							>
								<X className="h-3.5 w-3.5" />
							</Button>
						</div>

						<div className="grid grid-cols-2 gap-2">
							<div className="space-y-1">
								<span className="vx-eyebrow text-[9px]">Target kind</span>
								<Select
									value={binding.target.kind}
									onValueChange={(v) =>
										patchBinding(bi, {
											...binding,
											// Changing kind clears the name — it referenced a resource of the old kind.
											target: { kind: coerceEnum(v, BINDING_TARGET_KINDS, "database"), name: "" },
										})
									}
								>
									<SelectTrigger className="h-8 text-xs">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{TARGET_KINDS.map((k) => (
											<SelectItem key={k.value} value={k.value}>
												{k.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<span className="vx-eyebrow text-[9px]">Resource</span>
								{names.length > 0 ? (
									<Select
										value={binding.target.name || ""}
										onValueChange={(v) =>
											patchBinding(bi, { ...binding, target: { ...binding.target, name: v } })
										}
									>
										<SelectTrigger className="h-8 text-xs">
											<SelectValue placeholder="Choose one" />
										</SelectTrigger>
										<SelectContent>
											{names.map((name) => (
												<SelectItem key={name} value={name}>
													{name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : (
									// No resource of this kind on the canvas yet — let them type the name it will have.
									<Input
										value={binding.target.name}
										placeholder={`no ${binding.target.kind} on canvas`}
										className="h-8 font-mono text-xs"
										onChange={(e) =>
											patchBinding(bi, {
												...binding,
												target: { ...binding.target, name: e.target.value },
											})
										}
									/>
								)}
							</div>
						</div>

						<div className="space-y-1.5">
							<span className="vx-eyebrow text-[9px]">Inject</span>
							{binding.inject.map((inj, ii) => (
								// Injections are positional too.
								// eslint-disable-next-line react/no-array-index-key
								<div key={ii} className="flex items-center gap-1.5">
									<Input
										value={inj.env}
										placeholder="ENV_VAR"
										className="h-8 flex-1 font-mono text-xs"
										onChange={(e) =>
											patchBinding(bi, {
												...binding,
												inject: binding.inject.map((x, j) =>
													j === ii ? { ...x, env: e.target.value } : x,
												),
											})
										}
									/>
									<ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									<Select
										value={inj.from}
										onValueChange={(v) =>
											patchBinding(bi, {
												...binding,
												inject: binding.inject.map((x, j) =>
													j === ii ? { ...x, from: coerceEnum(v, FROM_FACETS.map((ff) => ff.value), FROM_FACETS[0].value) } : x,
												),
											})
										}
									>
										<SelectTrigger className="h-8 w-[44%] text-xs">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{FROM_FACETS.map((f) => (
												<SelectItem key={f.value} value={f.value}>
													{f.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									{isSecretFacet(inj.from) && (
										<span className="shrink-0 rounded-sm border border-border px-1 font-mono text-[8px] uppercase tracking-wide text-muted-foreground">
											secret
										</span>
									)}
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
										aria-label="Remove injection"
										onClick={() =>
											patchBinding(bi, {
												...binding,
												inject: binding.inject.filter((_, j) => j !== ii),
											})
										}
									>
										<X className="h-3.5 w-3.5" />
									</Button>
								</div>
							))}
							<button
								type="button"
								className="flex items-center gap-1.5 rounded-sm border border-dashed border-border-strong px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
								onClick={() =>
									patchBinding(bi, {
										...binding,
										inject: [...binding.inject, { env: "", from: "endpoint" }],
									})
								}
							>
								<Plus className="h-3.5 w-3.5" />
								Inject a value
							</button>
						</div>
					</div>
				);
			})}

			<button
				type="button"
				onClick={addBinding}
				className="flex w-full items-center gap-1.5 border border-border px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				<Plus className="h-3.5 w-3.5" />
				Bind a resource
			</button>

			<p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
				Alethia injects the endpoint and credentials at deploy — keyless, via ExternalSecret. A
				secret facet becomes a Kubernetes secretKeyRef, never written into the manifest.
			</p>
		</div>
	);
}
