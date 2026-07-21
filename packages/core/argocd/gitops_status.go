// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// GitOps wiring failure steps — the FailedStep vocabulary. Each maps 1:1 to a hard-fail
// return in the provisioner's GitOps bootstrap (deploy.go), so the console can key an
// actionable fix hint off the step instead of parsing the error text.
const (
	GitopsStepArgocdInstall    = "argocd_install"
	GitopsStepGitToken         = "git_token"
	GitopsStepRepoCredentials  = "repo_credentials"
	GitopsStepTemplatesMissing = "templates_missing"
	GitopsStepRender           = "render"
	GitopsStepApply            = "apply"
)

// UserAppsApplicationName is the ArgoCD Application that syncs the customer's apps
// repo (infra/templates/argocd/user-apps.yaml). All GitOps-managed services live
// inside this one Application; per-service health comes from its status.resources.
const UserAppsApplicationName = "apps"

// GitopsStatus is the GitOps-wiring outcome + apps-Application health snapshot for one
// deploy (or one day-2 inspection). It rides execution_metadata as `gitops_status` and
// mirrors the TS GitopsStatusReport in apps/console/types/jsonb.types.ts. Fail-loud
// contract: when FailedStep is set the deploy died INSIDE the wiring, so no health was
// read — the console must render every component Unknown, never a stale pass.
type GitopsStatus struct {
	// Mode is "gitops" when an apps destination repo is wired, "direct" otherwise.
	Mode string `json:"mode"`
	// AppsRepo is the customer's apps destination repo URL (gitops mode only).
	AppsRepo string `json:"apps_repo,omitempty"`
	// ArgocdApp is the ArgoCD Application syncing the apps repo ("apps").
	ArgocdApp string `json:"argocd_app,omitempty"`
	// Revision is the apps Application's status.sync.revision — the deployed commit.
	Revision string `json:"revision,omitempty"`
	// FailedStep is set ONLY when the deploy failed inside the GitOps wiring; one of
	// the GitopsStep* constants. Empty = the wiring did not fail (or never ran).
	FailedStep string `json:"failed_step,omitempty"`
	// Error is the wiring failure message, token-sanitized (see SanitizeGitopsError) —
	// the metadata scrub is key-based and cannot catch a token embedded in a value.
	Error string `json:"error,omitempty"`
	// AppHealth is the whole apps Application's aggregate health/sync — the honest
	// fallback row when per-resource health is unavailable.
	AppHealth *AddOnHealth `json:"app_health,omitempty"`
	// Services is per-workload health parsed from the apps Application's
	// status.resources (kind Deployment/StatefulSet/DaemonSet/Rollout), keyed by
	// resource name. Empty when resources were unreadable — an honest unknown.
	Services map[string]ServiceHealth `json:"services,omitempty"`
	// ManifestWarnings are non-fatal issues found while GENERATING the app manifests: a
	// service skipped (unbuilt image / unsupported workload type), a binding endpoint that
	// couldn't be resolved (fail-closed, #710), or a credential facet with no materializable
	// secret. They explain why a rendered service may boot misconfigured — surfaced so the
	// operator sees them without digging through raw deploy logs. Contains NO secret values
	// (env/kind/facet/provider names only). Empty ⇒ generation was clean (or was skipped for a
	// bring-your-own manifests repo).
	ManifestWarnings []string `json:"manifest_warnings,omitempty"`
}

// ServiceHealth is one workload's ArgoCD resource status inside the apps Application:
// AddOnHealth plus the health MESSAGE ("Deployment exceeded its progress deadline…"),
// which per-resource statuses carry and the console's Deploy tab shows.
type ServiceHealth struct {
	Health string `json:"health"`
	Sync   string `json:"sync"`
	// Message is ArgoCD's per-resource health message; empty when healthy.
	Message string `json:"message,omitempty"`
}

