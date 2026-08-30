// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

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

	"github.com/alethialabs-io/alethialabs/packages/core/compat"
)

// This file is the RUNTIME half of #3126 item 2: "detect and refuse honestly". The DATA half
// (#3445) recorded Alethia's supported ArgoCD window as machine-checkable data in
// compat/matrix.json → components[argocd].supported, on the APP-VERSION axis. Nothing read it.
// Every deploy ran `helm upgrade --install argo-cd` straight over whatever the cluster already
// had, so a customer running a version we have MEASURED as broken (#2717's structured-merge diff,
// #1165's missing 1.33 OpenAPI schema) was upgraded in place with no word said about it.
//
// ── The governing rule, and why this file is deliberately not stricter ──
//
// Refuse only what is KNOWN broken. Warn on unknown. Ship the escape hatch. An operator blocked by
// our caution has no recourse; an operator who was warned has a message and a decision. So of the
// six states below, FOUR proceed: only a version measured as outside the declared window, and a
// live ArgoCD whose version cannot be read at all, stop a deploy — and even those name
// SkipVersionPreflightEnv in the refusal.
//
// The state that matters most for that rule is UNREADABLE. A 403 from a properly locked-down
// kubeconfig, a dial timeout, an apiserver mid-restart: none of those is the operator's fault,
// none is quickly fixable, and the very next kubectl call in the install fails with a clearer
// error anyway. Refusing there would punish precisely the SRE who tightened their cluster
// correctly. So an unanswered probe warns and proceeds — and it is separated from every other
// state by construction, because "I could not ask" and "the answer was bad" are different
// sentences and conflating them is how a guard refuses a healthy cluster. That is the same
// distinction storage_class_reconcile.go's classifyLiveProvisioner draws, for the same reason.

const (
	// SkipVersionPreflightEnv disables the live-ArgoCD version preflight entirely.
	//
	// The escape hatch is part of the contract, not an afterthought: the window is data we
	// measured, and data can be wrong or stale, so an operator who knows their cluster better
	// than the matrix does must be able to say so. When it is set the deploy prints EXACTLY what
	// went unverified, so a green run is never misread as "the window was checked".
	SkipVersionPreflightEnv = "ALETHIA_ARGOCD_SKIP_VERSION_PREFLIGHT"

	// argoPreflightNamespace is the namespace the installer owns and installs into.
	argoPreflightNamespace = "argocd"

	// argoPartOfSelector selects ArgoCD's own workloads.
	//
	// Verified against the pinned chart rather than remembered: `helm template argo-cd argo/argo-cd
	// --version <pin>` renders 7 workloads (6 Deployments + 1 StatefulSet, the
	// application-controller) and EVERY one carries this label. Upstream's install.yaml sets it
	// too, which matters because the cluster we are inspecting may not have been installed by us.
	argoPartOfSelector = "app.kubernetes.io/part-of=argocd"

	// argoVersionLabel is the chart's declared app version, the fallback when no container image
	// in a workload carries a readable ArgoCD tag.
	argoVersionLabel = "app.kubernetes.io/version"

	// argoComponentID is this component's id in the compatibility matrix.
	argoComponentID = "argocd"

	// argoPreflightTimeout bounds the single probe. A cluster that cannot answer inside it
	// resolves to UNREADABLE — which proceeds — so a slow apiserver costs a deploy this much
	// time, never the deploy itself.
	argoPreflightTimeout = 30 * time.Second

	// argoPreflightReasonMax caps an echoed kubectl diagnostic. Non-secret (kubectl writes dial
	// errors and RBAC subjects here, never credentials), but an unbounded upstream message would
	// bury the verdict.
	argoPreflightReasonMax = 400
)

// ArgoPreflightVerdict is one of the six states a live-ArgoCD check can land in. Four proceed.
type ArgoPreflightVerdict string

