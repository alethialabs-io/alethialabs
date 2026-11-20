"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector on one cluster add-on, opened from the Architecture canvas's Add palette or from
// the add-on's card on the board. It renders the add-on's schema'd knobs, a delivery-mode selector
// (Managed apply vs GitOps into the customer's apps repo), the chart-version pin and an Advanced
// raw Helm-values (YAML) override.
//
// An install or a reconfigure is STAGED, not saved (#6834). This card used to end in its own
// "Enable add-on" / "Save changes" button that wrote to the server at once, beside node cards whose
// edits went to a draft another bar saved — and a click on the empty board threw away whatever was
// half-typed here. An edit now becomes a staged operation in the document when a field is left,
// when a select or a switch changes, and when the card goes away; it is listed with the design
// changes and runs `enableAddonAction` when the changeset is applied. The knobs mirror the server's
// schema (re-validated there); the YAML is validated when the operation runs.
//
// REMOVING an add-on is not staged. It is a confirmed, immediate action: the chart is uninstalled
// on the next deploy and its configuration is not kept, so it asks first and says so.
//
// It is one subject of the one inspector: it draws inside `InspectorFrame`, so its name, its
// state, its one action and its messages sit where every other subject's do.

import { ChevronsUpDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { SectionHeading } from "@repo/ui/section-heading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/select";
import { Skeleton } from "@repo/ui/skeleton";
import type { StatusTier } from "@repo/ui/status-badge";
import { Switch } from "@repo/ui/switch";
import { Textarea } from "@repo/ui/textarea";
import type { AddonMarketItem } from "@/app/server/actions/addons";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import {
  InspectorAction,
  InspectorFrame,
} from "@/components/design-project/canvas/inspector-shell/inspector-frame";
import {
  addonEnableInputSchema,
  addonOperationId,
  forgetSecrets,
  recallSecrets,
  rememberSecrets,
  withValueAt,
  type AddonEnableInput,
} from "@/components/design-project/canvas/inspector-shell/staged-operations";
import {
  resolveTab,
  useCloseInspector,
} from "@/components/design-project/canvas/inspector-shell/subject";
import { useClusterK8sVersion } from "@/components/design-project/canvas/use-cluster-k8s-version";
import { chartVersionError } from "@/lib/addons/chart-version";
import { closedToNewInstalls } from "@/lib/addons/deprecation";
import type { GitopsBumpResult } from "@/lib/addons/gitops-bump/service";
import { REQUIREMENT_HINTS } from "@/lib/addons/requirements";
import type { AddOnField, AddOnMode } from "@/lib/addons/types";
import { addOnUpdateNotice } from "@/lib/addons/update-notice";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import type { InspectorTab, StagedOperation } from "@/lib/canvas/store/types";
import { useInspectorTab, useOperations } from "@/lib/canvas/store/use-board";
import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";
import { addonCompat } from "@/lib/compat";
import {
  useAddonsQuery,
  useDisableAddon,
  useRequestGitopsBump,
} from "@/lib/query/use-addons-query";
import { asRecord } from "@/lib/records";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { AddonDeprecationNotice } from "./addon-deprecation-notice";
import { AddonUpdateNotice } from "./addon-update-notice";
import { AddonIcon } from "./addon-visuals";

/** Reserved RHF field names (kept distinct from add-on knob keys). */
type FormShape = Record<string, unknown> & {
  _mode: AddOnMode;
  _valuesYaml: string;
  /** The chart-version pin; "" = no pin, the catalog default applies. */
  _version: string;
};

const TABS: readonly InspectorTab[] = ["configure", "status"];

/**
 * Whether a stored value counts as a present secret — an `EncryptedSecret` envelope, or a
 * legacy non-empty plaintext string. Mirrors `lib/addons/secrets.ts::hasStoredSecret` inline
 * so the client never imports the server-only crypto module that file also exports.
 */
function isSecretSet(v: unknown): boolean {
  return (
    (typeof v === "object" &&
      v !== null &&
      "iv" in v &&
      "tag" in v &&
      "data" in v) ||
    (typeof v === "string" && v.length > 0)
  );
}

/**
 * Seeds one field's form value from its stored value. A `secret` is write-only — it is seeded
 * BLANK, never with the stored `EncryptedSecret` (the ciphertext must not reach the form/DOM,
 * and an untouched field must not send the envelope back through the string schema). A `nested`
 * field recurses into an object of its children; a scalar takes the stored value or its default.
 */
function seedField(f: AddOnField, stored: unknown): unknown {
  if (f.type === "secret") return "";
  if (f.type === "nested") {
    const parent = stored && typeof stored === "object" ? asRecord(stored) : {};
    const obj: Record<string, unknown> = {};
    for (const child of f.fields ?? []) {
      obj[child.key] = seedField(child, parent[child.key]);
    }
    return obj;
  }
  return stored ?? f.default;
}

/**
 * The form's values for what is INSTALLED (or, for an add-on that is not, its defaults): the
 * knobs, the mode, the raw YAML and the chart-version pin.
 */
function initialValues(item: AddonMarketItem): FormShape {
  const out: FormShape = {
    _mode: item.install?.mode ?? "managed",
    _valuesYaml: item.install?.valuesYaml ?? "",
    _version: item.install?.version ?? "",
  };
  for (const f of item.fields) {
    out[f.key] = seedField(f, item.install?.values?.[f.key]);
  }
  return out;
}

/** What a staged install or update carries, read through its schema; null when it carries none. */
function stagedInput(operation: StagedOperation | null): AddonEnableInput | null {
  if (!operation || operation.verb === "remove") return null;
  const parsed = addonEnableInputSchema.safeParse(operation.input);
  return parsed.success ? parsed.data : null;
}

/** The form's values with what is already staged for the add-on laid over what is installed. */
function seedValues(item: AddonMarketItem, staged: AddonEnableInput | null): FormShape {
  const base = initialValues(item);
  if (!staged) return base;
  return {
    ...base,
    ...staged.values,
    _mode: staged.mode,
    _valuesYaml: staged.valuesYaml,
    _version: staged.version ?? "",
  };
}

/** Whether the add-on is already installed on the environment. */
function isInstalledItem(item: AddonMarketItem): boolean {
  return item.install !== null;
}

/** The value at a dotted path of a values object, or undefined. */
function valueAt(values: Record<string, unknown>, path: string): unknown {
  let current: unknown = values;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = asRecord(current)[part];
  }
  return current;
}

