// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file removes bootstrap-only hook resources that outlived the ArgoCD operation that created
// them (#6413). The keyless bootstrap's credential-bearing hooks — the admin ExternalSecret on
// AWS/GCP and the admin-federated ServiceAccount on Azure (manifests/bootstrap_job.go) — carry
// HookSucceeded + HookFailed, so they are removed when their PreSync phase completes. An operation
// that never completes its phase runs neither policy: one terminated by hand (ArgoCD's terminate
// deletes only a hook that is itself still running, which a healthy ExternalSecret or a
// ServiceAccount is not), or one whose record is lost because the Application was recreated. Their
// next removal would be the next sync's BeforeHookCreation, and the apps Application's automated sync
// does not retry a revision whose operation failed, so that can be the next deploy.
//
// The reconcile runs where the runner already reads the apps Application after a deploy, and on the
// day-2 inspection. It requests deletion of a bootstrap hook only when all of these hold:
//
//  1. The Application says no operation is live: `.operation` is absent (nothing requested) and the
//     last operation, if there is one, is terminal (Succeeded, Failed, Error). Running, Terminating,
//     an unreadable Application or no readable write time reaps nothing.
//  2. No bootstrap Job in the namespace is still active. A terminal phase alone does not prove that:
//     ArgoCD's terminate can end in Error with the PreSync Job still running, and the Job reads the
//     admin Secret when its apply-sql container starts.
//  3. The object was created strictly before the CUTOFF: the newest API-server write time on the
//     Application (its creationTimestamp and every metadata.managedFields[].time), less
//     bootstrapReapSkewMargin.
//  4. The object is exactly a rendered bootstrap hook (defence in depth): the bootstrap-only label,
//     the PreSync hook annotation, the admin hook-delete-policy, the rendered name for its kind, the
//     expected namespace and apiVersion. These are the constants manifests/bootstrap_job.go renders.
//
// Why the cutoff in (3) is sound. Every time the read sees was written BEFORE the read, whoever wrote
// it, so the cutoff is at or before the read. Every operation is bracketed by two writes to the
// Application: the request that sets `.operation` (by a user or by automated sync) and the
// controller's completion that clears it. Given (1) at the read, no operation was live, so an
// operation that creates hooks later is requested by a write after the read, and its hooks are
// created after that write: never below the cutoff. A write that is not an operation's (a status
// refresh, a metadata edit) can only move the cutoff toward the read, never past it.
//
// The premise is that each managedFields[].time is the API server's stamp of a past write. The API
// server stamps the entry of the manager making a request, as it stamps a created hook's
// creationTimestamp, so both sides of the comparison are API-server times. That is why the cutoff is
// not `operationState.finishedAt`, which the ArgoCD controller stamps from its own clock. A request
// that supplies a full managedFields list can carry other times verbatim, though (a restored or
// copied Application), and a time in the FUTURE would lift the cutoff past the read. So a write time
// later than the runner's clock plus the margin refuses the reconcile for that pass. That check
// compares two clocks only to decide whether to refuse, so it can only make the reconcile more
// conservative. The margin itself (a minute) absorbs skew between a managed control plane's
// NTP-synchronised API-server replicas and the timestamps' one-second resolution.
//
// A hook created inside the margin is not reaped on this pass. A later pass reaps it only after a
// NEWER write to the Application moves the cutoff past it, and the argument above holds for that pass
// unchanged. The ArgoCD controller writes the Application's status (reconciledAt) on each refresh,
// which is what normally provides that write.
//
// Each write is guarded by the object's UID (a JSON-patch test op, a DeleteOptions precondition), so
// an object BeforeHookCreation replaced between the list and the delete is not the one removed.
// Deletion is Foreground: the API server removes the ExternalSecret's owned Secret (the materialized
// admin credential, creationPolicy Owner) before the ExternalSecret itself, so a 200 means deletion
// was REQUESTED and the object may exist with a deletionTimestamp for a while.
//
// ArgoCD's hook finalizer: the controller adds it to every hook it creates, and its terminate removes
// it from every live hook before deciding what to delete, so after a terminated operation the hooks
// normally carry none. It can remain when an operation's record is lost. When present it is released
// first (UID-guarded), since no live operation is left to release it.
//
// This reconcile WRITES to the cluster, and it runs from the day-2 drift job, which is not gated
// against an in-flight deploy. That is safe by (1)-(3): a deploy's sync is a live operation or an
// active Job (nothing reaped), or it has not created its hooks yet (they will postdate the cutoff).
package provisioner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	// argoHookFinalizer is the finalizer ArgoCD adds to every hook it creates (gitops-engine
	// pkg/sync/hook.HookFinalizer, argo-cd v3.3.9).
	argoHookFinalizer = "argocd.argoproj.io/hook-finalizer"

	// argoHookAnnotation / argoHookDeletePolicyAnnotation are ArgoCD's hook annotations.
	argoHookAnnotation             = "argocd.argoproj.io/hook"
	argoHookDeletePolicyAnnotation = "argocd.argoproj.io/hook-delete-policy"

	// bootstrapReapCallTimeout bounds each kubectl call of the reconcile; the reconcile is best-effort
	// and must not hold up a deploy or a drift job on an unresponsive API server.
	bootstrapReapCallTimeout = 30 * time.Second

	// bootstrapReapSkewMargin is subtracted from the cutoff (see the file comment).
	bootstrapReapSkewMargin = time.Minute
)