const (
	// ArgoPreflightAbsent — the probe answered and the cluster runs no ArgoCD. PROCEED.
	ArgoPreflightAbsent ArgoPreflightVerdict = "ABSENT"
	// ArgoPreflightInRange — a live ArgoCD was read and every version found sits inside the
	// declared window. PROCEED (loudly, when the pin would move it DOWN).
	ArgoPreflightInRange ArgoPreflightVerdict = "IN_RANGE"
	// ArgoPreflightOutOfRange — a live ArgoCD was read and is outside the window. REFUSE.
	ArgoPreflightOutOfRange ArgoPreflightVerdict = "OUT_OF_RANGE"
	// ArgoPreflightUnversioned — a live ArgoCD is present but reports no readable version.
	// REFUSE, naming the escape hatch. Rare by construction: the chart labels every workload.
	ArgoPreflightUnversioned ArgoPreflightVerdict = "UNVERSIONED"
	// ArgoPreflightUnreadable — the probe did not answer at all. WARN and PROCEED.
	ArgoPreflightUnreadable ArgoPreflightVerdict = "UNREADABLE"
	// ArgoPreflightNoWindow — the matrix declares no window. WARN and PROCEED. Unreachable in a
	// shipped binary (compat's drift test fails if the window disappears), so refusing here would
	// only hurt somebody running a patched tree.
	ArgoPreflightNoWindow ArgoPreflightVerdict = "NO_WINDOW"
)

// LiveArgoObservation is what the probe OBSERVED — never what it concluded. It is produced by a
// pure classifier so the part that can be wrong is testable without a cluster.
//
// Answered is the load-bearing field. false means "the cluster did not tell me", which is NOT
// "there is no ArgoCD here" and NOT "the ArgoCD here is bad": every field below it is then
// meaningless and the decider must not read one.
type LiveArgoObservation struct {
	// Answered is true only when kubectl exited 0 AND returned a well-formed Kubernetes list.
	Answered bool
	// Reason is why the probe did not answer. Empty when Answered.
	Reason string
	// Workloads are the names of the matched ArgoCD workloads, in the order the cluster listed
	// them. Empty with Answered=true is the fresh-cluster case.
	Workloads []string
	// Versions are the DISTINCT versions read across those workloads, sorted. More than one is
	// not a bug — a mid-upgrade cluster genuinely runs two — and naming the set is the honest
	// report.
	Versions []string
	// Unversioned are the workloads that yielded no version at all.
	Unversioned []string
}

// ArgoPreflightDecision is the verdict plus the sentence the operator sees. Message is printed on
// stdout when Proceed, and becomes the refusal error verbatim when not.
type ArgoPreflightDecision struct {
	Verdict ArgoPreflightVerdict
	Proceed bool
	Message string
}

// PreflightLiveArgoVersion refuses, warns or proceeds on the ArgoCD a cluster ALREADY runs.
//
// It must be called before the install touches anything — in particular before the namespace is
// created and the redis secret seeded. A guard that runs after its own side effects cannot tell a
// fresh cluster from one it just touched.
//
// A refusal is returned UNWRAPPED and the caller must keep it that way. Prefixing it with
// "failed to install ArgoCD" is how a deliberate refusal gets read as a broken chart.
func PreflightLiveArgoVersion(ctx context.Context, stdout io.Writer) error {
	win, declared := compat.MustLoad().SupportedWindow(argoComponentID)

	if skip := strings.TrimSpace(os.Getenv(SkipVersionPreflightEnv)); skip != "" {
		fmt.Fprintf(stdout, "ArgoCD version preflight SKIPPED (%s=%s).\n"+
			"NOT VERIFIED: whether this cluster already runs an ArgoCD outside Alethia's supported window (%s). "+
			"No probe was issued, so a successful install here is NOT evidence that the running ArgoCD is supported.\n",
			SkipVersionPreflightEnv, skip, describeArgoWindow(win, declared))
		return nil
	}

	decision := decideArgoVersionPreflight(probeLiveArgoWorkloads(ctx), win, declared, pinnedArgoAppVersion())
	if !decision.Proceed {
		return errors.New(decision.Message)
	}
	fmt.Fprintln(stdout, decision.Message)
	return nil
}

// probeLiveArgoWorkloads asks the cluster what ArgoCD it is running. The exec is separated from
// the classification because only the classification can be wrong.
//
// `-o json` and NOT a jsonpath, deliberately: on a namespace that does not exist, or a selector
// that matches nothing, kubectl exits 0 with a well-formed empty List — which is an ANSWER, and
// the answer this check most needs to distinguish. A jsonpath returns the same empty string for
// "nothing matched" and for "the expression was wrong", and the second would be silently read as
// a fresh cluster.
//
// stdout and stderr are captured SEPARATELY. kubectl writes to stderr on calls that SUCCEED (a
// `Warning:` deprecation header, an exec-credential plugin's notice on AWS/GCP/Azure auth), and
// CombinedOutput would fold that line into the JSON and turn a healthy answer into unparseable
// garbage — i.e. into a refusal-adjacent state on a cluster with nothing wrong with it.
func probeLiveArgoWorkloads(ctx context.Context) LiveArgoObservation {
	cctx, cancel := context.WithTimeout(ctx, argoPreflightTimeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, "kubectl",
		"--request-timeout="+argoProbeRequestTimeout(argoPreflightTimeout).String(),
		"-n", argoPreflightNamespace,
		"get", "statefulsets.apps,deployments.apps",
		"-l", argoPartOfSelector,
		"-o", "json")
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	err := cmd.Run()
	return classifyLiveArgoWorkloads(out.Bytes(), errOut.Bytes(), err)
}

