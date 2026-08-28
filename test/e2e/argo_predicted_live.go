// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Why `argocd app diff` prints nothing while the Application is OutOfSync — and the instrument
// that CAN name the differing field.
//
// # The two computations are not the same computation
//
// PROVENANCE, and it is a FIXED POINT IN THE PAST: the two excerpts below were read out of the
// argo-cd source tree at v3.1.8 — the version argo-cd chart 8.6.4 bundled — not inferred. The pin
// has since moved to chart 9.5.11 → argo-cd v3.3.9 (#3128, packages/core/argocd/versions.go), and
// this comment has NOT been re-read against that tree. It records where the mechanism was
// established, not what the cluster is running.
//
// Which is why nothing this file EMITS names a version from a literal any more: the running
// controller's own image tag is read from the cluster (readArgoControllerVersion) and reported, and
// when it cannot be read the message names no version at all. A hardcoded "v3.1.8" survived the pin
// bump here and told a reader that a run had used the old ArgoCD when it had not —
// TestArgoPredictedLiveEmitsNoHardcodedVersion pins that it cannot come back.
//
//	controller/state.go, CompareAppState:
//	    if app.Spec.SyncPolicy != nil &&
//	       app.Spec.SyncPolicy.SyncOptions.HasOption("ServerSideApply=true") {
//	        diffConfigBuilder.WithStructuredMergeDiff(true)
//	    }
//	    diffConfigBuilder.WithGVKParser(gvkParser)
//	    diffConfigBuilder.WithManager(common.ArgoCDSSAManager)   // "argocd-controller"
//
//	cmd/argocd/commands/app.go, findandPrintDiff:
//	    diffConfig, err := argodiff.NewDiffConfigBuilder().
//	        WithDiffSettings(app.Spec.IgnoreDifferences, overrides, ignoreAggregatedRoles, opts).
//	        WithTracking(...).
//	        WithNoCache().
//	        WithLogger(...).
//	        Build()
//
// Every add-on Application this repo emits sets `ServerSideApply=true`
// (packages/core/argocd/addons.go). So the CONTROLLER compares with structured-merge diff, while
// `argocd app diff` builds a config with no WithStructuredMergeDiff, no WithGVKParser and no
// WithManager and therefore falls back to the plain client-side three-way diff.
//
// **An empty `argocd app diff` is not evidence that the controller saw no difference.** It is
// evidence that a DIFFERENT algorithm saw none. That is why the hard-refresh probe (#3093/#3100)
// found the OutOfSync survives a full re-render: there was never a cache to blame.
//
// # What the instrument does instead
//
// ArgoCD's own docs mark structured-merge diff "Feature Discontinued … after different issues were
// identified by the community", and its replacement — Server-Side Diff, stable since v3.1.0 —
// "will execute a Server-Side Apply in dryrun mode for each resource of the application. The
// response of this operation is then compared with the live state."
//
// So this reproduces exactly that, with kubectl, under ArgoCD's own field manager:
//
//	argocd app manifests <app> --core          (in the controller pod — needs the repo-server)
//	kubectl apply --server-side --dry-run=server --field-manager=argocd-controller
//	kubectl get <resource> -o json             (live)
//	diff the two, field by field
//
// Anything that comes back is a field the API server materialises and the applied manifest does
// not carry — which is precisely the class structured-merge diff mispredicts.
//
// # Every failure to ask renders as "COULD NOT ASK"
//
// The same rule the hard-refresh probe is built on, and the reason this question got an honest
// answer at all: a probe that cannot run must not produce a verdict in either direction. Four
// separate branches here say so in their own words, and the pure tests assert none of them can be
// mistaken for "nothing differs".
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// argoSSAFieldManager is the field manager argo-cd applies under when `ServerSideApply=true`.
// Verbatim from common/common.go in the argo-cd tree at v3.1.8 — provenance, a fixed point in the
// past; the pin is now chart 9.5.11 → v3.3.9. The constant is a compatibility contract rather than
// a version fact (changing it would orphan every field argo-cd already owns), so unlike the
// version in the report it is deliberately a literal:
//
//	// ArgoCDSSAManager is the default argocd manager name used by server-side apply syncs
//	ArgoCDSSAManager = "argocd-controller"
//
// It has to match: a dry-run apply under a DIFFERENT manager conflicts with argocd's ownership and
// produces a predicted object shaped by the conflict rather than by argocd's own apply.
const argoSSAFieldManager = "argocd-controller"