// bootstrapReapKind is one labelled kind: the kubectl resource name for the list and the patch, the
// apiVersion its objects must report, the rendered name an object must have, and the URL path its
// guarded delete is sent to.
type bootstrapReapKind struct {
	resource     string
	apiVersionRE *regexp.Regexp
	nameOK       func(name string) bool
	path         func(apiVersion, ns, name string) string
}

// bootstrapReapKinds are the kinds that carry the bootstrap-only label. Fixed rather than discovered:
// these are the only two kinds manifests.RenderBootstrapJob labels.
var bootstrapReapKinds = []bootstrapReapKind{
	{
		resource:     "externalsecrets.external-secrets.io",
		apiVersionRE: regexp.MustCompile(`^external-secrets\.io/v[0-9a-z]+$`),
		// <BootstrapJobName><suffix>, and BootstrapJobName starts with the prefix.
		nameOK: func(name string) bool {
			return strings.HasPrefix(name, manifests.BootstrapJobNamePrefix) &&
				strings.HasSuffix(name, manifests.BootstrapAdminSecretSuffix) &&
				len(name) > len(manifests.BootstrapJobNamePrefix)+len(manifests.BootstrapAdminSecretSuffix)
		},
		path: func(apiVersion, ns, name string) string {
			return "/apis/" + apiVersion + "/namespaces/" + ns + "/externalsecrets/" + name
		},
	},
	{
		resource:     "serviceaccounts",
		apiVersionRE: regexp.MustCompile(`^v1$`),
		nameOK:       func(name string) bool { return name == manifests.BootstrapServiceAccountName },
		path: func(_, ns, name string) string {
			return "/api/v1/namespaces/" + ns + "/serviceaccounts/" + name
		},
	},
}

// Shapes a value must have before it is placed in a kubectl argument or a URL path. They come from
// the API server, but the reconcile deletes things, so it refuses anything outside the shape rather
// than trusting it.
var (
	reapNameRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)
	reapUIDRE  = regexp.MustCompile(`^[0-9a-fA-F-]{1,64}$`)
)

// reapNow is the runner's clock; a variable so tests can fix it.
var reapNow = time.Now

// bootstrapReapKubectl runs one kubectl call with optional stdin, bounded by bootstrapReapCallTimeout.
// A variable so tests can stand in for a cluster.
var bootstrapReapKubectl = func(ctx context.Context, stdin string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, bootstrapReapCallTimeout)
	defer cancel()
	full := append([]string{"--request-timeout=28s"}, args...)
	cmd := exec.CommandContext(cctx, "kubectl", full...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		reason := strings.TrimSpace(errBuf.String())
		if reason == "" {
			reason = err.Error()
		}
		return "", fmt.Errorf("%s", sanitizeProbeError(reason))
	}
	return out.String(), nil
}

// bootstrapReapApplies says whether an environment's day-2 inspection runs the reconcile: only a
// dedicated placement with an apps repo, because that is the only path that renders the keyless
// bootstrap into the apps Application. Namespace and vcluster placements deliver through their own
// Application and namespace, which this reconcile does not read.
func bootstrapReapApplies(vc *types.ProjectConfig, providerSlug string) bool {
	return vc != nil && vc.Repositories.AppsDestinationRepo != "" &&
		selectPlacementPath(vc.PlacementMode, providerSlug) == placementDedicated
}

// reapApplication is the part of an ArgoCD Application the reconcile reads.
type reapApplication struct {
	Metadata struct {
		CreationTimestamp string `json:"creationTimestamp"`
		ManagedFields     []struct {
			Time string `json:"time"`
		} `json:"managedFields"`
	} `json:"metadata"`
	// Operation is non-null while an operation is requested and not yet finished.
	Operation json.RawMessage `json:"operation"`
	Status    struct {
		OperationState *struct {
			Phase string `json:"phase"`
		} `json:"operationState"`
	} `json:"status"`
}

