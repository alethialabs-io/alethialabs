// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The experiment that settled #2717: set `compare-options: ServerSideDiff=true` on ONE
// already-failing Application, inside the e2e run only, and watch what the Application DOES.
//
// # IT HAS RUN, AND THE PRODUCT HAS BEEN FLIPPED
//
// hetzner/addons run 33199532768 returned FLIP WOULD FIX IT on BOTH subjects (addon-tempo and
// addon-harbor: OutOfSync → Synced, no sync operation in the window, `.spec` content identical
// across it). `packages/core/argocd/addons.go` now renders the compare-option on every add-on
// Application, so THE PREMISE OF THIS EXPERIMENT NO LONGER HOLDS on a normal run: the subject
// already carries the annotation, and `runSSDExperiment` correctly returns COULD NOT ASK saying
// exactly that ("there is no flip to measure").
//
// That is the intended end state, not a regression. The code is kept because it is the instrument
// that would have to be re-run if the flip were ever reverted or if a future argo-cd pin changed
// the strategy again — and because a COULD NOT ASK naming the annotation is a far better thing for
// the next reader to find than a deleted file and a closed issue.
//
// # Why an OUTCOME and not a diff
//
// #3140 asked argo-cd for its own Server-Side Diff — `argocd app diff --core --server-side-diff` —
// so that argo-cd, not our reproduction of its algorithm, would say whether live matches desired.
// On hetzner/addons run 33172643012 it returned, for BOTH harbor and tempo:
//
//	Warning: Application does not have ServerSideDiff=true annotation.
//	error getting cluster raw REST config: unable to create K8s REST config:
//	  stat /home/argocd/.kube/config: no such file or directory
//	command terminated with exit code 20
//
// That probe cannot answer its own question, and it fails TWICE over:
//
//  1. The CLI refuses `--server-side-diff` unless the Application ALREADY carries the annotation —
//     which is exactly the change being evaluated. The question presupposes its own answer.
//  2. Independently, the ServerSideDiff RPC needs a raw cluster REST config. `--core` runs the
//     API-server logic in-process inside the application-controller pod, where there is no
//     `/home/argocd/.kube/config`, so that RPC cannot be served on the one path we can reach.
//
// Neither is a bug we can fix from here, and no argo-cd version above the pinned one changes
// either. A probe whose only possible answer is COULD NOT ASK is noise, so #3140's CLI probe was
// removed rather than left to print the same non-answer on every failing run.
//
// What replaces it is strictly better evidence than a diff: set the annotation on the failing
// Application and observe whether it transitions to `Synced`. That is not a model of the flip — it
// IS the flip, measured on the real cluster, on the real Application, under the real controller.
// It also routes around both blockers: nothing here runs the `argocd` CLI, so nothing needs the
// kubeconfig the controller pod does not have. Every read and write is host `kubectl` against the
// Application object (per #3100: the controller image has `argocd` but NOT `kubectl`, so status
// reads belong on the host side anyway).
//
// # It changes NOTHING that ships
//
// `packages/core/argocd/addons.go` is untouched: the product still renders
// `ServerSideApply=true, RespectIgnoreDifferences=true` and NO ServerSideDiff compare-option. The
// annotation is patched onto the LIVE Application object by this harness, on an already-failing
// path, and removed again before the report ends. The maintainer's ruling is that the product
// default may be flipped only if argo-cd's own comparison agrees that live matches desired; this
// produces that verdict without pre-empting it.
//
// # Three verdicts, and the third is not a soft version of the other two
//
//	FLIP WOULD FIX IT       a reconcile that happened AFTER the flip reports Synced, and no sync
//	                        operation ran in the window. The compare-option is the whole difference.
//	FLIP WOULD NOT FIX IT   a reconcile that happened AFTER the flip still reports OutOfSync. The
//	                        diff strategy is NOT the cause, and #2717 needs another answer.
//	COULD NOT ASK           the annotation could not be set, neither post-flip reconcile landed
//	                        inside the budget, the spec moved under us, or a sync operation makes a
//	                        Synced unattributable. Says NOTHING in either direction, deliberately.
//
// The fail-safe is the property #3140 got right and this file inherits: no failure to run the
// experiment may render as either answer.
//
// # Freshness, and why the gate is reconciledAt rather than the generation
//
// A verdict read from a status the controller has not recomputed is the pre-flip verdict wearing a
// post-flip label. The gate is therefore `status.reconciledAt`, compared against the value read
// before the patch — cluster-clock against cluster-clock, so no host/cluster skew enters it.
//
// One moved timestamp is not enough, and ssdObservation says why at length: a reconcile already in
// flight when the patch landed writes a fresh timestamp off the OLD comparison. So the experiment
// waits out that one, requests a second re-compare, and reads the verdict from THAT — a comparison
// that provably began after the annotation was persisted.
//
// `metadata.generation` cannot be that gate: the apiserver bumps it only for changes OUTSIDE
// `metadata`, and this is an annotation.
//
// # Why the attribution gate is the spec CONTENT and not metadata.generation
//
// The first version of this experiment disqualified any window in which `metadata.generation`
// moved, reasoning that a bump means the spec changed under the experiment. On hetzner/addons run
// 33185250586 that gate fired on BOTH subjects — 83→85 on addon-tempo, 91→93 on addon-harbor —
// and returned COULD NOT ASK while the data underneath showed both Applications going
// `OutOfSync → Synced` under the flip. That is the third inconclusive run on this question.
//
// EXACTLY +2 on both subjects, in a window in which the experiment forces EXACTLY two reconciles,
// is the tell. On an argo-cd Application, `metadata.generation` is a status-write counter, not a
// spec-change counter, and the reason is two primary sources deep:
//
//  1. argo-cd's Application CRD declares `subresources: {}` — no `status` subresource. (Verified in
//     `manifests/crds/application-crd.yaml` at v3.3.9, the version chart 9.5.11 bundles; see
//     packages/core/argocd/versions.go.) The application-controller therefore persists status with
//     a merge patch on the MAIN resource, not on a status endpoint.
//  2. apiextensions-apiserver's `customResourceStrategy.PrepareForUpdate` increments the generation
//     whenever the object's NON-METADATA content differs semantically from the old object's — and
//     with no status subresource, `.status` is part of that content.
//
// So every reconcile that writes `status.reconciledAt` bumps the generation, and `.operation` —
// also top-level, also non-metadata — bumps it again on each auto-sync these add-ons run. This
// experiment DELIBERATELY forces two reconciles (settle, then the confirming re-compare), so the
// old gate was not merely likely to fire: it was unsatisfiable by construction. It could never have
// returned a verdict on any run, and the appearance of rigour cost three of them.
//
// Note what is NOT the explanation, because the obvious wrong answer here reads identically: the
// apiserver does compare rather than blindly increment, so a byte-identical re-apply does not bump
// the counter — and nothing re-applies these Applications anyway. They are `kubectl apply`-ed once
// per deploy by the runner (packages/core/argocd/waves.go `ApplyAddOnsInWaves`, from
// packages/core/provisioner/deploy.go), with no app-of-apps parent and no cadence. Blaming a
// phantom re-apply would have made the gate look like bad luck instead of a design error.
//
// What the attribution argument actually needs is that the controller compared the SAME desired
// state before and after. So the experiment captures `.spec` on both reads and compares the
// CONTENT: canonical JSON (map keys sorted, numbers preserved verbatim, array order left alone
// because order is semantic in an Application spec). Identical content means the bump came from the
// status the controller itself wrote, and the verdict stands — said out loud in the report, never
// silently. Different content is still COULD NOT ASK, and now NAMES the paths that differ, so the
// next reader learns what interfered instead of guessing.
//
// The generation is still read and still reported. It is evidence in the freshness line; it is no
// longer the gate.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"reflect"
	"sort"
	"strings"
	"time"
)