// argoAppDiffStrategySpec is the slice of an Application that decides which diff the CONTROLLER ran.
type argoAppDiffStrategySpec struct {
	SyncOptions    []string
	CompareOptions string
}

// readArgoDiffStrategy reads the Application and reports which diff strategy its controller used.
//
// Host kubectl, not the pod: the controller image ships `argocd` and not `kubectl` (#3100), and
// this is a plain status read.
//
// `workload` is the application-controller resource ref (`statefulset.apps/...`), resolved by
// argoDiffWorkload. It is asked for its running IMAGE, because the version that matters to this
// report is the version of the process that produced the sync status — not a constant in this repo,
// which is what went stale.
func readArgoDiffStrategy(ctx context.Context, kubeconfigPath, workload, app string) string {
	version := readArgoControllerVersion(ctx, kubeconfigPath, workload)
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "get", "applications.argoproj.io", app, "-o", "json").Output()
	if err != nil {
		return describeArgoDiffStrategy(argoAppDiffStrategySpec{}, version, err)
	}
	spec, perr := parseArgoDiffStrategySpec(out)
	if perr != nil {
		return describeArgoDiffStrategy(argoAppDiffStrategySpec{}, version, perr)
	}
	return describeArgoDiffStrategy(spec, version, nil)
}

// readArgoControllerVersion returns the argo-cd version the application-controller is RUNNING,
// taken from its container image tag, or "" when it cannot be read.
//
// Why the cluster and not `argocd.DefaultArgoChartVersion`: that constant is a CHART version, so
// naming an argo-cd version from it needs a chart→appVersion table that nothing checks, and
// `ALETHIA_ARGOCD_CHART_VERSION` can override the pin at run time anyway. The image tag is what the
// process reporting the sync status actually is. Reading it cannot go stale, and — the point — when
// it cannot be read the caller says so instead of naming a version.
func readArgoControllerVersion(ctx context.Context, kubeconfigPath, workload string) string {
	if strings.TrimSpace(workload) == "" {
		return ""
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "get", workload,
		"-o", "jsonpath={.spec.template.spec.containers[*].image}").Output()
	if err != nil {
		return ""
	}
	return argoVersionFromImages(string(out))
}

// argoVersionFromImages pulls the tag out of the first usable container image reference. Pure.
//
// A digest-only reference (`…/argocd@sha256:…`) carries no version and must return "" rather than
// something that reads like one — the whole defect being fixed here is a report that names a
// version it does not know. Registry ports (`registry:5000/argocd:v3.3.9`) are why the tag is taken
// from the last path segment and not from the first colon.
func argoVersionFromImages(raw string) string {
	for _, image := range strings.Fields(raw) {
		if at := strings.Index(image, "@"); at >= 0 {
			image = image[:at]
		}
		segment := image
		if slash := strings.LastIndex(segment, "/"); slash >= 0 {
			segment = segment[slash+1:]
		}
		colon := strings.LastIndex(segment, ":")
		if colon < 0 {
			continue
		}
		if tag := strings.TrimSpace(segment[colon+1:]); tag != "" {
			return tag
		}
	}
	return ""
}