// argoProbeRequestTimeout sits kubectl's OWN request timeout under the context bound, so a probe
// that runs out of time returns a clean dial error rather than being SIGKILLed at the deadline
// with nothing to report — and UNREADABLE then carries a sentence instead of a shrug.
//
// The floor matters even though today's bound leaves room for it: this is the number somebody
// lowers when they want the preflight to be quicker, and a negative --request-timeout makes
// kubectl refuse the call outright, which would turn every deploy's preflight into UNREADABLE
// silently. Pure and separated so both arms are pinned rather than one being dead by arithmetic.
func argoProbeRequestTimeout(total time.Duration) time.Duration {
	const floor = 2 * time.Second
	if req := total - floor; req >= floor {
		return req
	}
	return floor
}

// argoWorkloadList is the shape of `kubectl get statefulsets.apps,deployments.apps -o json`.
// Asking for two resource types yields ONE document of kind "List" holding both; asking for one
// yields "DeploymentList"/"StatefulSetList". Both are accepted, anything else is not an answer.
type argoWorkloadList struct {
	Kind  string             `json:"kind"`
	Items []argoWorkloadItem `json:"items"`
}

// argoWorkloadItem is one Deployment or StatefulSet, reduced to the two places a version can hide.
type argoWorkloadItem struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name   string            `json:"name"`
		Labels map[string]string `json:"labels"`
	} `json:"metadata"`
	Spec struct {
		Template struct {
			Spec struct {
				Containers     []argoWorkloadContainer `json:"containers"`
				InitContainers []argoWorkloadContainer `json:"initContainers"`
			} `json:"spec"`
		} `json:"template"`
	} `json:"spec"`
}

// argoWorkloadContainer is one container's image reference.
type argoWorkloadContainer struct {
	Image string `json:"image"`
}

// classifyLiveArgoWorkloads turns kubectl's three possible outcomes into an observation. Pure.
//
// The three outcomes are: a non-zero exit (could not ask), a zero exit whose body is not a
// Kubernetes list (asked, but the answer is not usable), and a zero exit with a list — which may
// legitimately be empty. Only the third sets Answered.
func classifyLiveArgoWorkloads(out, errOut []byte, runErr error) LiveArgoObservation {
	if runErr != nil {
		reason := strings.TrimSpace(string(errOut))
		if reason == "" {
			// Checked too, so a kubectl that ever writes its diagnostic the other way round still
			// classifies rather than being reported as opaque.
			reason = strings.TrimSpace(string(out))
		}
		if reason == "" {
			reason = runErr.Error()
		}
		return LiveArgoObservation{Reason: trimArgoPreflightReason(reason)}
	}

	var doc argoWorkloadList
	if err := json.Unmarshal(out, &doc); err != nil {
		return LiveArgoObservation{Reason: trimArgoPreflightReason(
			fmt.Sprintf("kubectl exited 0 but its output was not JSON (%v): %s", err, string(out)))}
	}
	// A bare `{}` is valid JSON and would otherwise unmarshal into zero items and read as a fresh
	// cluster. Requiring a list kind is the cheapest sound question that separates "the cluster
	// listed nothing" from "this is not a list".
	if !strings.HasSuffix(doc.Kind, "List") {
		return LiveArgoObservation{Reason: trimArgoPreflightReason(
			fmt.Sprintf("kubectl exited 0 but answered with kind %q, which is not a Kubernetes list", doc.Kind))}
	}

	obs := LiveArgoObservation{Answered: true}
	seen := map[string]bool{}
	for _, item := range doc.Items {
		name := strings.TrimSpace(item.Metadata.Name)
		if name == "" {
			name = strings.TrimSpace(item.Kind)
		}
		if name == "" {
			name = "(unnamed workload)"
		}
		obs.Workloads = append(obs.Workloads, name)
		version := argoWorkloadVersion(item)
		if version == "" {
			obs.Unversioned = append(obs.Unversioned, name)
			continue
		}
		if !seen[version] {
			seen[version] = true
			obs.Versions = append(obs.Versions, version)
		}
	}
	sort.Strings(obs.Versions)
	return obs
}