const (
	// ssdCompareOptionsAnnotation is argo-cd's per-Application compare-options annotation.
	ssdCompareOptionsAnnotation = "argocd.argoproj.io/compare-options"
	// ssdCompareOption is the one option under test.
	ssdCompareOption = "ServerSideDiff=true"
	// argoRefreshAnnotation asks the controller to re-compare NOW rather than at its next cadence.
	// `normal` re-compares against the cached render, which is what a compare-option change needs;
	// a hard refresh would additionally re-render the chart and cost a repo-server pull for nothing.
	// The controller removes this annotation itself once it has processed it.
	argoRefreshAnnotation = "argocd.argoproj.io/refresh"
	argoRefreshNormal     = "normal"
)

// maxSSDExperimentApps caps how many Applications the experiment touches in one run.
//
// Two, not all of them: one clean case plus one corroborator is the whole evidentiary value, and
// every additional Application is another live object to patch, wait on and restore on a path that
// is already failing and already spending its budget.
const maxSSDExperimentApps = 2

// ssdExperimentPreference orders the Applications worth spending the experiment on, best first.
//
// addon-tempo is the cleanest single case — one StatefulSet, one OutOfSync ref, no sibling
// workloads to confound the reading. addon-harbor is the corroborator on hetzner (three
// StatefulSets under one Application) and addon-keda the one on azure. Anything else OutOfSync is
// still a valid subject and is taken in name order once these are exhausted: the experiment is
// about the CONTROLLER's comparison, not about these three charts.
var ssdExperimentPreference = []string{"addon-tempo", "addon-harbor", "addon-keda"}

// pickSSDExperimentApps chooses which OutOfSync Applications to run the experiment on. Pure.
func pickSSDExperimentApps(outOfSync []string) []string {
	remaining := make(map[string]bool, len(outOfSync))
	for _, name := range outOfSync {
		remaining[name] = true
	}
	var picked []string
	for _, name := range ssdExperimentPreference {
		if len(picked) >= maxSSDExperimentApps {
			return picked
		}
		if remaining[name] {
			picked = append(picked, name)
			delete(remaining, name)
		}
	}
	rest := make([]string, 0, len(remaining))
	for name := range remaining {
		rest = append(rest, name)
	}
	sort.Strings(rest)
	for _, name := range rest {
		if len(picked) >= maxSSDExperimentApps {
			break
		}
		picked = append(picked, name)
	}
	return picked
}