// reapObject is the part of a listed object the reconcile reads.
type reapObject struct {
	APIVersion string `json:"apiVersion"`
	Metadata   struct {
		Name              string            `json:"name"`
		Namespace         string            `json:"namespace"`
		UID               string            `json:"uid"`
		CreationTimestamp string            `json:"creationTimestamp"`
		Finalizers        []string          `json:"finalizers"`
		Annotations       map[string]string `json:"annotations"`
	} `json:"metadata"`
	// Status is read only for Jobs.
	Status struct {
		Active     int `json:"active"`
		Conditions []struct {
			Type   string `json:"type"`
			Status string `json:"status"`
		} `json:"conditions"`
	} `json:"status"`
}

// strandedHookCutoff decides, from an Application's JSON (read with its managedFields), whether any
// operation can still be live and, when none can, the cutoff: the newest API-server write time on the
// Application less bootstrapReapSkewMargin. now is the runner's clock, used only to refuse a write
// time later than now plus the margin (see the file comment). ok=false means reap nothing, and reason
// says why (for the log). Pure — the testable seam of the decision.
func strandedHookCutoff(raw []byte, now time.Time) (cutoff time.Time, ok bool, reason string) {
	var app reapApplication
	if err := json.Unmarshal(raw, &app); err != nil {
		return time.Time{}, false, "the Application is unreadable"
	}
	if op := strings.TrimSpace(string(app.Operation)); op != "" && op != "null" {
		return time.Time{}, false, "an operation is requested"
	}
	if st := app.Status.OperationState; st != nil {
		switch st.Phase {
		case "Succeeded", "Failed", "Error":
		default:
			return time.Time{}, false, fmt.Sprintf("the last operation is %q", st.Phase)
		}
	}
	// Every write time must parse: a time that does not parse is a document we do not understand.
	stamps := []string{app.Metadata.CreationTimestamp}
	for _, mf := range app.Metadata.ManagedFields {
		stamps = append(stamps, mf.Time)
	}
	if len(app.Metadata.ManagedFields) == 0 {
		return time.Time{}, false, "the Application has no managedFields write times"
	}
	for _, s := range stamps {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return time.Time{}, false, "the Application has an unreadable write time"
		}
		if t.After(now.Add(bootstrapReapSkewMargin)) {
			return time.Time{}, false, fmt.Sprintf("the Application has a write time in the future (%s, runner clock %s)",
				t.UTC().Format(time.RFC3339), now.UTC().Format(time.RFC3339))
		}
		if t.After(cutoff) {
			cutoff = t
		}
	}
	return cutoff.Add(-bootstrapReapSkewMargin), true, ""
}

// activeBootstrapJob reports the name of a bootstrap Job (a PreSync hook named with the bootstrap
// prefix) in a Job list that has not finished: it has active pods, or carries no Complete/Failed
// condition yet. "" means none is active. Pure.
func activeBootstrapJob(items []reapObject) string {
	for _, j := range items {
		m := j.Metadata
		if !strings.HasPrefix(m.Name, manifests.BootstrapJobNamePrefix) || m.Annotations[argoHookAnnotation] != manifests.BootstrapHookPhase {
			continue
		}
		finished := false
		for _, c := range j.Status.Conditions {
			if (c.Type == "Complete" || c.Type == "Failed") && c.Status == "True" {
				finished = true
			}
		}
		if j.Status.Active > 0 || !finished {
			return m.Name
		}
	}
	return ""
}