/** Every scalar field of an add-on with the dotted path its control is registered under. */
function scalarFields(fields: AddOnField[]): { field: AddOnField; path: string }[] {
  const out: { field: AddOnField; path: string }[] = [];
  for (const f of fields) {
    if (f.generated) continue;
    if (f.type === "nested") {
      for (const child of f.fields ?? []) out.push({ field: child, path: `${f.key}.${child.key}` });
    } else {
      out.push({ field: f, path: f.key });
    }
  }
  return out;
}

/** Why the form may not be staged as it stands: one sentence per field that is wrong. */
function problemsOf(item: AddonMarketItem, values: FormShape): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const version = chartVersionError(values._version);
  if (version) problems.push({ path: "_version", message: version });
  for (const { field, path } of scalarFields(item.fields)) {
    if (field.type !== "number") continue;
    const value = valueAt(values, path);
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    if (field.min !== undefined && value < field.min) {
      problems.push({ path, message: `${field.label} is at least ${field.min}.` });
    } else if (field.max !== undefined && value > field.max) {
      problems.push({ path, message: `${field.label} is at most ${field.max}.` });
    }
  }
  return problems;
}

/**
 * The form's values as the operation that installs or updates the add-on, with the secrets that
 * were typed held apart. A secret is BLANK in the operation — blank is "leave what is stored" —
 * and a number field that was emptied is left out rather than stored as not-a-number.
 */