// ssdSnapshot is everything the experiment reads off one Application, in one `kubectl get`.
//
// Comparable on purpose (no maps): the wait loop compares whole snapshots, and a field that could
// only be compared element-wise is a field the loop would quietly stop checking.
type ssdSnapshot struct {
	// CompareOptions is the annotation's value; HasCompareOptions distinguishes ABSENT from
	// present-and-empty, which is the difference between restoring by deleting the key and
	// restoring by writing an empty string.
	CompareOptions    string
	HasCompareOptions bool
	// Generation is metadata.generation — reported, and used as neither the freshness gate nor the
	// attribution gate. See the package comment.
	Generation int64
	// Spec is `.spec` rendered as CANONICAL JSON — map keys sorted, so two reads of the same desired
	// state compare equal regardless of how either was serialised. It is a string and not a decoded
	// map on purpose: ssdSnapshot must stay comparable (see the type comment), and a canonical
	// string is exactly as strong a comparison as a deep equality on the value it came from.
	//
	// HasSpec distinguishes "the spec was read and is empty" from "the spec was not there", because
	// two unreadable specs would otherwise compare EQUAL and pass the attribution gate on no
	// evidence at all.
	Spec    string
	HasSpec bool
	// Sync is status.sync.status; ReconciledAt is status.reconciledAt, the freshness gate.
	Sync         string
	ReconciledAt string
	// OperationStartedAt is status.operationState.startedAt. It moves when a SYNC ran, which is the
	// one alternative explanation for a Synced that the flip must not be credited with.
	OperationStartedAt string
}

// ssdAppJSON is the subset of an Application this experiment decodes. Typed rather than a generic
// map, so a field that moves in a future CRD fails to decode into something rather than silently
// reading as an empty string.
type ssdAppJSON struct {
	Metadata struct {
		Generation  int64             `json:"generation"`
		Annotations map[string]string `json:"annotations"`
	} `json:"metadata"`
	// Spec is held RAW and canonicalised separately. Decoding it into a typed struct would silently
	// drop every field the struct does not name — and a field this file does not know about is
	// exactly the kind of spec change the attribution gate exists to catch.
	Spec   json.RawMessage `json:"spec"`
	Status struct {
		ReconciledAt string `json:"reconciledAt"`
		Sync         struct {
			Status string `json:"status"`
		} `json:"sync"`
		OperationState struct {
			StartedAt string `json:"startedAt"`
		} `json:"operationState"`
	} `json:"status"`
}

// parseSSDSnapshot decodes one Application's JSON into the fields the experiment needs. Pure.
func parseSSDSnapshot(raw []byte) (ssdSnapshot, error) {
	var app ssdAppJSON
	if err := json.Unmarshal(raw, &app); err != nil {
		return ssdSnapshot{}, fmt.Errorf("could not decode the Application: %w", err)
	}
	value, present := app.Metadata.Annotations[ssdCompareOptionsAnnotation]
	var spec string
	var hasSpec bool
	if len(app.Spec) > 0 && !bytes.Equal(bytes.TrimSpace(app.Spec), []byte("null")) {
		canonical, cerr := ssdCanonicalJSON(app.Spec)
		if cerr != nil {
			// An unreadable spec is an error and not a silent absence: the attribution gate treats a
			// missing spec as COULD NOT ASK, and a decode failure that reached it as an empty string
			// would be indistinguishable from an Application that genuinely has no spec.
			return ssdSnapshot{}, fmt.Errorf("could not canonicalise the Application's .spec: %w", cerr)
		}
		spec, hasSpec = canonical, true
	}
	return ssdSnapshot{
		CompareOptions:     value,
		HasCompareOptions:  present,
		Generation:         app.Metadata.Generation,
		Spec:               spec,
		HasSpec:            hasSpec,
		Sync:               strings.TrimSpace(app.Status.Sync.Status),
		ReconciledAt:       strings.TrimSpace(app.Status.ReconciledAt),
		OperationStartedAt: strings.TrimSpace(app.Status.OperationState.StartedAt),
	}, nil
}

// ssdCanonicalJSON re-renders arbitrary JSON so that two renderings of the same CONTENT are the
// same string. Pure.
//
// Three deliberate choices:
//
//   - Map keys are sorted, which `encoding/json` does for a `map[string]any` for free. This is the
//     normalisation the whole refinement turns on: a re-apply that re-serialises the same fields in
//     a different order must not read as a spec change.
//   - Numbers are kept as `json.Number`, i.e. verbatim source text. Decoding to float64 and back
//     would round a large integer into a different one, which is a spec change this gate invented.
//   - Array ORDER is preserved. In an Application spec order is semantic — `sources`, `valueFiles`,
//     `ignoreDifferences` all mean something different reordered — so sorting arrays here would
//     hide a real change behind a normalisation.
func ssdCanonicalJSON(raw []byte) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return "", err
	}
	out, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// maxSSDSpecDiffPaths caps how many differing paths the report names. A spec that was replaced
// wholesale would otherwise print the entire object into a run log; the first few paths already
// tell the reader what interfered.
const maxSSDSpecDiffPaths = 8

// ssdSpecDiffPaths names the dotted paths at which two canonical spec renderings differ. Pure.
//
// It exists so that a COULD NOT ASK is actionable. "the spec moved" tells the next reader to guess;
// "spec.source.targetRevision (\"1.2.3\" → \"1.2.4\")" tells them what to go and look at.
//
// It never returns an empty slice for two inputs that differ: an unlocatable difference is reported
// as one, because a differ that reports nothing found would read exactly like a differ that found
// nothing wrong.
func ssdSpecDiffPaths(before, after string) []string {
	if before == after {
		return nil
	}
	decode := func(s string) (any, error) {
		dec := json.NewDecoder(strings.NewReader(s))
		dec.UseNumber()
		var v any
		err := dec.Decode(&v)
		return v, err
	}
	b, berr := decode(before)
	a, aerr := decode(after)
	if berr != nil || aerr != nil {
		return []string{"spec (the captured renderings differ but could not be re-read for a path-level diff)"}
	}
	var paths []string
	ssdWalkSpecDiff("spec", b, a, &paths)
	if len(paths) == 0 {
		return []string{"spec (the canonical renderings differ but no path-level difference could be located)"}
	}
	return paths
}