// argoWorkloadVersion reads one workload's ArgoCD version: the container image tag first, the
// chart's version label second.
//
// The image tag is preferred because it is what the process actually IS — a label can be stale on
// a workload somebody patched by hand. But it is taken ONLY from a container whose image names
// argocd, and that restriction is measured, not defensive. Rendering the pinned chart shows the
// selector matches seven workloads and two of them run something else entirely:
// argocd-redis runs the redis image, and argocd-dex-server lists the dex image FIRST, ahead of
// its argocd copy-util container. A naive "first container's tag" would read dex's version off a
// perfectly healthy cluster running our own pin, find it below the floor, and REFUSE the deploy.
// Both of those workloads still carry the version label, so the fallback answers for them.
func argoWorkloadVersion(item argoWorkloadItem) string {
	for _, c := range item.Spec.Template.Spec.Containers {
		if tag := argoTagFromImage(c.Image); tag != "" {
			return tag
		}
	}
	for _, c := range item.Spec.Template.Spec.InitContainers {
		if tag := argoTagFromImage(c.Image); tag != "" {
			return tag
		}
	}
	return strings.TrimSpace(item.Metadata.Labels[argoVersionLabel])
}

// argoTagFromImage returns the tag of an image reference that names argocd, or "" for anything
// else. Pure. Ported from test/e2e/argo_predicted_live.go's argoVersionFromImages, which learned
// both of the traps below the expensive way.
//
// A registry PORT is not a tag: `registry.internal:5000/argocd` has a colon and no tag, so the
// tag is taken from the last path SEGMENT, not from the first colon. A digest-only reference
// (`…/argocd@sha256:…`) carries no version and must yield "" rather than something that reads
// like one — the whole point of this check is that it never names a version it did not read.
func argoTagFromImage(image string) string {
	image = strings.TrimSpace(image)
	if image == "" {
		return ""
	}
	if at := strings.Index(image, "@"); at >= 0 {
		image = image[:at]
	}
	segment := image
	if slash := strings.LastIndex(segment, "/"); slash >= 0 {
		segment = segment[slash+1:]
	}
	colon := strings.LastIndex(segment, ":")
	if colon < 0 {
		return ""
	}
	if !isArgoImageRepo(segment[:colon]) {
		return ""
	}
	return strings.TrimSpace(segment[colon+1:])
}

// isArgoImageRepo reports whether an image's last path segment names ArgoCD. Substring rather
// than equality because private mirrors rename (`argo-cd-server`, `argocd-mirror`), and the cost
// of the two directions is asymmetric: a missed match falls back to the version label, while a
// false match on redis or dex would refuse a healthy cluster.
func isArgoImageRepo(repo string) bool {
	r := strings.ToLower(strings.TrimSpace(repo))
	return strings.Contains(r, "argocd") || strings.Contains(r, "argo-cd")
}

