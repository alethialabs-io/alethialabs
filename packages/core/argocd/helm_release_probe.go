// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// The Helm release a cluster's ArgoCD was installed from — asked because the version preflight
// cannot decide the DOWNGRADE case without it (#3521).
//
// WHY A SECOND PROBE AND NOT A LOOKUP. When a customer's ArgoCD is NEWER than Alethia's pin, the
// remedy is to apply our values without moving the version — which means installing against the
// chart the cluster already runs. Translating the running APP version back to a chart version
// through the compatibility matrix cannot do it: matrix.json records three argocd charts (9.5.11 →
// v3.3.9, plus 8.6.4 and 7.1.3 both marked unsupported) and NONE is newer than the pin, so the
// lookup has no row for exactly the case that needs one. The cluster's own Helm release does, and
// it is the authoritative answer rather than a derived one.
//
// It also answers a question nothing else could: whether ArgoCD is a Helm release AT ALL. An
// ArgoCD installed from the upstream manifests is not, and `helm upgrade --install` over it would
// not be an upgrade — it would create a new release that adopts objects it does not own.

// argoHelmReleaseName is the release `installArgoCD` uses (`helm upgrade --install argo-cd …`, see
// provisioner/deploy.go). Held here rather than passed in so the probe and the install cannot come
// to disagree about which release they are talking about.
const argoHelmReleaseName = "argo-cd"

// LiveArgoHelmRelease is what the probe OBSERVED about the Helm release, never what it concluded —
// the same split, and for the same reason, as LiveArgoObservation.
//
// Answered is the load-bearing field. false means "the cluster did not tell me", which is NOT "there
// is no Helm release here": the first must never be rendered as the second, because the second is a
// statement that changes what gets installed.
type LiveArgoHelmRelease struct {
	// Answered is true only when helm exited 0 AND returned a well-formed JSON list.
	Answered bool
	// Reason is why the probe did not answer. Empty when Answered.
	Reason string
	// Found is true when a release named argoHelmReleaseName exists in the argocd namespace.
	// Answered=true with Found=false is the real "ArgoCD is here but Helm did not put it here" case.
	Found bool
	// ChartVersion is the release's chart version — the `chart` field's version suffix, e.g.
	// "9.5.11" from "argo-cd-9.5.11". Empty when Found is false or the suffix is unreadable.
	ChartVersion string
	// Chart is the raw `chart` field, kept so a message can quote what was actually read rather
	// than only what was parsed out of it.
	Chart string
}

// probeLiveArgoHelmRelease asks helm what release, if any, installed the ArgoCD in this namespace.
//
// stdout and stderr are captured SEPARATELY, for the identical reason probeLiveArgoWorkloads does
// it: helm writes to stderr on calls that SUCCEED (a repository warning, a kube-config notice), and
// CombinedOutput would fold that line into the JSON and turn a healthy answer into unparseable
// garbage — i.e. into "could not ask" on a cluster with nothing wrong with it.
func probeLiveArgoHelmRelease(ctx context.Context) LiveArgoHelmRelease {
	cctx, cancel := context.WithTimeout(ctx, argoPreflightTimeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, "helm", "list",
		"-n", argoPreflightNamespace, "--filter", "^"+argoHelmReleaseName+"$", "-o", "json")
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	err := cmd.Run()
	return classifyLiveArgoHelmRelease(out.Bytes(), errOut.Bytes(), err)
}

// helmListItem is one row of `helm list -o json`, reduced to the two fields that matter.
type helmListItem struct {
	Name  string `json:"name"`
	Chart string `json:"chart"`
}

// classifyLiveArgoHelmRelease turns helm's three possible outcomes into an observation. Pure.
//
// The three are: a non-zero exit (could not ask), a zero exit whose body is not a JSON array (asked,
// answer unusable), and a zero exit with an array — which may legitimately be empty. Only the third
// sets Answered.
//
// `[]` is an ANSWER and the most important one: it means helm knows this namespace and has no such
// release, which is precisely the "installed from upstream manifests" case. A probe that could not
// distinguish it from a failed call would be unable to say the one thing it exists to say.
func classifyLiveArgoHelmRelease(out, errOut []byte, runErr error) LiveArgoHelmRelease {
	if runErr != nil {
		reason := strings.TrimSpace(string(errOut))
		if reason == "" {
			reason = strings.TrimSpace(string(out))
		}
		if reason == "" {
			reason = runErr.Error()
		}
		return LiveArgoHelmRelease{Reason: trimArgoPreflightReason(reason)}
	}

	var items []helmListItem
	if err := json.Unmarshal(out, &items); err != nil {
		return LiveArgoHelmRelease{Reason: trimArgoPreflightReason(
			fmt.Sprintf("helm exited 0 but its output was not a JSON list (%v): %s", err, string(out)))}
	}
	for _, it := range items {
		// `--filter` is a REGEX helm applies itself, and this re-checks the name rather than
		// trusting it. A helm that ever loosened the anchors, or a name that happens to contain a
		// metacharacter, would otherwise let a DIFFERENT release's chart version decide what this
		// deploy installs — which is the one mistake this probe must not make.
		if it.Name != argoHelmReleaseName {
			continue
		}
		return LiveArgoHelmRelease{
			Answered:     true,
			Found:        true,
			Chart:        it.Chart,
			ChartVersion: chartVersionFromHelmChart(it.Chart),
		}
	}
	return LiveArgoHelmRelease{Answered: true}
}

// chartVersionFromHelmChart pulls the version out of helm's `chart` field, which is
// "<chart-name>-<version>" — "argo-cd-9.5.11" → "9.5.11".
//
// It splits on the LAST hyphen, because the chart name contains one: splitting on the first yields
// "cd-9.5.11", which is not a version and would be silently carried into a `--version` flag. Returns
// "" when the field carries no hyphen or nothing after it; the caller treats that as unreadable
// rather than guessing, and describeArgoHelmRelease says so.
func chartVersionFromHelmChart(chart string) string {
	c := strings.TrimSpace(chart)
	i := strings.LastIndex(c, "-")
	if i < 0 || i == len(c)-1 {
		return ""
	}
	return c[i+1:]
}

// describeArgoHelmRelease renders the probe's outcome as the clause a message can embed, so the
// three ways of NOT having a chart version read differently from each other.
//
// They are different facts and they send an operator to different places: "helm did not answer" is
// an environment problem, "no such release" means ArgoCD was installed some other way, and an
// unreadable chart is a helm output shape nobody expected. Collapsing them into "no release" — the
// obvious shortening — would report an unreachable helm as a statement about the cluster.
func describeArgoHelmRelease(rel LiveArgoHelmRelease) string {
	switch {
	case !rel.Answered:
		return fmt.Sprintf("helm could not be asked which release installed it (%s)", rel.Reason)
	case !rel.Found:
		return fmt.Sprintf("helm reports no %q release in namespace %s, so it was not installed from this chart",
			argoHelmReleaseName, argoPreflightNamespace)
	case strings.TrimSpace(rel.ChartVersion) == "":
		return fmt.Sprintf("helm reports release %q on chart %q, whose version could not be read",
			argoHelmReleaseName, rel.Chart)
	default:
		return fmt.Sprintf("chart %s", rel.Chart)
	}
}