// ssdWalkSpecDiff appends the paths at which `before` and `after` disagree, depth-first and in
// sorted key order so two runs over the same pair report the same list. Pure.
func ssdWalkSpecDiff(path string, before, after any, out *[]string) {
	if len(*out) >= maxSSDSpecDiffPaths {
		return
	}
	beforeMap, beforeIsMap := before.(map[string]any)
	afterMap, afterIsMap := after.(map[string]any)
	if beforeIsMap && afterIsMap {
		for _, key := range ssdSortedKeyUnion(beforeMap, afterMap) {
			beforeValue, inBefore := beforeMap[key]
			afterValue, inAfter := afterMap[key]
			switch {
			case inBefore && !inAfter:
				*out = append(*out, fmt.Sprintf("%s.%s (removed)", path, key))
			case !inBefore && inAfter:
				*out = append(*out, fmt.Sprintf("%s.%s (added: %s)", path, key, ssdRenderValue(afterValue)))
			default:
				ssdWalkSpecDiff(path+"."+key, beforeValue, afterValue, out)
			}
			if len(*out) >= maxSSDSpecDiffPaths {
				return
			}
		}
		return
	}
	beforeSlice, beforeIsSlice := before.([]any)
	afterSlice, afterIsSlice := after.([]any)
	if beforeIsSlice && afterIsSlice {
		if len(beforeSlice) != len(afterSlice) {
			*out = append(*out, fmt.Sprintf("%s (%d → %d entries)", path, len(beforeSlice), len(afterSlice)))
			return
		}
		for i := range beforeSlice {
			ssdWalkSpecDiff(fmt.Sprintf("%s[%d]", path, i), beforeSlice[i], afterSlice[i], out)
			if len(*out) >= maxSSDSpecDiffPaths {
				return
			}
		}
		return
	}
	if !reflect.DeepEqual(before, after) {
		*out = append(*out, fmt.Sprintf("%s (%s → %s)", path, ssdRenderValue(before), ssdRenderValue(after)))
	}
}

// ssdSortedKeyUnion returns every key in either map, once, in sorted order. Pure.
func ssdSortedKeyUnion(a, b map[string]any) []string {
	seen := make(map[string]bool, len(a)+len(b))
	keys := make([]string, 0, len(a)+len(b))
	for _, m := range []map[string]any{a, b} {
		for key := range m {
			if !seen[key] {
				seen[key] = true
				keys = append(keys, key)
			}
		}
	}
	sort.Strings(keys)
	return keys
}

// ssdRenderValue renders one spec value compactly for the diff line, truncated so a replaced
// sub-object cannot flood the run log. Pure.
func ssdRenderValue(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return truncateValue(string(raw), 80)
}

// ssdAnnotationPatch is the merge patch shape. A *string so a nil marshals to `null`, which is how
// a JSON merge patch DELETES a key — the only way to restore an annotation that was absent.
type ssdAnnotationPatch struct {
	Metadata struct {
		Annotations map[string]*string `json:"annotations"`
	} `json:"metadata"`
}

// ssdMergePatch renders the patch that sets — or, with a nil, clears — the compare-options
// annotation, and asks for an immediate re-compare either way. Pure.
//
// The refresh rides along on BOTH directions deliberately. On the way in it is what makes the
// experiment finish inside a run's budget instead of waiting out a reconcile cadence; on the way
// out it is what makes the rest of the run — and the proof bundle — describe the SHIPPED
// configuration rather than the experiment's.
func ssdMergePatch(compareOptions *string) string {
	refresh := argoRefreshNormal
	var patch ssdAnnotationPatch
	patch.Metadata.Annotations = map[string]*string{
		ssdCompareOptionsAnnotation: compareOptions,
		argoRefreshAnnotation:       &refresh,
	}
	raw, err := json.Marshal(patch)
	if err != nil {
		// Unreachable for this shape (strings and pointers to strings). Rendered rather than
		// panicked so a future field that IS unmarshalable fails the patch loudly instead of
		// killing the run.
		return fmt.Sprintf("{\"error\":%q}", err.Error())
	}
	return string(raw)
}

// ssdEnablePatch turns the compare-option ON.
func ssdEnablePatch() string {
	value := ssdCompareOption
	return ssdMergePatch(&value)
}

// ssdRefreshPatch asks for a re-compare and touches NOTHING else.
//
// The compare-option is deliberately not re-written: it is already set, and re-writing it would
// produce a new object version whose comparison is the one this patch caused rather than one that
// provably followed the flip. Pure.
func ssdRefreshPatch() string {
	refresh := argoRefreshNormal
	var patch ssdAnnotationPatch
	patch.Metadata.Annotations = map[string]*string{argoRefreshAnnotation: &refresh}
	raw, err := json.Marshal(patch)
	if err != nil {
		return fmt.Sprintf("{\"error\":%q}", err.Error())
	}
	return string(raw)
}