// decideArgoVersionPreflight turns an observation plus the declared window into a verdict. Pure —
// no cluster, no clock, no environment — because this is the part a table-driven test can pin
// exhaustively and the part whose mistakes cost a customer a refused deploy.
//
// The ORDER of the arms is the contract:
//
//  1. an unanswered probe short-circuits to UNREADABLE before any version or window is consulted,
//     so no "I could not ask" can ever be rendered as "what you are running is broken";
//  2. an empty list is ABSENT, whatever the window says — there is nothing to hold to it;
//  3. an undeclared window cannot judge anything, so it warns rather than refusing;
//  4. only then is what was READ compared against what was DECLARED.
func decideArgoVersionPreflight(obs LiveArgoObservation, win compat.SupportedWindow, declared bool, pinned string) ArgoPreflightDecision {
	window := describeArgoWindow(win, declared)

	if !obs.Answered {
		return ArgoPreflightDecision{
			Verdict: ArgoPreflightUnreadable,
			Proceed: true,
			Message: fmt.Sprintf(
				"ArgoCD version preflight: the cluster did not answer (%s), so the supported window %s was NOT checked. "+
					"Proceeding anyway — an RBAC restriction or an unreachable apiserver is not a reason to block a deploy, "+
					"and the install that follows will fail with a clearer error if the cluster is genuinely unusable.",
				obs.Reason, window),
		}
	}

	if len(obs.Workloads) == 0 {
		return ArgoPreflightDecision{
			Verdict: ArgoPreflightAbsent,
			Proceed: true,
			Message: fmt.Sprintf(
				"ArgoCD version preflight: no existing ArgoCD found (namespace %s, selector %s matched nothing). "+
					"Installing %s; Alethia's supported window is %s.",
				argoPreflightNamespace, argoPartOfSelector, describeArgoPin(pinned), window),
		}
	}

	if !declared {
		return ArgoPreflightDecision{
			Verdict: ArgoPreflightNoWindow,
			Proceed: true,
			Message: fmt.Sprintf(
				"ArgoCD version preflight: the cluster already runs ArgoCD %s (namespace %s), but the compatibility "+
					"matrix declares NO supported window for %q — so nothing was checked. Proceeding, and installing %s.",
				describeArgoVersions(obs), argoPreflightNamespace, argoComponentID, describeArgoPin(pinned)),
		}
	}

	if len(obs.Versions) == 0 {
		return ArgoPreflightDecision{
			Verdict: ArgoPreflightUnversioned,
			Proceed: false,
			Message: fmt.Sprintf(
				"refusing to install ArgoCD: namespace %s already runs %d ArgoCD workload(s) (%s), but not one of them "+
					"reports a readable version — no argocd container image tag and no %s label — so it cannot be held "+
					"to Alethia's supported window %s. Installing over an ArgoCD we cannot identify risks the in-place "+
					"upgrade this check exists to prevent. Label or re-tag the running install, or set %s=1 to install anyway.",
				argoPreflightNamespace, len(obs.Workloads), strings.Join(obs.Workloads, ", "),
				argoVersionLabel, window, SkipVersionPreflightEnv),
		}
	}

	var outside, unjudgeable []string
	for _, v := range obs.Versions {
		switch status, _ := compat.CheckSemverWindow(v, win.AppVersionMin, win.AppVersionMax); status {
		case compat.StatusFail:
			outside = append(outside, v)
		case compat.StatusNotEvaluable:
			unjudgeable = append(unjudgeable, v)
		case compat.StatusPass, compat.StatusWarn:
			// In the window. A range check never emits warn; it is listed so a new status has to
			// be handled here rather than falling silently into the pass arm.
		}
	}

	// Known-broken beats unknown: when a cluster reports both, the measured refusal is the more
	// useful sentence to put in front of the operator.
	if len(outside) > 0 {
		return ArgoPreflightDecision{
			Verdict: ArgoPreflightOutOfRange,
			Proceed: false,
			Message: fmt.Sprintf(
				"refusing to install ArgoCD: namespace %s already runs ArgoCD %s, which is OUTSIDE Alethia's supported "+
					"window %s. Upgrading in place over a version Alethia has measured as broken is destructive, so this "+
					"deploy stops here rather than doing it silently. Move the cluster to a supported ArgoCD first, or set "+
					"%s=1 to override this refusal and accept the risk.",
				argoPreflightNamespace, strings.Join(outside, ", "), window, SkipVersionPreflightEnv),
		}
	}

	if len(unjudgeable) > 0 {
		return ArgoPreflightDecision{
			Verdict: ArgoPreflightUnversioned,
			Proceed: false,
			Message: fmt.Sprintf(
				"refusing to install ArgoCD: namespace %s already runs ArgoCD reporting %s, which is not a version this "+
					"check can compare against Alethia's supported window %s. An unidentifiable ArgoCD cannot be shown to "+
					"be safe to upgrade in place. Re-tag or label the running install, or set %s=1 to install anyway.",
				argoPreflightNamespace, quoteJoin(unjudgeable), window, SkipVersionPreflightEnv),
		}
	}

	message := fmt.Sprintf(
		"ArgoCD version preflight: the cluster already runs ArgoCD %s (namespace %s), inside Alethia's supported "+
			"window %s. Proceeding; this deploy installs %s.",
		describeArgoVersions(obs), argoPreflightNamespace, window, describeArgoPin(pinned))
	if down := argoDowngradedBy(pinned, obs.Versions); len(down) > 0 {
		message += fmt.Sprintf(
			"\n  ⚠ WARNING — THIS IS A DOWNGRADE. The pinned install (%s) is LOWER than the %s already running, so this "+
				"deploy will move the cluster's ArgoCD DOWN. Stop the deploy now if that is not what you intend; the "+
				"install is a `helm upgrade --install` and will not ask again.",
			describeArgoPin(pinned), quoteJoin(down))
	}
	if len(obs.Unversioned) > 0 {
		message += fmt.Sprintf(
			"\n  Note: %d of the %d matched workloads reported no version (%s); the verdict rests on the %d that did.",
			len(obs.Unversioned), len(obs.Workloads), strings.Join(obs.Unversioned, ", "), len(obs.Versions))
	}
	return ArgoPreflightDecision{Verdict: ArgoPreflightInRange, Proceed: true, Message: message}
}