function toOperationInput(
  item: AddonMarketItem,
  values: FormShape,
  target: { projectId: string; environmentId: string | null },
): { input: AddonEnableInput; secrets: Record<string, string> } {
  const { _mode, _valuesYaml, _version, ...rest } = values;
  let knobs: Record<string, unknown> = rest;
  const secrets: Record<string, string> = {};
  for (const { field, path } of scalarFields(item.fields)) {
    const value = valueAt(knobs, path);
    if (field.type === "secret") {
      if (typeof value === "string" && value !== "") secrets[path] = value;
      knobs = withValueAt(knobs, path, "");
    } else if (field.type === "number" && typeof value === "number" && Number.isNaN(value)) {
      knobs = withValueAt(knobs, path, undefined);
    }
  }
  return {
    input: {
      projectId: target.projectId,
      environmentId: target.environmentId,
      addonId: item.id,
      mode: _mode,
      values: knobs,
      valuesYaml: _valuesYaml,
      // An empty field is a reset, not "unchanged": the card always shows the stored pin, so
      // clearing it is the person saying "use the catalog default again".
      version: _version === "" ? null : _version,
      secretPaths: Object.keys(secrets),
    },
    secrets,
  };
}

/**
 * True when two values are the same JSON, reading an empty text and an absent one alike. Leaving a
 * text field that was never filled writes "" where the seed had nothing, and that is not a change.
 */
function same(a: unknown, b: unknown): boolean {
  const blank = (_key: string, value: unknown) => (value === "" ? undefined : value);
  return JSON.stringify(a, blank) === JSON.stringify(b, blank);
}

/** The frame's status row for an add-on: its ArgoCD health once read back, else its install state. */
function addonStatus(item: AddonMarketItem): { label: string; tier: StatusTier } {
  const install = item.install;
  if (!install) return { label: "Not installed", tier: "idle" };
  if (install.health && install.health !== "Unknown") {
    if (install.health === "Healthy") return { label: "Healthy", tier: "active" };
    if (install.health === "Degraded" || install.health === "Missing") {
      return { label: install.health, tier: "failed" };
    }
    return { label: install.health, tier: "pending" };
  }
  if (install.status === "PENDING") return { label: "Pending deploy", tier: "pending" };
  if (install.status === "FAILED") return { label: "Failed", tier: "failed" };
  return { label: install.status.charAt(0) + install.status.slice(1).toLowerCase(), tier: "idle" };
}

/**
 * The add-on subject on the rail. Resolves the catalog item by id from the environment's add-ons
 * query (the same read the Add palette uses), so the subject is addressable by the add-on's id
 * alone — and re-renders with the install state as it changes.
 */
export function AddonConfigCard({
  itemId,
  projectId,
  environmentId,
}: {
  itemId: string;
  projectId: string;
  environmentId: string | null;
}) {
  const addons = useAddonsQuery(projectId, environmentId);
  const board = useBoard();
  const close = useCloseInspector();
  const provider = useCanvasStore((s) => s.getEffectiveProvider(PROJECT_NODE_ID));
  const live = addons.data?.items.find((i) => i.id === itemId) ?? null;
  const staged = useOperations().some((o) => o.id === addonOperationId(itemId));

  // While the person is in the middle of something — a field has been typed into, or a change is
  // staged — the row is FROZEN at what the form was seeded from. This query refetches whenever an
  // `addons` hint arrives, so a teammate (or the person's own second tab) reconfiguring the same
  // add-on would land a refetch that re-seeded the form and wiped what was half-typed, the
  // Advanced YAML above all. Outside that, the form follows the query, so an applied change shows
  // as what is installed.
  //
  // All of it is state adjusted while rendering (React's guarded form), so nothing waits a commit.
  const [touched, setTouched] = useState(false);
  const [frozen, setFrozen] = useState<AddonMarketItem | null>(null);
  const [wasStaged, setWasStaged] = useState(staged);
  const [epoch, setEpoch] = useState(0);
  if (staged !== wasStaged) {
    setWasStaged(staged);
    if (!staged) {
      // The staged change is gone: it was applied or discarded. The form starts again from what
      // the query says now.
      setTouched(false);
      setFrozen(null);
      setEpoch(epoch + 1);
    }
  }
  const holding = staged || touched;
  const frozenHere = frozen?.id === itemId ? frozen : null;
  if (holding && live && frozenHere === null) setFrozen(live);
  const item = holding ? (frozenHere ?? live) : live;

  if (!item && addons.isPending) {
    // The catalog is still being read: the frame is already the subject's, and the body is the
    // shape of the form that is coming.
    return (
      <InspectorFrame eyebrow="Add-on" title="Add-on" onClose={close}>
        <SkeletonRoot className="space-y-4" aria-label="Loading the add-on">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="space-y-2">
              <Skeleton className="h-3 w-24 rounded-none" />
              <Skeleton className="h-9 w-full rounded-none" />
            </div>
          ))}
        </SkeletonRoot>
      </InspectorFrame>
    );
  }
  if (!item) {
    return (
      <InspectorFrame eyebrow="Add-on" title="Add-on" onClose={close}>
        <EmptyState
          title="This add-on is not in the catalog"
          description="It may have been removed from the marketplace. Pick one from the Add menu."
        />
      </InspectorFrame>
    );
  }
  return (
    <AddonConfigForm
      key={`${item.id}:${epoch}`}
      item={item}
      projectId={projectId}
      environmentId={environmentId}
      hasAppsRepo={addons.data?.hasAppsRepo ?? false}
      appsRepoName={addons.data?.appsRepoName ?? null}
      gitopsRefusal={addons.data?.gitopsRefusal ?? null}
      provider={provider}
      onDone={close}
      onOpenAddon={(id) => board.view.getState().openCard({ kind: "addon", itemId: id })}
      touched={touched}
      onTouched={() => setTouched(true)}
    />
  );
}