// ssdRestorePatch puts the annotation back EXACTLY as it was found — deleting it when it was
// absent, and rewriting whatever value it held when it was not. Pure.
func ssdRestorePatch(before ssdSnapshot) string {
	if !before.HasCompareOptions {
		return ssdMergePatch(nil)
	}
	value := before.CompareOptions
	return ssdMergePatch(&value)
}

// ssdObservation is one experiment's chain of reads, plus the reason it could not be run.
//
// THREE snapshots and not two, because two are not enough to attribute the result.
//
// A reconcile that was already IN FLIGHT when the patch landed finishes afterwards and writes a
// fresh `status.reconciledAt` — while having compared with the OLD compare-options. Read the
// verdict off that one and a still-OutOfSync renders as FLIP WOULD NOT FIX IT when the flip was
// never in the comparison. That is a false negative on the exact question #2717 turns on, and it
// would close off the fix.
//
// So the experiment asks TWICE. `Settle` is the first reconcile after the patch, which may be that
// in-flight one and is used for nothing but ordering. A second re-compare is then requested — after
// Settle was observed, so it cannot have started before the annotation was persisted — and `After`
// is the reconcile the verdict is actually read from.
type ssdObservation struct {
	App    string
	Before ssdSnapshot
	Settle ssdSnapshot
	After  ssdSnapshot
	// AskErr non-nil means the question could not be PUT. It is never an answer in either
	// direction and must never render like one.
	AskErr error
}

// describeSSDExperiment turns one observation into the three-way verdict. Pure, so all three
// branches are pinned without a cluster.
//
// EVERY branch carries the freshness figures, including the could-not-ask ones: the most likely way
// to misread this report is to take a verdict off a status the controller never recomputed, and the
// numbers that would have shown it must not be the thing that is omitted when the probe is unsure.
func describeSSDExperiment(obs ssdObservation) string {
	lead := fmt.Sprintf("  EXPERIMENT %s — `compare-options: %s` set on THIS Application only, then reverted: ",
		obs.App, ssdCompareOption)
	return lead + ssdVerdict(obs) + ssdFreshness(obs)
}

// ssdFreshness renders what was read, and when the cluster last recomputed it. Pure.
func ssdFreshness(obs ssdObservation) string {
	return fmt.Sprintf(
		"\n      [freshness] metadata.generation %d→%d (a STATUS-write counter on this CRD, not a spec-change one — argo-cd's Application has no status subresource, so every reconcile bumps it) · .spec %s · status.reconciledAt %s → %s (settle) → %s (verdict read here) · status.sync.status %s→%s · status.operationState.startedAt %s→%s",
		obs.Before.Generation, obs.After.Generation,
		ssdSpecState(obs),
		ssdOrNone(obs.Before.ReconciledAt), ssdOrNone(obs.Settle.ReconciledAt), ssdOrNone(obs.After.ReconciledAt),
		orUnknown(obs.Before.Sync), orUnknown(obs.After.Sync),
		ssdOrNone(obs.Before.OperationStartedAt), ssdOrNone(obs.After.OperationStartedAt))
}

// ssdSpecState renders what the attribution gate actually saw, on EVERY verdict including the
// could-not-ask ones. Pure.
//
// The gate is the one thing a reader cannot re-derive from the other numbers, so it must never be
// the field that is omitted when the probe is unsure.
func ssdSpecState(obs ssdObservation) string {
	switch {
	case !obs.Before.HasSpec && !obs.After.HasSpec:
		return "NOT READ on either side (two unread specs are not an unchanged spec)"
	case !obs.Before.HasSpec:
		return "NOT READ before the flip"
	case !obs.After.HasSpec:
		return "NOT READ at verdict time"
	case !obs.Settle.HasSpec:
		return "NOT READ at the settle read (so a spec that moved and moved back cannot be excluded)"
	case obs.Before.Spec != obs.After.Spec:
		return "content CHANGED by the verdict read, at " + strings.Join(ssdSpecDiffPaths(obs.Before.Spec, obs.After.Spec), " · ")
	// Reported separately, because a spec that moved and moved BACK is invisible in a first/last
	// comparison and is exactly the case the mid-window read exists to catch.
	case obs.Settle.Spec != obs.Before.Spec:
		return "content CHANGED at the settle read and reverted by the verdict read, at " + strings.Join(ssdSpecDiffPaths(obs.Before.Spec, obs.Settle.Spec), " · ")
	}
	return "content UNCHANGED across all three reads (canonical JSON, map keys sorted)"
}

// ssdOrNone renders an absent timestamp as "(none)" rather than as nothing. A freshness line that
// simply stops reads as though the field had been checked and was fine.
func ssdOrNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

// ssdReconciledAt parses one snapshot's reconcile timestamp. An empty value is an error rather
// than a zero time, so "the field was not there" cannot order itself before everything else. Pure.
func ssdReconciledAt(s ssdSnapshot) (time.Time, error) {
	if s.ReconciledAt == "" {
		return time.Time{}, errors.New("status.reconciledAt is empty")
	}
	return time.Parse(time.RFC3339, s.ReconciledAt)
}