// argoDowngradedBy returns the running versions the pinned install would move DOWN from.
//
// The comparison reuses CheckSemverWindow rather than reaching for semver directly: "is the pin
// below a floor of the running version" is exactly the question that function answers, and a
// second copy of a version comparison in this repo is how two ends of a window drift apart.
func argoDowngradedBy(pinned string, running []string) []string {
	if strings.TrimSpace(pinned) == "" {
		return nil
	}
	var down []string
	for _, v := range running {
		if status, _ := compat.CheckSemverWindow(pinned, v, ""); status == compat.StatusFail {
			down = append(down, v)
		}
	}
	return down
}

// pinnedArgoAppVersion is the ArgoCD version this deploy is about to install, READ from the
// matrix release recorded for the resolved chart pin — never typed here.
//
// Chart version and app version are different scales and #2717 was expensive precisely because
// they were reasoned about interchangeably, so the translation goes through the matrix, which is
// the only place that records the mapping and the only place a drift test checks it. "" when the
// chart pin has been overridden to something the matrix does not record, and the caller says so
// rather than naming a version it does not know.
func pinnedArgoAppVersion() string {
	rel, ok := compat.MustLoad().Release(argoComponentID, ResolvedArgoChartVersion())
	if !ok {
		return ""
	}
	return strings.TrimSpace(rel.AppVersion)
}

// describeArgoPin renders what is about to be installed, naming the chart it came from. Both
// halves are read (the resolved pin, the matrix's app version for it); an app version the matrix
// does not record is SAID to be unknown rather than guessed.
func describeArgoPin(pinned string) string {
	chart := ResolvedArgoChartVersion()
	if strings.TrimSpace(pinned) == "" {
		return fmt.Sprintf("chart %s, whose ArgoCD version the compatibility matrix does not record", chart)
	}
	return fmt.Sprintf("ArgoCD %s (chart %s)", pinned, chart)
}

// describeArgoWindow renders the declared window, or says plainly that there is none. An
// undeclared window is not an open one and must never render as "any".
func describeArgoWindow(win compat.SupportedWindow, declared bool) string {
	if !declared {
		return "(none declared)"
	}
	return compat.SemverLabel(win.AppVersionMin, win.AppVersionMax)
}

// describeArgoVersions renders the distinct versions read off the cluster. More than one is a
// mid-upgrade cluster, and naming the set beats picking one and calling it the answer.
func describeArgoVersions(obs LiveArgoObservation) string {
	switch len(obs.Versions) {
	case 0:
		return "(no readable version)"
	case 1:
		return obs.Versions[0]
	default:
		return quoteJoin(obs.Versions) + " (a mid-upgrade cluster reports more than one)"
	}
}

// quoteJoin renders a set of version strings so an empty or whitespace one is visible rather than
// silently vanishing into the sentence around it.
func quoteJoin(vs []string) string {
	quoted := make([]string, 0, len(vs))
	for _, v := range vs {
		quoted = append(quoted, fmt.Sprintf("%q", v))
	}
	return strings.Join(quoted, ", ")
}

// trimArgoPreflightReason collapses a kubectl diagnostic to one bounded line so the verdict stays
// readable. kubectl writes dial errors and RBAC subjects here — non-secret — but verbosely.
func trimArgoPreflightReason(s string) string {
	s = strings.TrimSpace(strings.Join(strings.Fields(s), " "))
	if s == "" {
		return "kubectl produced no diagnostic"
	}
	if len(s) > argoPreflightReasonMax {
		return s[:argoPreflightReasonMax] + "…"
	}
	return s
}