// reapStrandedBootstrapHooks requests deletion of the bootstrap-only hooks in namespace that outlived
// the apps Application's operations (see the file comment), and returns how many deletions it
// requested. Best-effort: every failure is logged and reaps nothing more, so it can never fail a
// deploy or a drift job. Logs name objects only; nothing it reads carries a credential value.
func reapStrandedBootstrapHooks(ctx context.Context, appName, namespace string, stdout, stderr io.Writer) int {
	raw, err := bootstrapReapKubectl(ctx, "", "get", "applications.argoproj.io", appName, "-n", "argocd", "-o", "json", "--show-managed-fields")
	if err != nil {
		fmt.Fprintf(stderr, "Warning: stranded bootstrap hook check skipped (could not read the %s Application): %v\n", appName, err)
		return 0
	}
	cutoff, ok, reason := strandedHookCutoff([]byte(raw), reapNow())
	if !ok {
		fmt.Fprintf(stdout, "Stranded bootstrap hook check: nothing removed (%s).\n", reason)
		return 0
	}
	jobs, err := bootstrapReapKubectl(ctx, "", "get", "jobs.batch", "-n", namespace, "-o", "json")
	var jobList struct {
		Items []reapObject `json:"items"`
	}
	if err == nil {
		err = json.Unmarshal([]byte(jobs), &jobList)
	}
	if err != nil {
		fmt.Fprintf(stderr, "Warning: stranded bootstrap hook check skipped (could not read the Jobs in %s): %v\n", namespace, err)
		return 0
	}
	if name := activeBootstrapJob(jobList.Items); name != "" {
		fmt.Fprintf(stdout, "Stranded bootstrap hook check: nothing removed (bootstrap Job %s/%s is still active).\n", namespace, name)
		return 0
	}
	selector := manifests.BootstrapOnlyLabelKey + "=" + manifests.BootstrapOnlyLabelValue
	requested := 0
	for _, kind := range bootstrapReapKinds {
		listed, err := bootstrapReapKubectl(ctx, "", "get", kind.resource, "-n", namespace, "-l", selector, "-o", "json")
		if err != nil {
			// An absent CRD (no External Secrets Operator on this cluster) lands here too, and is not
			// an error worth more than a line.
			fmt.Fprintf(stderr, "Warning: could not list bootstrap-only %s: %v\n", kind.resource, err)
			continue
		}
		var list struct {
			Items []reapObject `json:"items"`
		}
		if err := json.Unmarshal([]byte(listed), &list); err != nil {
			fmt.Fprintf(stderr, "Warning: could not parse the bootstrap-only %s list: %v\n", kind.resource, err)
			continue
		}
		for _, obj := range list.Items {
			if reapOne(ctx, kind, obj, namespace, cutoff, stderr) {
				fmt.Fprintf(stdout, "Deletion requested for stranded bootstrap hook %s %s/%s (its operation ended without running a delete policy).\n", kind.resource, namespace, obj.Metadata.Name)
				requested++
			}
		}
	}
	return requested
}

// isRenderedBootstrapHook reports whether a listed object is exactly a rendered bootstrap hook of
// kind in namespace — defence in depth, so the label alone never selects an object.
func isRenderedBootstrapHook(kind bootstrapReapKind, obj reapObject, namespace string) bool {
	m := obj.Metadata
	return m.Namespace == namespace &&
		reapNameRE.MatchString(m.Name) && kind.nameOK(m.Name) &&
		reapUIDRE.MatchString(m.UID) &&
		kind.apiVersionRE.MatchString(obj.APIVersion) &&
		m.Annotations[argoHookAnnotation] == manifests.BootstrapHookPhase &&
		m.Annotations[argoHookDeletePolicyAnnotation] == manifests.BootstrapAdminHookDeletePolicy
}

// reapOne requests deletion of one listed hook when it predates cutoff and is a rendered bootstrap
// hook, UID-guarded. It reports whether the delete was accepted.
func reapOne(ctx context.Context, kind bootstrapReapKind, obj reapObject, namespace string, cutoff time.Time, stderr io.Writer) bool {
	m, resource := obj.Metadata, kind.resource
	created, err := time.Parse(time.RFC3339, m.CreationTimestamp)
	if err != nil || !created.Before(cutoff) {
		return false // possibly created by an operation that started after the Application read
	}
	if !isRenderedBootstrapHook(kind, obj, namespace) {
		fmt.Fprintf(stderr, "Warning: bootstrap-only %s %q skipped: not a rendered bootstrap hook\n", resource, m.Name)
		return false
	}
	for i, f := range m.Finalizers {
		if f != argoHookFinalizer {
			continue
		}
		patch := fmt.Sprintf(`[{"op":"test","path":"/metadata/uid","value":%q},{"op":"test","path":"/metadata/finalizers/%d","value":%q},{"op":"remove","path":"/metadata/finalizers/%d"}]`,
			m.UID, i, argoHookFinalizer, i)
		if _, err := bootstrapReapKubectl(ctx, "", "patch", resource, m.Name, "-n", namespace, "--type=json", "-p", patch); err != nil {
			fmt.Fprintf(stderr, "Warning: could not release the hook finalizer on %s %s/%s: %v\n", resource, namespace, m.Name, err)
			return false
		}
		break
	}
	opts := fmt.Sprintf(`{"kind":"DeleteOptions","apiVersion":"v1","propagationPolicy":"Foreground","preconditions":{"uid":%q}}`, m.UID)
	if _, err := bootstrapReapKubectl(ctx, opts, "delete", "--raw", kind.path(obj.APIVersion, namespace, m.Name), "-f", "-"); err != nil {
		fmt.Fprintf(stderr, "Warning: could not delete %s %s/%s: %v\n", resource, namespace, m.Name, err)
		return false
	}
	return true
}