// parseArgoDiffStrategySpec pulls the sync options and the compare-options annotation out of an
// Application's JSON. Split from the exec so the shapes are testable without a cluster.
func parseArgoDiffStrategySpec(raw []byte) (argoAppDiffStrategySpec, error) {
	var app struct {
		Metadata struct {
			Annotations map[string]string `json:"annotations"`
		} `json:"metadata"`
		Spec struct {
			SyncPolicy struct {
				SyncOptions []string `json:"syncOptions"`
			} `json:"syncPolicy"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(raw, &app); err != nil {
		return argoAppDiffStrategySpec{}, err
	}
	return argoAppDiffStrategySpec{
		SyncOptions:    app.Spec.SyncPolicy.SyncOptions,
		CompareOptions: app.Metadata.Annotations["argocd.argoproj.io/compare-options"],
	}, nil
}

// describeArgoDiffStrategy names the strategy the controller used and says whether
// `argocd app diff` reproduces it. Pure.
//
// This exists because the previous rendering of the empty-diff outcome — "reports NO difference,
// yet the Application is OutOfSync" — reads as a contradiction inside ArgoCD, and for a
// ServerSideApply Application it is not one: the two answers come from two different diff
// algorithms, and only one of them decided the sync status.
//
// `version` is the argo-cd version READ FROM THE RUNNING CONTROLLER, or "" when the cluster could
// not be asked. It is a parameter and not a constant because a literal here went stale the moment
// the chart pin moved (8.6.4 → 9.5.11, i.e. v3.1.8 → v3.3.9) and then reported the OLD version on
// every run — convincing a reader that a run had used the pre-bump ArgoCD when it had not. When the
// version is unknown this says nothing about a version at all: "we did not read it" and "it is
// v3.1.8" are different findings, and the second one was false.
func describeArgoDiffStrategy(spec argoAppDiffStrategySpec, version string, readErr error) string {
	const lead = "  diff strategy: "
	if readErr != nil {
		return lead + fmt.Sprintf("COULD NOT ASK (%v) — without the Application's syncOptions this cannot say whether `argocd app diff` ran the same comparison the controller did.", readErr)
	}
	// Rendered into the structured-merge branch below. Never a fallback literal.
	var controller string
	if v := strings.TrimSpace(version); v != "" {
		controller = "argo-cd " + v + "'s controller (version read from the running application-controller image)"
	} else {
		controller = "the controller (its argo-cd version could NOT be read from the cluster, so this names none)"
	}
	ssa := false
	for _, o := range spec.SyncOptions {
		if strings.EqualFold(strings.TrimSpace(o), "ServerSideApply=true") {
			ssa = true
		}
	}
	compare := spec.CompareOptions
	serverSideDiff := strings.Contains(compare, "ServerSideDiff=true") && !strings.Contains(compare, "ServerSideDiff=false")

	switch {
	case !ssa:
		return lead + "the Application does NOT set ServerSideApply=true, so argo-cd's controller and `argocd app diff` run the SAME client-side comparison. An empty diff against an OutOfSync status is a genuine contradiction here."
	case serverSideDiff:
		return lead + "ServerSideApply=true WITH compare-options ServerSideDiff=true, so the controller compared live against an API-server dry-run apply. `argocd app diff` still compares client-side and cannot reproduce that — its empty output is not evidence the controller saw nothing."
	default:
		return lead + "ServerSideApply=true and NO ServerSideDiff=true, so " + controller + " compared with STRUCTURED-MERGE diff (controller/state.go: `SyncOptions.HasOption(\"ServerSideApply=true\")` → `WithStructuredMergeDiff(true)`), a strategy argo-cd's own docs mark Feature Discontinued. `argocd app diff` builds no WithStructuredMergeDiff/WithGVKParser/WithManager (cmd/argocd/commands/app.go findandPrintDiff) and so ran the plain client-side diff. THE EMPTY DIFF AND THE OutOfSync ARE TWO DIFFERENT ALGORITHMS, not a contradiction."
	}
}

// maxPredictedLiveRefs caps how many OutOfSync resources per Application get the dry-run treatment.
// One dry-run apply covers the whole Application, so this caps only the per-resource comparison.
const maxPredictedLiveRefs = 4

// argoPredictedLiveDiff reproduces the controller's predicted-live with a REAL server-side-apply
// dry-run and names the fields that differ from the live object.
//
// This is the instrument `argocd app diff` cannot be: it runs the comparison argo-cd's own
// Server-Side Diff strategy runs, under argo-cd's own field manager, so the fields it reports are
// the fields a server-side comparison thinks differ.
//
// Best-effort on an already-failing path, bounded by the caller's context, and every way of failing
// to ask says so rather than implying an answer.
func argoPredictedLiveDiff(ctx context.Context, kubeconfigPath, target, app string, refs []outOfSyncRef) string {
	const lead = "  predicted-live (server-side apply dry-run): "
	if len(refs) == 0 {
		// Its own finding: the Application is OutOfSync but names no resource, so there is nothing
		// to reproduce and this did NOT fail to look.
		return lead + "the Application names no OutOfSync resource, so there is nothing to reproduce."
	}

	manifests, err := exec.CommandContext(ctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "exec", target, "--",
		"argocd", "app", "manifests", app, "--core").Output()
	if err != nil || len(bytes.TrimSpace(manifests)) == 0 {
		return lead + fmt.Sprintf("COULD NOT ASK — `argocd app manifests %s --core` produced no desired manifests (%v). Without the desired state there is nothing to dry-run, and this says NOTHING about whether a field differs.", app, err)
	}

	file, ferr := os.CreateTemp("", "argo-desired-*.yaml")
	if ferr != nil {
		return lead + fmt.Sprintf("COULD NOT ASK — could not stage the desired manifests (%v).", ferr)
	}
	defer os.Remove(file.Name())
	if _, werr := file.Write(manifests); werr != nil {
		file.Close()
		return lead + fmt.Sprintf("COULD NOT ASK — could not stage the desired manifests (%v).", werr)
	}
	file.Close()

	// --dry-run=server persists nothing; --field-manager must be argocd's own so the apply is
	// attributed to the owner argo-cd's sync would use. Stdout is kept even on a non-zero exit:
	// kubectl applies every object it can and reports the failures, so a single unappliable
	// resource must not erase the answer for the one we asked about.
	apply := exec.CommandContext(ctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"apply", "--server-side", "--force-conflicts",
		"--field-manager="+argoSSAFieldManager, "--dry-run=server",
		"-o", "json", "-f", file.Name())
	var stderr bytes.Buffer
	apply.Stderr = &stderr
	applied, aerr := apply.Output()

	predicted, perr := indexAppliedObjects(applied)
	if perr != nil {
		return lead + fmt.Sprintf("COULD NOT ASK — the dry-run apply returned nothing usable (%v; exit %v): %s", perr, aerr, truncateValue(strings.TrimSpace(stderr.String()), 400))
	}

	var b strings.Builder
	b.WriteString(lead + fmt.Sprintf("dry-ran %d object(s) as %q.", len(predicted), argoSSAFieldManager))
	if aerr != nil {
		// Not a failure of the probe: some objects did not apply, and the reader needs to know in
		// case the one they care about was among them.
		fmt.Fprintf(&b, " Some objects did not apply (%v): %s", aerr, truncateValue(strings.TrimSpace(stderr.String()), 300))
	}
	shown := 0
	for _, r := range refs {
		if shown >= maxPredictedLiveRefs {
			fmt.Fprintf(&b, "\n    … %d more OutOfSync resource(s) not compared", len(refs)-shown)
			break
		}
		shown++
		obj, ok := predicted[refManifestKey(r)]
		if !ok {
			fmt.Fprintf(&b, "\n    - %s: COULD NOT ASK — the dry-run produced no object for this ref, so nothing was compared", r.kubectlTarget())
			continue
		}
		live, lerr := readLiveObject(ctx, kubeconfigPath, r)
		if lerr != nil {
			fmt.Fprintf(&b, "\n    - %s: COULD NOT ASK — could not read the live object (%v)", r.kubectlTarget(), lerr)
			continue
		}
		b.WriteString(renderPredictedLiveDiff(r.kubectlTarget(), predictedLiveDifferences(obj, live)))
	}
	return b.String()
}

// readLiveObject fetches one OutOfSync resource as a decoded JSON object.
func readLiveObject(ctx context.Context, kubeconfigPath string, r outOfSyncRef) (map[string]any, error) {
	args := []string{"--kubeconfig", kubeconfigPath, "get", r.kubectlTarget(), "-o", "json"}
	if r.Namespace != "" {
		args = append(args, "-n", r.Namespace)
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", args...).Output()
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(out))
	dec.UseNumber()
	var obj map[string]any
	if derr := dec.Decode(&obj); derr != nil {
		return nil, derr
	}
	return obj, nil
}

// renderPredictedLiveDiff turns one resource's field differences into a report block. Pure.
//
// The empty case is a FINDING, not a silence: a server-side dry-run that predicts exactly the live
// object means the controller's OutOfSync is not reproducible by a server-side comparison, which
// points at the structured-merge strategy rather than at the cluster. Saying that is the whole
// value; printing nothing would read as "we looked and there was nothing", which is the same
// sentence an unrun probe produces.
func renderPredictedLiveDiff(targetName string, diffs []string) string {
	const maxDiffLines = 40
	if len(diffs) == 0 {
		return fmt.Sprintf("\n    - %s: the dry-run predicts the LIVE object EXACTLY — a server-side comparison finds no difference. If the controller still reports this resource OutOfSync, its verdict came from its own client-side prediction (structured-merge diff), not from the cluster", targetName)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\n    - %s: %d field(s) differ between the server-side prediction and live:", targetName, len(diffs))
	for i, d := range diffs {
		if i >= maxDiffLines {
			fmt.Fprintf(&b, "\n        … %d more", len(diffs)-i)
			break
		}
		b.WriteString("\n        " + d)
	}
	return b.String()
}

// refManifestKey and manifestKey render the same identity for an OutOfSync ref and for an applied
// object, so the two can be matched.
func refManifestKey(r outOfSyncRef) string {
	return strings.Join([]string{strings.ToLower(r.Group), strings.ToLower(r.Kind), r.Namespace, r.Name}, "|")
}

func manifestKey(apiVersion, kind, namespace, name string) string {
	group := ""
	if i := strings.Index(apiVersion, "/"); i >= 0 {
		group = apiVersion[:i]
	}
	return strings.Join([]string{strings.ToLower(group), strings.ToLower(kind), namespace, name}, "|")
}

// indexAppliedObjects decodes `kubectl apply -o json`'s output into objects keyed by identity.
//
// kubectl prints one JSON document per object, concatenated — and wraps them in a `List` in some
// paths — so both shapes are handled. An empty or unparseable stream is an ERROR rather than an
// empty map: "the dry-run produced nothing" and "the dry-run produced no difference" are opposite
// findings and this must not let the first render as the second.
func indexAppliedObjects(raw []byte) (map[string]map[string]any, error) {
	out := map[string]map[string]any{}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	for {
		var obj map[string]any
		err := dec.Decode(&obj)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			// A malformed stream is NOT "nothing differs": say so, and keep whatever was already
			// decoded out of the answer so a half-read stream cannot pose as a complete one.
			return nil, err
		}
		indexAppliedObject(out, obj)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no objects in the dry-run output (%d bytes)", len(raw))
	}
	return out, nil
}

// indexAppliedObject files one decoded document, unwrapping a `List` into its items.
func indexAppliedObject(out map[string]map[string]any, obj map[string]any) {
	kind, _ := obj["kind"].(string)
	if kind == "List" {
		items, _ := obj["items"].([]any)
		for _, it := range items {
			if m, ok := it.(map[string]any); ok {
				indexAppliedObject(out, m)
			}
		}
		return
	}
	apiVersion, _ := obj["apiVersion"].(string)
	meta, _ := obj["metadata"].(map[string]any)
	if meta == nil {
		return
	}
	name, _ := meta["name"].(string)
	namespace, _ := meta["namespace"].(string)
	if kind == "" || name == "" {
		return
	}
	out[manifestKey(apiVersion, kind, namespace, name)] = obj
}

// predictedLiveIgnoredPaths are the fields whose difference says nothing about convergence.
//
// `status` is excluded because the prediction and the live read are seconds apart and a workload's
// status changes between them — including it would manufacture a difference on every run. It is a
// TOP-LEVEL exclusion only: `spec.volumeClaimTemplates[].status`, the field upstream #11143 names,
// is still compared.
var predictedLiveIgnoredPaths = map[string]bool{
	"status":                     true,
	"metadata.managedFields":     true,
	"metadata.resourceVersion":   true,
	"metadata.generation":        true,
	"metadata.uid":               true,
	"metadata.creationTimestamp": true,
	"metadata.annotations.kubectl.kubernetes.io/last-applied-configuration": true,
}

// predictedLiveDifferences walks the predicted and live objects and returns one line per differing
// field, dotted-path first. Pure, and deterministic: map keys are visited in sorted order so the
// same disagreement renders identically run to run.
func predictedLiveDifferences(predicted, live map[string]any) []string {
	var out []string
	walkValueDiff("", predicted, live, &out)
	return out
}

func walkValueDiff(path string, predicted, live any, out *[]string) {
	if path != "" && predictedLiveIgnoredPaths[path] {
		return
	}
	pm, pIsMap := predicted.(map[string]any)
	lm, lIsMap := live.(map[string]any)
	if pIsMap && lIsMap {
		keys := map[string]bool{}
		for k := range pm {
			keys[k] = true
		}
		for k := range lm {
			keys[k] = true
		}
		names := make([]string, 0, len(keys))
		for k := range keys {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			pv, pOK := pm[k]
			lv, lOK := lm[k]
			child := k
			if path != "" {
				child = path + "." + k
			}
			switch {
			case pOK && lOK:
				walkValueDiff(child, pv, lv, out)
			case pOK:
				appendAbsence(child, "live", pv, out)
			default:
				appendAbsence(child, "predicted", lv, out)
			}
		}
		return
	}
	ps, pIsSlice := predicted.([]any)
	ls, lIsSlice := live.([]any)
	if pIsSlice && lIsSlice {
		if len(ps) != len(ls) {
			*out = append(*out, fmt.Sprintf("%s: predicted %d item(s), live %d item(s)", path, len(ps), len(ls)))
			return
		}
		for i := range ps {
			walkValueDiff(fmt.Sprintf("%s[%d]", path, i), ps[i], ls[i], out)
		}
		return
	}
	if !sameScalar(predicted, live) {
		*out = append(*out, fmt.Sprintf("%s: predicted=%s live=%s", path,
			truncateValue(renderScalar(predicted), 120), truncateValue(renderScalar(live), 120)))
	}
}

// appendAbsence records a field present on exactly one side. Which side is missing it is the whole
// finding — an API-server default the applied manifest never carried reads one way, and a field the
// prediction dropped reads the other — so the message names the absent side explicitly.
func appendAbsence(path, absentSide string, present any, out *[]string) {
	*out = append(*out, fmt.Sprintf("%s: absent from %s, present as %s", path, absentSide,
		truncateValue(renderScalar(present), 120)))
}

// sameScalar compares two decoded JSON leaves. Numbers arrive as json.Number (the decoders set
// UseNumber) so 1 and 1.0 do not read as a difference just because Go widened them to float64.
func sameScalar(a, b any) bool {
	return renderScalar(a) == renderScalar(b)
}

func renderScalar(v any) string {
	if v == nil {
		return "null"
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(raw)
}

func truncateValue(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