/**
 * The add-on's configure form, as the inspector's add-on subject. Props-driven so the catalog item
 * can be handed in directly (tests, and any surface that already holds the item); `onDone` is
 * called after a successful removal.
 */
export function AddonConfigForm({
  item,
  projectId,
  environmentId,
  hasAppsRepo,
  appsRepoName = null,
  gitopsRefusal = null,
  provider,
  onDone,
  onOpenAddon,
  touched = false,
  onTouched,
}: {
  item: AddonMarketItem;
  projectId: string;
  environmentId: string | null;
  hasAppsRepo: boolean;
  /** The apps repo as `owner/repo` on GitHub, where a GitOps bump pull request is opened (#6549). */
  appsRepoName?: string | null;
  /**
   * Why GitOps delivery cannot be chosen here — the apps repo is not on GitHub (#6599) — or null.
   * The server refuses the same choice with the same sentence; this says it before the click.
   */
  gitopsRefusal?: string | null;
  /** The project's effective cloud provider — drives the requirement hints (null = unset). */
  provider: CloudProviderSlug | null;
  onDone: () => void;
  /** Opens another add-on — the deprecation notice's "Open <replacement>" (#6543). */
  onOpenAddon?: (addonId: string) => void;
  /** True once a field has been typed into: the form then stops following `item`. */
  touched?: boolean;
  /** Called on the first input into any field. */
  onTouched?: () => void;
}) {
  const board = useBoard();
  const requested = useInspectorTab();
  const tab = resolveTab(requested, TABS);
  const operationId = addonOperationId(item.id);
  const operation = useOperations().find((o) => o.id === operationId) ?? null;

  // Remove is not undoable and its effect lands on the next Deploy — the chart is uninstalled and
  // whatever it owns in the cluster goes with it — so the click OPENS a confirm rather than firing
  // the mutation (#4281).
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removed = useRef(false);
  // Seeded with what is staged laid over what is installed, so reopening the subject shows the
  // change that is waiting. While nothing is staged and nothing was typed the form follows `item`.
  const [seed] = useState(() => seedValues(item, stagedInput(operation)));
  const form = useForm<FormShape>({
    defaultValues: seed,
    values: operation || touched ? undefined : initialValues(item),
  });
  // A refusal the person can act on is said in the frame's one message place, not in a toast that
  // is gone while the value that caused it is still on screen.
  const [refusal, setRefusal] = useState<string | null>(null);
  const disable = useDisableAddon({
    onRefusal: (error) => setRefusal(error.message),
    successMessage: `${item.name} removed`,
  });
  // The GitOps bump pull request (#6549): the last press's outcome, said in the notice.
  const [bumpResult, setBumpResult] = useState<GitopsBumpResult | null>(null);
  const bump = useRequestGitopsBump({
    onRefusal: (error) => setRefusal(error.message),
    onSuccess: (result) => setBumpResult(result),
  });
  const mode = useWatch({ control: form.control, name: "_mode" });
  // The env's Kubernetes version as it will DEPLOY. An unset version resolves to the catalog
  // default (#5314); only a design with no cluster yields undefined → `not_evaluable`, never a
  // false pass. On BYO-IaC an unset version is the module's to decide, and the hint says so (#5365).
  const k8s = useClusterK8sVersion();

  // Silent when the add-on's recorded window fits — same calm rule as the canvas chip (#1222).
  const addonVerdict = addonCompat(item.id, k8s.version, k8s.reason);
  const compat = addonVerdict.status === "pass" ? null : addonVerdict;
  const isInstalled = isInstalledItem(item);
  // Read from the STORED install, not the form: the notice is about what is deployed (#6537).
  const update = addOnUpdateNotice(
    { version: item.version, securityRelease: item.securityRelease },
    item.install ? { mode: item.install.mode, version: item.install.version } : null,
  );
  // #6543. Past the removal date a NEW install is refused by the server; the subject says so and
  // stages nothing rather than offering a change that can only be refused. An installed one can
  // still be reconfigured.
  const deprecation = item.deprecated ?? null;
  const closedForNewInstalls =
    deprecation !== null && closedToNewInstalls(deprecation, new Date());
  const closedToNew = closedForNewInstalls && !isInstalled;

  /**
   * Stage the form as it stands. For an installed add-on a form that equals what is installed
   * takes the change off the changeset; for one that is not installed, `add` stages the install
   * even when every field still holds its default.
   */
  const stage = useCallback(
    (add = false) => {
      if (closedToNew || removed.current) return;
      const values = form.getValues();
      const problems = problemsOf(item, values);
      form.clearErrors();
      for (const problem of problems) {
        form.setError(problem.path, { type: "validate", message: problem.message });
      }
      // A form that does not validate is not staged; each field says why.
      if (problems.length > 0) return;

      const target = { projectId, environmentId };
      const { input, secrets } = toOperationInput(item, values, target);
      const held = { ...recallSecrets(operationId), ...secrets };
      const next: AddonEnableInput = { ...input, secretPaths: Object.keys(held) };
      const installed = toOperationInput(item, initialValues(item), target).input;
      const changed = !same(next, installed);
      const document = board.document.getState();
      const current = document.operations.find((o) => o.id === operationId);

      if (!changed && (isInstalled || (!add && !current))) {
        if (current) {
          document.unstageOperation(operationId);
          forgetSecrets(operationId);
        }
        return;
      }
      rememberSecrets(operationId, held);
      // Staging is an undo step; staging what is already staged would be an empty one.
      if (current && same(current.input, next)) return;
      document.stageOperation({
        id: operationId,
        target: "addon",
        verb: isInstalled ? "update" : "install",
        targetId: item.id,
        summary: `${isInstalled ? "Reconfigure" : "Install"} add-on ${item.name}${next.version ? ` at ${next.version}` : ""}`,
        input: next,
      });
    },
    [board, closedToNew, environmentId, form, isInstalled, item, operationId, projectId],
  );

  // A subject that goes away — another card is selected, the board is clicked, Escape — commits
  // what it holds. The ref keeps the cleanup on the latest `stage` without re-running it.
  const latestStage = useRef(stage);
  useEffect(() => {
    latestStage.current = stage;
  }, [stage]);
  useEffect(() => () => latestStage.current(), []);

  /** Take the staged change off the changeset. The form starts again from what is installed. */
  const discard = () => {
    form.reset(initialValues(item));
    board.document.getState().unstageOperation(operationId);
    forgetSecrets(operationId);
  };

  /** A discrete control changed: write it to the form and stage at once. */
  const choose = (path: string, value: unknown) => {
    onTouched?.();
    form.setValue(path, value, { shouldDirty: true });
    stage();
  };

  /** The one-click pin update: set the pin to the catalogue's version and stage it (#6537). */
  const onUpdatePin = (version: string) => choose("_version", version);

  /**
   * Remove the add-on from this environment (reconciled away on the next Deploy). Answers whether
   * it was removed, which is what closes the confirmation or keeps it open.
   */
  const onRemove = async (): Promise<boolean> => {
    if (disable.isPending) return false;
    setRefusal(null);
    try {
      await disable.mutateAsync({
        projectId,
        environmentId,
        addonId: item.id,
      });
      // Nothing staged for an add-on that is gone may run, or be staged again as this unmounts.
      removed.current = true;
      discard();
      onDone();
      return true;
    } catch {
      // Already said: `useActionMutation` put the refusal in the frame's alert, or anything else
      // in one toast. The subject stays open.
      return false;
    }
  };

  /** The sentence under a field while what it holds may not be staged. */
  const fieldError = (path: string) => {
    const message = form.getFieldState(path, form.formState).error?.message;
    return message ? (
      <p role="alert" className="text-xs font-medium text-foreground">
        {message}
      </p>
    ) : null;
  };

  /**
   * Renders one schema'd knob, discriminated on `f.type`, at RHF path `path` (dotted for a
   * nested child, e.g. `resources.cpu`). `stored` is this field's persisted value, used for a
   * boolean's initial state and a secret's set/unset indicator. Recurses one level for `nested`.
   */
  const renderField = (f: AddOnField, path: string, stored: unknown) => {
    const help = f.help ? (
      <p className="text-xs text-muted-foreground">{f.help}</p>
    ) : null;

    if (f.type === "nested") {
      const parent =
        stored && typeof stored === "object" ? asRecord(stored) : {};
      return (
        <div key={path} className="space-y-2">
          <Label>{f.label}</Label>
          <div className="space-y-4 rounded-md border border-l-2 border-l-border bg-muted/20 p-3">
            {(f.fields ?? []).map((child) =>
              renderField(child, `${path}.${child.key}`, parent[child.key]),
            )}
          </div>
          {help}
        </div>
      );
    }

    if (f.type === "boolean") {
      return (
        <div key={path} className="space-y-2">
          <div className="flex items-center justify-between">
            {/* `htmlFor` does not name the switch: `@repo/ui/switch` renders a
                `<span role="switch">`, which is not labelable, so the label is
                pointed at by reference instead (#4352). */}
            <Label id={`${path}-label`} htmlFor={path}>
              {f.label}
            </Label>
            <Switch
              id={path}
              aria-labelledby={`${path}-label`}
              defaultChecked={Boolean(valueAt(seed, path) ?? stored ?? f.default)}
              onCheckedChange={(v) => choose(path, v)}
            />
          </div>
          {help}
        </div>
      );
    }

    if (f.type === "enum") {
      // Uncontrolled: the select owns the display from `defaultValue`; the form gets each change
      // through `choose`. The value is stored, the option label is shown.
      const initial = String(valueAt(seed, path) ?? stored ?? f.default ?? "");
      return (
        <div key={path} className="space-y-2">
          <Label htmlFor={path}>{f.label}</Label>
          <Select defaultValue={initial} onValueChange={(v) => choose(path, v)}>
            <SelectTrigger id={path}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(f.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {help}
        </div>
      );
    }

    if (f.type === "secret") {
      // Write-only: the input never binds to the stored value (an EncryptedSecret envelope), so
      // the ciphertext never reaches the DOM. The pill reads set/unset from the stored value;
      // typing sets a new plaintext (encrypted server-side). A value typed for a staged change is
      // held in memory and is not shown again.
      const set = isSecretSet(stored);
      const typed = recallSecrets(operationId)[path] !== undefined;
      return (
        <div key={path} className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor={path}>{f.label}</Label>
            <span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
              {typed ? "Staged" : set ? "Set" : "Unset"}
            </span>
          </div>
          <Input
            id={path}
            type="password"
            autoComplete="off"
            placeholder={set || typed ? "Enter a new value to replace" : "Set a value"}
            onChange={(e) => form.setValue(path, e.target.value, { shouldDirty: true })}
          />
          {help}
        </div>
      );
    }

    // number / string
    return (
      <div key={path} className="space-y-2">
        <Label htmlFor={path}>{f.label}</Label>
        <Input
          id={path}
          type={f.type === "number" ? "number" : "text"}
          min={f.min}
          max={f.max}
          aria-invalid={form.getFieldState(path, form.formState).error ? true : undefined}
          {...form.register(
            path,
            f.type === "number" ? { valueAsNumber: true } : {},
          )}
        />
        {fieldError(path)}
        {help}
      </div>
    );
  };

  const status = addonStatus(item);
  const versionError = form.getFieldState("_version", form.formState).error?.message;

  return (
    <InspectorFrame
      icon={<AddonIcon icon={item.icon} className="h-4 w-4" />}
      eyebrow="Add-on"
      title={item.name}
      summary={item.summary}
      status={{
        label: status.label,
        tier: status.tier,
        message: `The ${item.chart} chart, in the ${item.namespace} namespace.`,
      }}
      action={
        isInstalled ? (
          <InspectorAction
            label="Remove"
            variant="ghost"
            onClick={() => setConfirmRemove(true)}
            disabledReason={disable.isPending ? "This add-on is being removed." : null}
          />
        ) : operation || closedToNew ? undefined : (
          <InspectorAction label="Add to changes" onClick={() => stage(true)} />
        )
      }
      tabs={TABS}
      tab={tab}
      onTabChange={(next) => board.view.getState().setTab(next)}
      notice={
        operation ? (
          <span className="flex items-center justify-between gap-3">
            <span>
              {isInstalled ? "New settings staged." : "Install staged."} It runs when you apply
              your changes, and reaches the cluster on the next deploy.
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={discard}>
              Discard
            </Button>
          </span>
        ) : undefined
      }
      error={refusal}
      onClose={onDone}
    >
      {tab === "status" ? (
        <AddonStatusView item={item} />
      ) : (
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="text-ui-2xs uppercase">
                Free · OSS
              </Badge>
              <span>{item.license}</span>
            </div>
            {item.requires.length > 0 && (
              <div className="space-y-1.5 pt-2">
                <p className="text-xs font-medium text-muted-foreground">Requirements</p>
                {item.requires.map((req) => {
                  const h = REQUIREMENT_HINTS[req](provider);
                  return (
                    <div key={req} className="flex items-start gap-2">
                      <Badge variant="outline" className="shrink-0 text-ui-2xs uppercase">
                        {h.label}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{h.hint}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Kubernetes compatibility (#1221) — the same register as Requirements: a badge and
                one line of prose. Silent when the recorded window fits this cluster;
                `not_evaluable` is stated as unknown rather than dressed up as fine. */}
            {compat && (
              <div className="flex items-start gap-2 pt-2">
                <Badge
                  variant={compat.status === "fail" ? "destructive" : "outline"}
                  className="shrink-0 text-ui-2xs uppercase"
                >
                  {compat.status === "fail" ? "Incompatible" : "Unverified"}
                </Badge>
                <span className="text-xs text-muted-foreground">{compat.note}</span>
              </div>
            )}
          </div>

          {deprecation && (
            <AddonDeprecationNotice
              deprecation={deprecation}
              name={item.name}
              installed={isInstalled}
              closed={closedForNewInstalls}
              onOpenReplacement={onOpenAddon}
            />
          )}

          {update && (
            <AddonUpdateNotice
              notice={update}
              addonId={item.id}
              name={item.name}
              pending={disable.isPending}
              onUpdatePin={onUpdatePin}
              bump={
                hasAppsRepo && item.install?.mode === "gitops"
                  ? {
                      record: item.install.gitopsBump,
                      repo: appsRepoName,
                      result: bumpResult,
                      pending: bump.isPending,
                      onRequest: (again) => {
                        if (bump.isPending) return;
                        setRefusal(null);
                        bump.mutate({ projectId, environmentId, addonId: item.id, again });
                      },
                    }
                  : undefined
              }
            />
          )}

          <form
            className="space-y-5"
            onInput={() => onTouched?.()}
            onBlur={() => stage()}
            onSubmit={(e) => {
              e.preventDefault();
              stage();
            }}
          >
            <fieldset disabled={closedToNew} className="space-y-5">
              {/* Delivery mode */}
              <div className="space-y-2">
                <Label>Delivery</Label>
                <Select
                  value={mode}
                  onValueChange={(v) => choose("_mode", v === "gitops" ? "gitops" : "managed")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="managed">Managed — Alethia applies it</SelectItem>
                    <SelectItem value="gitops" disabled={!hasAppsRepo || gitopsRefusal !== null}>
                      GitOps — written to your apps repo
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {gitopsRefusal !== null
                    ? gitopsRefusal
                    : mode === "gitops"
                      ? "The manifest is seeded into your apps repo (you own + edit it thereafter); ArgoCD syncs it."
                      : !hasAppsRepo
                        ? "GitOps mode needs an apps repo on this environment (set one in the project)."
                        : "Alethia renders + applies the ArgoCD Application directly."}
                </p>
              </div>

              {/* Schema'd knobs — discriminated on field type (enum/secret/nested + scalars). */}
              {item.fields
                // `generated` knobs are minted for the person and have no form (#2846): the chart
                // dictates their key names, and nobody has an opinion about a CSRF key's value.
                .filter((f) => !f.generated)
                .map((f) => renderField(f, f.key, item.install?.values?.[f.key]))}

              {/* Chart version pin (#5525) — empty means the catalog's default version. */}
              <div className="space-y-2">
                <Label htmlFor="addon-chart-version">Chart version</Label>
                <Input
                  id="addon-chart-version"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={item.version}
                  aria-invalid={versionError ? true : undefined}
                  aria-describedby="addon-chart-version-help"
                  className="font-mono"
                  {...form.register("_version")}
                />
                {versionError && (
                  <p role="alert" className="text-xs text-destructive">
                    {versionError}
                  </p>
                )}
                <p id="addon-chart-version-help" className="text-xs text-muted-foreground">
                  Leave empty to use the catalog&apos;s default ({item.version}). A pinned chart is
                  not checked against the catalog&apos;s settings, so a major-version jump can break
                  the options above.
                </p>
              </div>

              {/* Advanced — raw Helm values */}
              <Collapsible>
                <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
                  <span>Advanced — raw Helm values (YAML)</span>
                  <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <Textarea
                    aria-label="Raw Helm values (YAML)"
                    rows={8}
                    spellCheck={false}
                    placeholder={
                      "# deep-merged on top of the options above\n# e.g.\n# resources:\n#   requests:\n#     cpu: 100m"
                    }
                    className="font-mono text-xs"
                    {...form.register("_valuesYaml")}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Overrides the options above; merged into the chart values.
                  </p>
                </CollapsibleContent>
              </Collapsible>
            </fieldset>
          </form>
        </div>
      )}

      <ConfirmAction
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove this add-on?"
        description={
          // Past the removal date a removed add-on is a NEW install the next time, and new installs
          // are refused (#6543) — so the usual "re-enabling starts from the defaults" would be false.
          closedForNewInstalls && deprecation
            ? `${item.name} is uninstalled from this environment on your next Deploy, along with anything its chart owns in the cluster. This cannot be undone: ${item.name} no longer accepts new installs, so it cannot be re-enabled here. Move your traffic to ${deprecation.replacementName} first.`
            : `${item.name} is uninstalled from this environment on your next Deploy, along with anything its chart owns in the cluster. Its configuration is not kept — re-enabling it starts from the defaults.`
        }
        confirmLabel="Remove add-on"
        pendingLabel="Removing…"
        severity={{ level: "confirm" }}
        run={onRemove}
      />
    </InspectorFrame>
  );
}

/** The add-on's Status view: how it is installed here, and what was last read back from the cluster. */
function AddonStatusView({ item }: { item: AddonMarketItem }) {
  const install = item.install;
  if (!install) {
    return (
      <EmptyState
        className="px-0 py-4 md:px-0 md:py-4"
        title="Not installed in this environment"
        description="Add it to your changes from Settings. Its health is shown here once it has been deployed."
      />
    );
  }
  const rows: { label: string; value: string }[] = [
    { label: "Delivery", value: install.mode === "gitops" ? "GitOps" : "Managed" },
    { label: "Chart", value: item.chart },
    { label: "Version", value: install.version ?? `${item.version} (catalog default)` },
    { label: "Namespace", value: item.namespace },
    { label: "Health", value: install.health ?? "Not read yet" },
    { label: "Sync", value: install.sync ?? "Not read yet" },
  ];
  return (
    <section className="space-y-3">
      <SectionHeading level={3} title="Installed here" />
      <dl className="space-y-1.5 border border-border bg-surface-sunken px-3 py-2.5 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-3">
            <dt className="w-20 shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 truncate font-mono" title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