// ssdVerdict is the decision itself. Pure.
//
// Order matters: every disqualifying condition is checked BEFORE the sync status is read, so no
// path can reach a verdict off a status it is not entitled to read.
func ssdVerdict(obs ssdObservation) string {
	if obs.AskErr != nil {
		return fmt.Sprintf("COULD NOT ASK (%v) — the experiment did not run to completion, and this says NOTHING about whether the flip would fix it.", obs.AskErr)
	}
	before, berr := ssdReconciledAt(obs.Before)
	settle, serr := ssdReconciledAt(obs.Settle)
	after, aerr := ssdReconciledAt(obs.After)
	if berr != nil || serr != nil || aerr != nil {
		return "COULD NOT ASK — status.reconciledAt was missing or unparseable on one of the three reads, so no status could be shown to be a POST-flip one."
	}
	if !settle.After(before) {
		return fmt.Sprintf("COULD NOT ASK — no reconcile completed after the annotation was set (waited %s). The status still describes the PRE-FLIP comparison, and reading a verdict off it would report the old algorithm's answer as the new one's.", ssdExperimentWait)
	}
	if !after.After(settle) {
		// The false negative this whole three-read chain exists to prevent. See ssdObservation.
		return fmt.Sprintf("COULD NOT ASK — the confirming re-compare did not complete (waited %s). Exactly one reconcile landed after the patch, and it may have been one already IN FLIGHT when the annotation was written — a comparison made with the OLD compare-options. Reading a verdict off it would credit or blame a flip that was never in it.", ssdExperimentWait)
	}
	// The attribution gate is the spec CONTENT, and metadata.generation is not consulted in either
	// direction: a bump over identical content is the controller's own status write and passes, and
	// a content change under a static counter is disqualifying anyway. Making the counter the gate
	// is what returned COULD NOT ASK on run 33185250586 with the answer sitting in the data.
	//
	// Compared at ALL THREE reads, not just the first and the last. A spec that changed after the
	// flip and changed back before the verdict would leave Before and After equal while the
	// controller compared something else in between; the settle read is the one instant that would
	// have seen it.
	for _, stage := range []struct {
		name string
		snap ssdSnapshot
	}{{"the settle read", obs.Settle}, {"the verdict read", obs.After}} {
		if !obs.Before.HasSpec || !stage.snap.HasSpec {
			return fmt.Sprintf("COULD NOT ASK — the Application's .spec could not be read before the flip or at %s, so a spec change under the experiment could be neither shown nor excluded. Without that, a status change is not attributable to the compare-option.", stage.name)
		}
		if obs.Before.Spec != stage.snap.Spec {
			return fmt.Sprintf("COULD NOT ASK — the Application's .spec CONTENT changed between the pre-flip read and %s (not merely its generation counter), so the controller was not comparing the same desired state throughout. Whatever the status now says is not attributable to the compare-option. Differing paths: %s.",
				stage.name, strings.Join(ssdSpecDiffPaths(obs.Before.Spec, stage.snap.Spec), " · "))
		}
	}
	switch obs.After.Sync {
	case "":
		return "COULD NOT ASK — the post-flip status.sync.status came back empty."
	case "Synced":
		if obs.After.OperationStartedAt != obs.Before.OperationStartedAt {
			// These add-ons run automated sync with selfHeal (addons.go), so a heal landing inside
			// the window is a REAL alternative explanation. Crediting the flip for it would be the
			// same class of error as reading a stale status: a verdict the evidence does not carry.
			return "COULD NOT ASK — the Application is Synced, but a SYNC OPERATION also started inside the window (status.operationState.startedAt moved), and these add-ons run automated sync with selfHeal. Synced is therefore not attributable to the diff strategy alone. Re-run to get a window with no operation in it."
		}
		return fmt.Sprintf("FLIP WOULD FIX IT — after the annotation was set, the controller re-compared and now reports %s Synced, with NO sync operation in the window. Nothing about the cluster or the chart changed: the ONLY difference is the diff strategy the controller used. This is argo-cd's own comparison agreeing that live matches desired, which is the evidence #2717 needs before `ServerSideDiff=true` may be flipped for the product.%s", obs.App, ssdGenerationNote(obs))
	case "OutOfSync":
		return fmt.Sprintf("FLIP WOULD NOT FIX IT — after the annotation was set, the controller re-compared and %s is STILL OutOfSync. argo-cd's own server-side comparison agrees with its structured-merge one, so the diff strategy is NOT the cause and flipping `ServerSideDiff=true` for the product would fix nothing. #2717 needs a different answer, and the real difference is still unnamed.%s", obs.App, ssdGenerationNote(obs))
	default:
		return fmt.Sprintf("COULD NOT ASK — the post-flip status.sync.status is %q, which is neither Synced nor OutOfSync.", obs.After.Sync)
	}
}

// ssdGenerationNote is the sentence a verdict owes its reader when metadata.generation moved and
// the verdict was reached anyway. Pure; empty when the counter did not move.
//
// It is not decoration. The previous gate refused this exact window, so a reader who remembers that
// refusal must be told, in the verdict itself, that the counter moved and WHY that is no longer
// disqualifying — rather than having to reconstruct it from the freshness line.
func ssdGenerationNote(obs ssdObservation) string {
	if obs.After.Generation == obs.Before.Generation {
		return ""
	}
	return fmt.Sprintf(" metadata.generation DID move (%d→%d) in the window, but the `.spec` content is identical after canonicalisation. argo-cd's Application CRD has NO status subresource, so every status the controller writes counts as a non-metadata change and bumps the counter — this experiment forces two reconciles, so the counter must move. It did not move because the desired state changed, and the verdict stands.",
		obs.Before.Generation, obs.After.Generation)
}