// argoApp is the trimmed shape of `kubectl get application <name> -o json` we read for
// the apps Application — aggregate health/sync plus the per-resource status list that
// ReadAddOnHealth's list-shape (argoAppList) doesn't carry.
type argoApp struct {
	Status struct {
		Health struct {
			Status string `json:"status"`
		} `json:"health"`
		Sync struct {
			Status   string `json:"status"`
			Revision string `json:"revision"`
		} `json:"sync"`
		Resources []struct {
			Kind      string `json:"kind"`
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
			// Status is the per-resource SYNC status (Synced/OutOfSync) — ArgoCD's
			// field name, not to be confused with health.
			Status string `json:"status"`
			Health struct {
				Status  string `json:"status"`
				Message string `json:"message"`
			} `json:"health"`
		} `json:"resources"`
	} `json:"status"`
}

// workloadKinds are the resource kinds that represent a runnable service in the apps
// Application — the rows the console's Deploy tab shows per service.
var workloadKinds = map[string]struct{}{
	"Deployment":  {},
	"StatefulSet": {},
	"DaemonSet":   {},
	"Rollout":     {},
}

// ReadAppsStatus reads the apps Application's aggregate health/sync, its synced git
// revision, and per-workload resource health in one kubectl read. Best-effort like
// ReadAddOnHealth: any failure (kubectl hiccup, app missing, parse error) returns
// Unknown aggregates and a nil services map rather than an error, so a status blip
// never fails a deploy. Callers must treat an empty Services map as "unreadable",
// not "no services".
func ReadAppsStatus(appName string, stdout, stderr io.Writer) (agg AddOnHealth, revision string, services map[string]ServiceHealth) {
	agg = AddOnHealth{Health: "Unknown", Sync: "Unknown"}

	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get applications.argoproj.io %s -n argocd -o json", appName),
		".",
		nil,
	)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read the %s Application status: %v\n", appName, err)
		return agg, "", nil
	}

	agg, revision, services, err = parseAppsStatus([]byte(raw))
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not parse the %s Application status: %v\n", appName, err)
		return AddOnHealth{Health: "Unknown", Sync: "Unknown"}, "", nil
	}
	return agg, revision, services
}

// parseAppsStatus decodes one Application's JSON into the aggregate health/sync, the
// synced revision, and the per-workload service map. Pure — the testable seam under
// ReadAppsStatus.
func parseAppsStatus(raw []byte) (AddOnHealth, string, map[string]ServiceHealth, error) {
	var app argoApp
	if err := json.Unmarshal(raw, &app); err != nil {
		return AddOnHealth{Health: "Unknown", Sync: "Unknown"}, "", nil, err
	}
	agg := AddOnHealth{
		Health: orUnknown(app.Status.Health.Status),
		Sync:   orUnknown(app.Status.Sync.Status),
	}
	services := make(map[string]ServiceHealth)
	for _, r := range app.Status.Resources {
		if _, ok := workloadKinds[r.Kind]; !ok {
			continue
		}
		services[r.Name] = ServiceHealth{
			Health:  orUnknown(r.Health.Status),
			Sync:    orUnknown(r.Status),
			Message: r.Health.Message,
		}
	}
	return agg, app.Status.Sync.Revision, services, nil
}

// RedactTokens replaces every non-empty token in s with [REDACTED]. Use it on any error/log text
// that can carry a git credential before it leaves the sandbox into result.json / a job log: the
// runner's metadata scrub is KEY-based (it never inspects values), and a git/kubectl failure can
// echo a tokened remote URL. Pass EVERY token that could appear — the apps-repo GitAccessToken AND
// every per-repo BYO token — since the scrub only knows the values it's given (#948). Safe on empty
// tokens and an empty list.
func RedactTokens(s string, tokens ...string) string {
	for _, t := range tokens {
		if t != "" {
			s = strings.ReplaceAll(s, t, "[REDACTED]")
		}
	}
	return s
}

// SanitizeGitopsError renders err for execution_metadata with every supplied git token redacted.
// Variadic so a caller can pass both the apps-repo token and every BYO per-repo token — a tokened
// remote URL in the error text must be scrubbed before it crosses result.json. Safe on a nil err.
func SanitizeGitopsError(err error, tokens ...string) string {
	if err == nil {
		return ""
	}
	return RedactTokens(err.Error(), tokens...)
}
