"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector on a DESCRIBED chart workload (W5 Path A — Option B).
//
// It is deliberately READ-MOSTLY, which is what keeps it distinct from the first-class `service`
// subject (the two-model invariant). The `rendered` description — image, kind, ports, env KEY
// NAMES, resources, replicas — comes straight from `helm template` and is OVERWRITTEN on every
// re-scan, so it is the Status view and nothing in it is editable: editing it would be editing the
// chart. What the person CAN edit is the overlay the chart's own `values` do not already pin: the
// W3 bindings (the exact service binding editor), `replicas` and `env`, and the value-path
// override that says where each knob writes into the chart's values.
//
// The overlay is STAGED, not saved (#6834). This panel used to hold a `useState` draft and its own
// Save button — the one config surface on the rail that did not go through the changes bar, and
// one a click on the empty board discarded. An edit now becomes a staged operation in the document
// when the field is left, when a row is removed or a binding changes, and when the panel goes
// away; the operation runs `saveChartWorkloadOverlayAction` when it is applied.

import { Package, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { SectionHeading } from "@repo/ui/section-heading";
import { useByoChartCanvas } from "@/components/design-project/byo/byo-chart-canvas-context";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import type { InspectorTab } from "@/lib/canvas/store/types";
import { useInspectorTab, useOperations } from "@/lib/canvas/store/use-board";
import { serviceBindingSchema } from "@/lib/validations/project-form.schema";
import type { ChartValuePathMap, ChartWorkloadConfig } from "@/types/jsonb.types";
import { type CanvasNode, nodeOfKind } from "../graph/types";
import { InspectorFrame } from "../inspector-shell/inspector-frame";
import {
	workloadOperationId,
	workloadOverlayInputSchema,
	type WorkloadOverlayInput,
} from "../inspector-shell/staged-operations";
import { resolveTab, useCloseInspector, useSubjectNode } from "../inspector-shell/subject";
import { BindingsField } from "./bindings-field";

/** The overlay as the form holds it: rows where the stored shape has a map, text where it has a number. */
const overlayFormSchema = z.object({
	bindings: z.array(serviceBindingSchema),
	replicas: z.string().regex(/^\d*$/, "Replicas is a whole number, 0 or more."),
	env: z.array(z.object({ name: z.string(), value: z.string() })),
	valuePaths: z.array(z.object({ key: z.string(), path: z.string() })),
});
type OverlayForm = z.infer<typeof overlayFormSchema>;

/** The user-editable overlay of one workload, in the shape it is stored and sent. */
interface Overlay {
	bindings: OverlayForm["bindings"];
	config: ChartWorkloadConfig;
	valuePaths: ChartValuePathMap;
}

const TABS: readonly InspectorTab[] = ["configure", "status"];

/** The workload's saved overlay. */
function overlayOf(config: CanvasNode<"chart_workload">["data"]["config"]): Overlay {
	return {
		bindings: config.bindings ?? [],
		config: config.config ?? {},
		valuePaths: config.valuePaths ?? {},
	};
}

/** An overlay with what is already staged for it laid over what is saved. */
function withStaged(base: Overlay, staged: WorkloadOverlayInput | null): Overlay {
	if (!staged) return base;
	return {
		bindings: staged.bindings ?? base.bindings,
		config: staged.config ?? base.config,
		valuePaths: staged.valuePaths ?? base.valuePaths,
	};
}

/** An overlay as form values. */
function toForm(overlay: Overlay): OverlayForm {
	return {
		bindings: overlay.bindings,
		replicas: overlay.config.replicas === undefined ? "" : String(overlay.config.replicas),
		env: overlay.config.env ?? [],
		valuePaths: Object.entries(overlay.valuePaths).map(([key, path]) => ({ key, path })),
	};
}

/**
 * Valid form values as an overlay. A row with no name is not written: it is a row the person has
 * not filled in yet, not an instruction to store an unnamed variable. An overlay that had no `env`
 * and still has no rows keeps no `env`, so an untouched form equals what is saved.
 */
function fromForm(values: OverlayForm, base: Overlay): Overlay {
	const env = values.env.filter((row) => row.name.trim() !== "");
	const config: ChartWorkloadConfig = {};
	if (values.replicas !== "") config.replicas = Number(values.replicas);
	if (env.length > 0 || base.config.env !== undefined) config.env = env;
	return {
		bindings: values.bindings,
		config,
		valuePaths: Object.fromEntries(
			values.valuePaths.filter((row) => row.key.trim() !== "").map((row) => [row.key, row.path]),
		),
	};
}

/** True when two values are the same JSON. */
function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The parts of `next` that differ from `base`, named as the overlay action names them. */
function changedParts(
	base: Overlay,
	next: Overlay,
): Pick<WorkloadOverlayInput, "bindings" | "config" | "valuePaths"> {
	return {
		...(same(next.bindings, base.bindings) ? {} : { bindings: next.bindings }),
		...(same(next.config, base.config) ? {} : { config: next.config }),
		...(same(next.valuePaths, base.valuePaths) ? {} : { valuePaths: next.valuePaths }),
	};
}

/** What a staged overlay changes, in words, for the review list. */
function summaryOf(name: string, parts: ReturnType<typeof changedParts>): string {
	const named = [
		parts.bindings ? "bindings" : null,
		parts.config ? "replicas and env" : null,
		parts.valuePaths ? "value paths" : null,
	].filter((part) => part !== null);
	return `Chart workload ${name}: ${named.join(", ")}`;
}

/** The inspector on one described chart workload. Draws nothing for an id that names none. */
export function ChartWorkloadPanel({ nodeId }: { nodeId: string }) {
	const node = nodeOfKind(useSubjectNode(nodeId), "chart_workload");
	if (!node) return null;
	return <WorkloadSubject node={node} />;
}

/** The subject itself, mounted only once its node is known so the form seeds from real values. */
function WorkloadSubject({ node }: { node: CanvasNode<"chart_workload"> }) {
	const board = useBoard();
	const close = useCloseInspector();
	const ctx = useByoChartCanvas();
	const requested = useInspectorTab();
	const tab = resolveTab(requested, TABS);
	const config = node.data.config;
	const rendered = config.rendered;
	const operationId = workloadOperationId(config.id);
	const operation = useOperations().find((o) => o.id === operationId) ?? null;
	const stagedInput = operation ? workloadOverlayInputSchema.safeParse(operation.input) : null;
	const staged = stagedInput?.success ? stagedInput.data : null;

	const base = overlayOf(config);
	// Seeded once: the component is keyed on its subject, and a background re-scan that refreshes
	// the node must not replace what is being typed.
	const form = useForm<OverlayForm>({ defaultValues: toForm(withStaged(base, staged)) });
	const env = useFieldArray({ control: form.control, name: "env" });
	const paths = useFieldArray({ control: form.control, name: "valuePaths" });
	const values = useWatch({ control: form.control });
	const bindings = useWatch({ control: form.control, name: "bindings" });
	const checked = overlayFormSchema.safeParse(values);
	const issue = checked.success ? null : (checked.error.issues[0] ?? null);
	const replicasIssue = issue?.path[0] === "replicas" ? issue.message : null;
	const bindingsIssue = issue?.path[0] === "bindings" ? issue.message : null;

	/** Stage the overlay as it stands, or take it off the changeset when it equals what is saved. */
	const commit = useCallback(() => {
		if (!ctx) return;
		const parsed = overlayFormSchema.safeParse(form.getValues());
		// An overlay that does not validate is not staged; the field says why.
		if (!parsed.success) return;
		const saved = overlayOf(node.data.config);
		const parts = changedParts(saved, fromForm(parsed.data, saved));
		const document = board.document.getState();
		const current = document.operations.find((o) => o.id === operationId);
		if (Object.keys(parts).length === 0) {
			document.unstageOperation(operationId);
			return;
		}
		const input: WorkloadOverlayInput = {
			projectId: ctx.projectId,
			workloadId: node.data.config.id,
			...parts,
		};
		// Staging is an undo step; staging what is already staged would be an empty one.
		if (current && same(current.input, input)) return;
		document.stageOperation({
			id: operationId,
			target: "chart-workload",
			verb: "overlay",
			targetId: node.data.config.id,
			summary: summaryOf(node.data.config.name, parts),
			input,
		});
	}, [board, ctx, form, node, operationId]);

	// A panel that goes away — another card is selected, the board is clicked, Escape — commits
	// what it holds. The ref keeps the cleanup on the latest `commit` without re-running it.
	const latestCommit = useRef(commit);
	useEffect(() => {
		latestCommit.current = commit;
	}, [commit]);
	useEffect(() => () => latestCommit.current(), []);

	/** Put the form back to what is saved and take the overlay off the changeset. */
	const discard = () => {
		form.reset(toForm(base));
		board.document.getState().unstageOperation(operationId);
	};

	const readOnly = !ctx;

	return (
		<InspectorFrame
			icon={<Package className="h-4 w-4" />}
			external
			eyebrow="Chart workload"
			title={config.name}
			summary={
				<span className="font-mono">
					{config.kind} · {config.chartId}
				</span>
			}
			tabs={TABS}
			tab={tab}
			onTabChange={(next) => board.view.getState().setTab(next)}
			notice={
				readOnly ? (
					"Read-only: this board has no project to stage the overlay for."
				) : operation ? (
					<span className="flex items-center justify-between gap-3">
						<span>
							Overlay staged. It is written to the chart&apos;s values when you apply your
							changes.
						</span>
						<Button type="button" variant="ghost" size="xs" onClick={discard}>
							Discard
						</Button>
					</span>
				) : undefined
			}
			onClose={close}
		>
			{tab === "status" ? (
				<section className="space-y-3 text-sm">
					<SectionHeading
						level={3}
						title="Described from the chart"
						description={
							<>
								Read-only: extracted from <span className="font-mono">helm template</span> and
								refreshed on every scan. The chart stays the deploy unit; these rows only
								describe what it runs.
							</>
						}
					/>
					<dl className="space-y-1.5 border border-border bg-surface-sunken px-3 py-2.5 text-xs">
						<DescribedRow label="Image" value={rendered.image || "—"} />
						<DescribedRow label="Kind" value={config.kind} />
						<DescribedRow
							label="Replicas"
							value={rendered.replicas != null ? String(rendered.replicas) : "—"}
						/>
						{rendered.ports.length > 0 && (
							<DescribedRow
								label="Ports"
								value={rendered.ports
									.map((p) => `${p.container_port}${p.protocol ? `/${p.protocol}` : ""}`)
									.join(" · ")}
							/>
						)}
						{rendered.resources && (
							<DescribedRow
								label="Resources"
								value={`${rendered.resources.requests.cpu}/${rendered.resources.requests.memory} → ${rendered.resources.limits.cpu}/${rendered.resources.limits.memory}`}
							/>
						)}
					</dl>
					{rendered.env_keys.length > 0 && (
						<div className="space-y-1">
							<span className="vx-eyebrow text-ui-3xs">Rendered env · keys only</span>
							<div className="flex flex-wrap gap-1">
								{rendered.env_keys.map((k) => (
									<span
										key={k}
										className="border border-border px-1.5 py-0.5 font-mono text-ui-2xs text-muted-foreground"
									>
										{k}
									</span>
								))}
							</div>
						</div>
					)}
				</section>
			) : (
				<form
					className="space-y-5 text-sm"
					onBlur={commit}
					onSubmit={(e) => {
						e.preventDefault();
						commit();
					}}
				>
					<fieldset disabled={readOnly} className="space-y-5">
						{/* Bindings: the W3 editor, reused as it is. */}
						<section className="space-y-2">
							<SectionHeading level={3} title="Bindings" />
							<BindingsField
								value={bindings}
								onChange={(next) => {
									form.setValue("bindings", next, { shouldDirty: true });
									commit();
								}}
								// The BYO chart lane resolves the `database` facet (a per-binding MySQL user's
								// own database); the service lane does not, so only this panel offers it (#6467).
								allowDatabaseFacet
							/>
							{bindingsIssue && (
								<p className="text-xs font-medium text-foreground">{bindingsIssue}</p>
							)}
						</section>

						{/* Replicas and env: written into the chart's values on deploy. */}
						<section className="space-y-2">
							<SectionHeading level={3} title="Overrides" />
							<div className="space-y-1">
								<span className="vx-eyebrow text-ui-3xs">Replicas</span>
								<Input
									aria-label="Replicas"
									type="number"
									min={0}
									placeholder={rendered.replicas != null ? String(rendered.replicas) : "from chart"}
									aria-invalid={replicasIssue ? true : undefined}
									className="h-8 w-28 font-mono text-xs"
									{...form.register("replicas")}
								/>
								{replicasIssue && (
									<p className="text-xs font-medium text-foreground">{replicasIssue}</p>
								)}
							</div>
							<div className="space-y-1.5">
								<span className="vx-eyebrow text-ui-3xs">Env</span>
								{env.fields.map((row, i) => (
									<div key={row.id} className="flex items-center gap-1.5">
										<Input
											aria-label="Environment variable name"
											placeholder="NAME"
											className="h-8 flex-1 font-mono text-xs"
											{...form.register(`env.${i}.name`)}
										/>
										<Input
											aria-label="Environment variable value"
											placeholder="value"
											className="h-8 flex-1 font-mono text-xs"
											{...form.register(`env.${i}.value`)}
										/>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
											aria-label="Remove env var"
											onClick={() => {
												env.remove(i);
												queueMicrotask(commit);
											}}
										>
											<X className="h-3.5 w-3.5" />
										</Button>
									</div>
								))}
								<AddRowButton label="Add env var" onClick={() => env.append({ name: "", value: "" })} />
							</div>
						</section>

						{/* Where each knob writes into the chart's Helm values. Inferred at scan; this is
						    the manual override. */}
						<section className="space-y-2">
							<SectionHeading
								level={3}
								title="Value paths"
								description={
									<>
										Where a knob writes into the chart&rsquo;s values (for example{" "}
										<span className="font-mono text-foreground">replicas → replicaCount</span>).
										Inferred on scan; override here when the chart&rsquo;s shape is non-standard.
									</>
								}
							/>
							<div className="space-y-1.5">
								{paths.fields.map((row, i) => (
									<div key={row.id} className="flex items-center gap-1.5">
										<Input
											aria-label="Knob"
											placeholder="knob"
											className="h-8 flex-1 font-mono text-xs"
											{...form.register(`valuePaths.${i}.key`)}
										/>
										<span className="shrink-0 font-mono text-xs text-muted-foreground">→</span>
										<Input
											aria-label="Values path"
											placeholder="dot.path.in.values"
											className="h-8 flex-1 font-mono text-xs"
											{...form.register(`valuePaths.${i}.path`)}
										/>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
											aria-label="Remove value path"
											onClick={() => {
												paths.remove(i);
												queueMicrotask(commit);
											}}
										>
											<X className="h-3.5 w-3.5" />
										</Button>
									</div>
								))}
								<AddRowButton
									label="Add value path"
									onClick={() => paths.append({ key: "", path: "" })}
								/>
							</div>
						</section>
					</fieldset>
				</form>
			)}
		</InspectorFrame>
	);
}

/** One row of the read-only description. */
function DescribedRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-3">
			<dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
			<dd className="min-w-0 truncate font-mono" title={value}>
				{value}
			</dd>
		</div>
	);
}

/** The dashed "add a row" control under a list of rows. */
function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center gap-1.5 rounded-sm border border-dashed border-border-strong px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
		>
			<Plus className="h-3.5 w-3.5" aria-hidden="true" />
			{label}
		</button>
	);
}