// ssdRestoreFailed is the marker a reader must be able to grep for. A silently modified Application
// would make every LATER assertion in the run, and the proof bundle it writes, describe a
// configuration that is not the shipped one.
const ssdRestoreFailed = "!!! SSD EXPERIMENT RESTORE FAILED"

// describeSSDRestore reports whether the Application was put back exactly as it was found. Pure.
func describeSSDRestore(app string, before, after ssdSnapshot, err error) string {
	want := "(absent)"
	if before.HasCompareOptions {
		want = fmt.Sprintf("%q", before.CompareOptions)
	}
	if err != nil {
		return fmt.Sprintf("    %s for %s (%v) — the Application may still carry `%s: %s`. Every later assertion in this run, and the proof bundle, would then describe the EXPERIMENT and not the shipped configuration. Remove it by hand: kubectl -n argocd annotate applications.argoproj.io %s %s-",
			ssdRestoreFailed, app, err, ssdCompareOptionsAnnotation, ssdCompareOption, app, ssdCompareOptionsAnnotation)
	}
	if after.HasCompareOptions != before.HasCompareOptions || after.CompareOptions != before.CompareOptions {
		got := "(absent)"
		if after.HasCompareOptions {
			got = fmt.Sprintf("%q", after.CompareOptions)
		}
		return fmt.Sprintf("    %s for %s — the patch reported success but `%s` reads %s and was %s. Remove it by hand: kubectl -n argocd annotate applications.argoproj.io %s %s-",
			ssdRestoreFailed, app, ssdCompareOptionsAnnotation, got, want, app, ssdCompareOptionsAnnotation)
	}
	return fmt.Sprintf("    restored: %s is back to `%s` = %s, and a re-compare was requested, so the rest of this run measures the SHIPPED configuration.",
		app, ssdCompareOptionsAnnotation, want)
}

const (
	// ssdExperimentWait bounds ONE of the two waits — the settle and the confirming re-compare —
	// so an Application costs at most twice this. Each is driven by an explicit refresh request,
	// which normally lands in seconds; the budget exists so a controller that has stopped
	// reconciling ends the experiment with a COULD NOT ASK instead of holding the run. With
	// maxSSDExperimentApps that is a 5-minute ceiling, on a path that has already failed.
	ssdExperimentWait = 75 * time.Second
	ssdExperimentPoll = 5 * time.Second
	// ssdKubectlTimeout bounds one kubectl call — a read or a patch.
	ssdKubectlTimeout = 30 * time.Second
	// ssdRestoreTimeout bounds the restore, on its OWN context. See restoreSSDCompareOption.
	ssdRestoreTimeout = 60 * time.Second
)

// argoSSDExperiment runs the experiment on the picked OutOfSync Applications and returns the
// report section.
func argoSSDExperiment(ctx context.Context, kubeconfigPath string, outOfSync []string) string {
	apps := pickSSDExperimentApps(outOfSync)
	if len(apps) == 0 {
		// Its own finding, and distinguishable from "the experiment failed": there was no failing
		// Application to run it on.
		return "\n──── EXPERIMENT (`compare-options: ServerSideDiff=true`): no OutOfSync Application to run it on ────\n"
	}
	var b strings.Builder
	b.WriteString("\n──── EXPERIMENT: would `compare-options: ServerSideDiff=true` make the Application Synced? ────\n")
	b.WriteString("  e2e-only and reverted below. The product default in packages/core/argocd/addons.go is NOT changed by this;\n" +
		"  the annotation is patched onto the live Application object so argo-cd's OWN comparison, not our reproduction of it,\n" +
		"  decides whether live matches desired (#2717).\n")
	for _, app := range apps {
		b.WriteString(runSSDExperiment(ctx, kubeconfigPath, app) + "\n")
	}
	return b.String()
}

// runSSDExperiment sets the compare-option on one Application, waits for a reconcile that is
// provably after the flip, reports the verdict, and puts the Application back.
//
// RESTORATION IS ARMED BY THE PATCH ATTEMPT, NOT BY ITS SUCCESS. A `kubectl patch` that reports an
// error may still have reached the apiserver — a timeout on the response, a connection reset after
// the write — and the restore is idempotent, so arming it on the attempt is strictly safer than
// arming it on a success we cannot fully trust. The deferred restore also survives a panic and an
// early return from any branch below, which is why the report is a NAMED return: the restore line
// is appended to whatever verdict was reached.
func runSSDExperiment(ctx context.Context, kubeconfigPath, app string) (report string) {
	before, err := readSSDSnapshot(ctx, kubeconfigPath, app)
	if err != nil {
		// Nothing was patched, so there is nothing to restore and no restore line is owed.
		return describeSSDExperiment(ssdObservation{App: app, AskErr: fmt.Errorf("could not read the Application before the flip: %w", err)})
	}
	if before.HasCompareOptions && strings.Contains(before.CompareOptions, "ServerSideDiff") {
		// The premise of the experiment is that the controller is NOT already using this strategy.
		// If something else set it, the observation would measure nothing and the restore would
		// write back a value we did not establish.
		return describeSSDExperiment(ssdObservation{App: app, Before: before,
			AskErr: fmt.Errorf("the Application already carries %s=%q, so there is no flip to measure", ssdCompareOptionsAnnotation, before.CompareOptions)})
	}

	patchErr := patchArgoApp(ctx, kubeconfigPath, app, ssdEnablePatch())
	defer func() { report += "\n" + restoreSSDCompareOption(ctx, kubeconfigPath, app, before) }()
	if patchErr != nil {
		return describeSSDExperiment(ssdObservation{App: app, Before: before,
			AskErr: fmt.Errorf("could not set %s: %w", ssdCompareOptionsAnnotation, patchErr)})
	}

	// Phase 1 — let whatever was in flight when the patch landed finish. This snapshot decides
	// nothing; it only establishes an instant that is provably after the annotation was persisted.
	settle, waitErr := awaitNextReconcile(ctx, kubeconfigPath, app, before)
	if waitErr != nil {
		return describeSSDExperiment(ssdObservation{App: app, Before: before, Settle: settle, AskErr: waitErr})
	}

	// Phase 2 — ask for a re-compare that CANNOT have started before the flip, and read the verdict
	// from that one. A refresh-only patch: the compare-option is already set and must not be
	// re-written, or the object version the controller compares would be the one this patch made.
	if err := patchArgoApp(ctx, kubeconfigPath, app, ssdRefreshPatch()); err != nil {
		return describeSSDExperiment(ssdObservation{App: app, Before: before, Settle: settle,
			AskErr: fmt.Errorf("could not request the confirming re-compare: %w", err)})
	}
	after, confirmErr := awaitNextReconcile(ctx, kubeconfigPath, app, settle)
	return describeSSDExperiment(ssdObservation{App: app, Before: before, Settle: settle, After: after, AskErr: confirmErr})
}

// awaitNextReconcile polls until status.reconciledAt moves off the value in `since`.
//
// A timeout is NOT an error here: it returns the last snapshot it managed to read, and ssdVerdict
// renders the unmoved reconciledAt as COULD NOT ASK, naming which of the two waits ran out. An
// error is returned only when no snapshot could be read at all, because that is a different
// failure — not "the controller did not recompute" but "we could not see whether it did".
func awaitNextReconcile(ctx context.Context, kubeconfigPath, app string, since ssdSnapshot) (ssdSnapshot, error) {
	deadline := time.Now().Add(ssdExperimentWait)
	var last ssdSnapshot
	var read bool
	var lastErr error
	for {
		snap, err := readSSDSnapshot(ctx, kubeconfigPath, app)
		if err != nil {
			lastErr = err
		} else {
			last, read = snap, true
			if snap.ReconciledAt != "" && snap.ReconciledAt != since.ReconciledAt {
				return snap, nil
			}
		}
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			break
		}
		timer := time.NewTimer(ssdExperimentPoll)
		select {
		case <-ctx.Done():
		case <-timer.C:
		}
		timer.Stop()
	}
	if !read {
		if lastErr == nil {
			lastErr = errors.New("the Application could not be read while waiting for a reconcile")
		}
		return ssdSnapshot{}, lastErr
	}
	return last, nil
}

// restoreSSDCompareOption puts the annotation back and reports whether it verified.
//
// It builds its OWN context off a cancellation-free copy of the caller's. The caller's budget
// belongs to an already-failing path and is frequently spent or cancelled by the time the
// experiment ends — which is precisely the moment when leaving the annotation behind would do the
// most damage. Deriving from the caller's context still carries its values; only the deadline and
// the cancellation are dropped.
func restoreSSDCompareOption(ctx context.Context, kubeconfigPath, app string, before ssdSnapshot) string {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ssdRestoreTimeout)
	defer cancel()
	if err := patchArgoApp(rctx, kubeconfigPath, app, ssdRestorePatch(before)); err != nil {
		return describeSSDRestore(app, before, ssdSnapshot{}, err)
	}
	// The patch reporting success is not the check. Re-read, because "the write returned 0" and
	// "the object no longer carries the annotation" are different claims and only the second one
	// is what the rest of the run depends on.
	after, err := readSSDSnapshot(rctx, kubeconfigPath, app)
	return describeSSDRestore(app, before, after, err)
}

// readSSDSnapshot reads one Application with the HOST kubectl.
//
// Host-side and not in-pod, per #3100: the application-controller image ships `argocd` but NOT
// `kubectl`, and this experiment needs no `argocd` call at all — which is also what makes it
// immune to the `--core` kubeconfig failure that made #3140's probe unanswerable.
func readSSDSnapshot(ctx context.Context, kubeconfigPath, app string) (ssdSnapshot, error) {
	cctx, cancel := context.WithTimeout(ctx, ssdKubectlTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "get", "applications.argoproj.io", app, "-o", "json").Output()
	if err != nil {
		return ssdSnapshot{}, fmt.Errorf("kubectl get %s: %w", app, err)
	}
	return parseSSDSnapshot(out)
}

// patchArgoApp applies a JSON merge patch to one Application with the HOST kubectl.
func patchArgoApp(ctx context.Context, kubeconfigPath, app, patch string) error {
	cctx, cancel := context.WithTimeout(ctx, ssdKubectlTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "patch", "applications.argoproj.io", app,
		"--type", "merge", "-p", patch)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("kubectl patch %s: %w: %s", app, err, truncateValue(strings.TrimSpace(string(out)), 300))
	}
	return nil
}
