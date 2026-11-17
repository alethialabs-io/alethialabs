// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/format"
)

// KUBERNETES CREATES CLOUD RESOURCES THAT OPENTOFU HAS NEVER HEARD OF, AND THE DESTROY MUST
// REMOVE THEM FIRST.
//
// A `Service` of type LoadBalancer is an ELB / a forwarding rule / a Load Balancer, created by the
// cloud controller manager. An `Ingress`, under a controller like the AWS Load Balancer Controller,
// is another. None of them is in the state file, so `tofu destroy` deletes what it owns, reaches
// the network those objects are still attached to, and stops.
//
// MEASURED — aws/addons run 33262881462. Every Application converged; the teardown then produced
//
//	Error: deleting EC2 Subnet (subnet-0e23a257bb24a4a9d): DependencyViolation
//	Error: deleting EC2 Internet Gateway (igw-…): detaching from VPC (vpc-…)
//	Error: deleting ACM Certificate (…): ResourceInUseException: … is in use
//	… six more subnets
//
// and the scope-locked sweeper that runs afterwards said in one line what tofu could not:
//
//	· load balancers: 2 to delete
//
// Two ELBs from the add-on set, holding the certificate and ENIs in every subnet.
//
// It is not an AWS bug and not an e2e artifact. AWS refuses to delete a subnet with an attached
// ENI where other clouds tolerate more or release faster, so AWS is where it shows — but the orphan
// exists everywhere, and any customer with one `Service: LoadBalancer`, the ordinary way to expose
// anything, has the same resources outside their state file.
//
// ── Why deleting the OBJECT is the right signal ────────────────────────────────────────────────
//
// Both kinds carry a cleanup finalizer — `service.kubernetes.io/load-balancer-cleanup` on the
// Service, `ingress.k8s.aws/resources` on an ALB Ingress — which the controller removes only AFTER
// the cloud resource is gone. So "the object has disappeared from the API" is not a proxy for "the
// load balancer was released": it is the same fact. Nothing here polls a cloud API, and nothing
// needs cloud credentials.
//
// ── And why the ORDER is the whole design (#6970) ──────────────────────────────────────────────
//
// The finalizer is only removed by a controller that is still RUNNING. On AWS the Ingress
// controller is itself an ArgoCD Application (infra/templates/argocd/aws-load-balancer-controller.yaml),
// carrying `resources-finalizer.argocd.argoproj.io`, so deleting that Application removes the
// controller's Deployment. This file used to delete every Application FIRST — the cheapest way to
// stop self-heal — and then delete the Ingress, whose finalizer nothing was left to clear: seven
// nightly aws legs in a row waited the full four minutes on `ingress/argocd/argo-cd-argocd-server`
// and then failed `tofu destroy` on the subnets, the internet gateway and the certificate.
//
// So the two things the old first step did at once are now separate. Reconciliation is stopped by
// scaling the ArgoCD APPLICATION CONTROLLER to zero, which deletes nothing; the cloud-backed
// objects are deleted and OBSERVED GONE while every controller that can release them is still
// there; and only then are the Applications marked for deletion and the application controller
// brought back to cascade them. See releaseCloudLoadBalancers.

// lbReleaseTimeout bounds the whole wait. A controller that never releases must not hold a teardown
// open — the timeout expires and `tofu destroy` runs anyway.
//
// ⚠️ AND THERE IS NO BACKSTOP OUTSIDE CI. The scope-locked sweepers that catch this today are
// `scripts/e2e/*-cleanup.sh`, invoked by the e2e workflow; nothing in apps/runner or packages/core
// sweeps cloud load balancers after a failed destroy. So for a customer the give-up path ends in a
// failed teardown AND billing load balancers with nothing behind it — which is why the error names
// what is still held rather than saying the destroy will "probably" sort it out.
//
// A var, not a const, so a test can drive the give-up path without waiting four minutes. Nothing
// else writes it.
var lbReleaseTimeout = 4 * time.Minute

// lbReleasePoll is how often the objects are re-listed while waiting.
var lbReleasePoll = 5 * time.Second

// lbKubectlTimeout bounds one kubectl call against a cluster that is about to be destroyed and may
// already be half gone.
const lbKubectlTimeout = 30 * time.Second

// cloudBackedObject is one Kubernetes object that owns a cloud load balancer.
type cloudBackedObject struct {
	Kind      string
	Namespace string
	Name      string
}

func (o cloudBackedObject) String() string { return o.Kind + "/" + o.Namespace + "/" + o.Name }

// parseLoadBalancerServices returns the Services of type LoadBalancer in a `kubectl get svc -A -o
// json` document.
//
// Filtered HERE rather than with `--field-selector spec.type=LoadBalancer`, which the API server
// does not support for Services — asking for it fails the call, and a failed call on this path
// would read as "no load balancers" and skip the whole step.
func parseLoadBalancerServices(listJSON []byte) ([]cloudBackedObject, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
			Spec struct {
				Type string `json:"type"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return nil, err
	}
	var out []cloudBackedObject
	for _, it := range list.Items {
		if it.Spec.Type != "LoadBalancer" {
			continue
		}
		out = append(out, cloudBackedObject{Kind: "service", Namespace: it.Metadata.Namespace, Name: it.Metadata.Name})
	}
	return out, nil
}

// parseIngresses returns every Ingress in a `kubectl get ingress -A -o json` document.
//
// Every one, not only those with a load-balancer status: an Ingress whose controller has not
// finished provisioning yet still owns a partially-created cloud resource, and that is the one most
// likely to block a subnet.
func parseIngresses(listJSON []byte) ([]cloudBackedObject, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return nil, err
	}
	out := make([]cloudBackedObject, 0, len(list.Items))
	for _, it := range list.Items {
		out = append(out, cloudBackedObject{Kind: "ingress", Namespace: it.Metadata.Namespace, Name: it.Metadata.Name})
	}
	return out, nil
}

// noIngressAPI reports whether kubectl's error means the cluster does not serve Ingress at all, as
// opposed to a call that failed.
//
// The distinction is the same one the field-selector comment above is about: treating every error
// as "there are none" is how a throttled read becomes "nothing to release". kubectl says
// `the server doesn't have a resource type "ingresses"` for the first and something else for the
// second, and only the first may be swallowed.
func noIngressAPI(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, `doesn't have a resource type`) ||
		strings.Contains(msg, "the server could not find the requested resource")
}

// listCloudBackedObjects reads both kinds.
func listCloudBackedObjects(ctx context.Context) ([]cloudBackedObject, error) {
	svcOut, err := runKubectlBounded(ctx, lbKubectlTimeout, "get", "services", "--all-namespaces", "-o", "json")
	if err != nil {
		// The Services API is not optional. Failing to read it means the cluster could not be
		// asked, which the caller reports and never treats as "there are none".
		return nil, fmt.Errorf("list services: %w", err)
	}
	objs, err := parseLoadBalancerServices([]byte(svcOut))
	if err != nil {
		return nil, fmt.Errorf("parse services: %w", err)
	}
	ingOut, ingErr := runKubectlBounded(ctx, lbKubectlTimeout, "get", "ingresses", "--all-namespaces", "-o", "json")
	switch {
	case ingErr != nil && noIngressAPI(ingErr):
		// A cluster with no Ingress API contributes nothing, and that is a fact rather than a
		// failure.
	case ingErr != nil:
		return nil, fmt.Errorf("list ingresses: %w", ingErr)
	default:
		ings, perr := parseIngresses([]byte(ingOut))
		if perr != nil {
			return nil, fmt.Errorf("parse ingresses: %w", perr)
		}
		objs = append(objs, ings...)
	}
	return objs, nil
}

// argoCDNamespace is where installArgoCD puts the argo-cd release (`--namespace argocd`).
const argoCDNamespace = "argocd"

// argoCDControllerSelector matches the application controller's workload and its pods. It is the
// argo-cd chart's own `app.kubernetes.io/name` label, which does not depend on the release name —
// the workload's NAME does (`argo-cd-argocd-application-controller` here), so the name is read from
// the cluster rather than assumed.
const argoCDControllerSelector = "app.kubernetes.io/name=argocd-application-controller"

// argoCDPauseTimeout bounds the wait for the application controller's pods to terminate after the
// scale to zero. A var for the same reason lbReleaseTimeout is one.
var argoCDPauseTimeout = 90 * time.Second

// argoCDWorkload is one application-controller workload and the replica count it had before the
// pause, which is what the resume puts back.
type argoCDWorkload struct {
	Kind     string
	Name     string
	Replicas int
}

// argoCDPause is what the pause established.
type argoCDPause struct {
	// Paused is true when nothing is reconciling: the application controller was scaled to zero
	// and its pods were observed gone, or the cluster has no application controller at all.
	Paused bool
	// Workloads are the ones found, with their original replica counts.
	Workloads []argoCDWorkload
}

// parseArgoCDControllers reads the application controller's workloads out of a `kubectl get
// statefulsets.apps,deployments.apps -o json` document. Both kinds, because the chart renders a
// StatefulSet by default and a Deployment under dynamic cluster distribution.
func parseArgoCDControllers(listJSON []byte) ([]argoCDWorkload, error) {
	var list struct {
		Items []struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Replicas *int `json:"replicas"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return nil, err
	}
	out := make([]argoCDWorkload, 0, len(list.Items))
	for _, it := range list.Items {
		// An absent `spec.replicas` is the API default of one, not zero.
		replicas := 1
		if it.Spec.Replicas != nil {
			replicas = *it.Spec.Replicas
		}
		out = append(out, argoCDWorkload{Kind: strings.ToLower(it.Kind), Name: it.Metadata.Name, Replicas: replicas})
	}
	return out, nil
}

// countItems returns how many objects a `kubectl get … -o json` list document holds.
func countItems(listJSON []byte) (int, error) {
	var list struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return 0, err
	}
	return len(list.Items), nil
}

// pauseArgoCDReconciling stops ArgoCD from re-creating what the release is about to delete, WITHOUT
// removing anything ArgoCD installed.
//
// The add-ons that own load balancers run under Applications rendered `automated: {prune: true,
// selfHeal: true}` (argocd/addons.go), beneath an app-of-apps that is also self-healing. So a bare
// `kubectl delete svc` is out-of-band drift: the application controller re-creates the Service
// within seconds, the cloud controller manager creates a NEW load balancer, and the environment
// ends up with more orphans than it started with. Something has to stop reconciliation first.
//
// Scaling the application controller to zero is the form of "stop" that has no second effect. It is
// the only component that syncs, self-heals or runs an Application's deletion cascade, so with it
// gone the Applications — and every controller Deployment they installed — sit exactly as they are.
//
// The pods are WAITED for, not assumed: a controller that is still terminating can still sync.
//
// Any failure returns Paused=false after putting back whatever was already scaled, and the caller
// falls back to the previous ordering. It never returns an error because nothing here may stop a
// teardown.
func pauseArgoCDReconciling(ctx context.Context, out io.Writer) argoCDPause {
	listOut, err := runKubectlBounded(ctx, lbKubectlTimeout, "get", "statefulsets.apps,deployments.apps",
		"-n", argoCDNamespace, "-l", argoCDControllerSelector, "-o", "json")
	if err != nil {
		fmt.Fprintf(out, "   Warning: could not read the ArgoCD application controller (%v).\n", err)
		return argoCDPause{}
	}
	workloads, err := parseArgoCDControllers([]byte(listOut))
	if err != nil {
		fmt.Fprintf(out, "   Warning: could not parse the ArgoCD application controller list (%v).\n", err)
		return argoCDPause{}
	}
	if len(workloads) == 0 {
		fmt.Fprintln(out, "   No ArgoCD application controller on this cluster — nothing re-creates what is deleted next.")
		return argoCDPause{Paused: true}
	}
	pause := argoCDPause{Workloads: workloads}
	for i, w := range workloads {
		if w.Replicas == 0 {
			continue
		}
		if _, err := runKubectlBounded(ctx, lbKubectlTimeout,
			"scale", w.Kind+"/"+w.Name, "-n", argoCDNamespace, "--replicas=0"); err != nil {
			fmt.Fprintf(out, "   Warning: could not scale %s/%s to zero (%v).\n", w.Kind, w.Name, err)
			resumeArgoCDReconciling(ctx, out, argoCDPause{Workloads: workloads[:i]})
			return argoCDPause{}
		}
	}
	deadline := time.Now().Add(argoCDPauseTimeout)
	for {
		podsOut, perr := runKubectlBounded(ctx, lbKubectlTimeout, "get", "pods",
			"-n", argoCDNamespace, "-l", argoCDControllerSelector, "-o", "json")
		left := -1
		if perr == nil {
			left, perr = countItems([]byte(podsOut))
		}
		if perr == nil && left == 0 {
			fmt.Fprintln(out, "   ArgoCD application controller paused — nothing self-heals what is deleted next, "+
				"and the controllers that release load balancers keep running.")
			pause.Paused = true
			return pause
		}
		if ctx.Err() != nil || time.Now().After(deadline) {
			fmt.Fprintf(out, "   Warning: the ArgoCD application controller did not stop within %s.\n", argoCDPauseTimeout)
			resumeArgoCDReconciling(ctx, out, pause)
			return argoCDPause{}
		}
		select {
		case <-ctx.Done():
		case <-time.After(lbReleasePoll):
		}
	}
}

// resumeArgoCDReconciling scales the application controller back to what it was.
//
// It runs on a context that survives the caller's cancellation: a teardown that was cancelled
// mid-release leaves a cluster that is still serving, and that cluster must not be left with its
// GitOps controller at zero replicas. A workload that was ALREADY at zero comes back at one — the
// previous count is unknown (an earlier pass left it paused) and one is what processes deletions.
func resumeArgoCDReconciling(ctx context.Context, out io.Writer, pause argoCDPause) {
	rctx := context.WithoutCancel(ctx)
	for _, w := range pause.Workloads {
		replicas := w.Replicas
		if replicas < 1 {
			replicas = 1
		}
		if _, err := runKubectlBounded(rctx, lbKubectlTimeout,
			"scale", w.Kind+"/"+w.Name, "-n", argoCDNamespace, fmt.Sprintf("--replicas=%d", replicas)); err != nil {
			fmt.Fprintf(out, "   Warning: could not scale %s/%s back to %d (%v) — ArgoCD is not reconciling on this cluster.\n",
				w.Kind, w.Name, replicas, err)
		}
	}
}

// stopArgoCDReconciling marks every ArgoCD Application for deletion, and reports whether that
// worked (a cluster with no Application CRD counts: there is nothing to mark).
//
// ⚠️ THIS REMOVES CONTROLLERS, so it runs AFTER the cloud-backed objects are gone. An Application
// carries `resources-finalizer.argocd.argoproj.io`, and its deletion cascades to everything it
// manages — which on AWS includes the load balancer controller, the only thing that can clear an
// ALB Ingress's finalizer. Run first, it guaranteed the wait below could never finish (#6970).
// It is still the first step on ONE path: when the application controller could not be paused,
// this is the only remaining way to stop self-heal, and re-creating load balancers is the worse of
// the two failures.
//
// The cascade itself is wanted — it is what removes the rest of what ArgoCD created — which is why
// the Applications are deleted at all rather than left for the cluster's own deletion.
//
// `--wait=false`: waiting for the cascade here would serialise the whole add-on set behind one slow
// chart. Marking them is enough; the wait that matters is the one on the objects that hold cloud
// resources, and by now it is over.
func stopArgoCDReconciling(ctx context.Context, out io.Writer) bool {
	if _, err := runKubectlBounded(ctx, lbKubectlTimeout,
		"delete", "applications.argoproj.io", "--all-namespaces", "--all", "--ignore-not-found", "--wait=false"); err != nil {
		if noIngressAPI(err) {
			fmt.Fprintln(out, "   No ArgoCD Applications on this cluster (no CRD) — nothing to stop reconciling.")
			return true
		}
		// NAMED and not fatal: anything still reconciling will put back whatever was deleted.
		fmt.Fprintf(out, "   Warning: could not delete ArgoCD Applications (%v) — anything still "+
			"reconciling will re-create the objects deleted below.\n", err)
		return false
	}
	fmt.Fprintln(out, "   ArgoCD Applications marked for deletion.")
	return true
}

// deleteAll issues a delete for every object, reporting the ones it could not.
//
// RE-ISSUED ON EVERY POLL by the caller. The deletes are idempotent under `--ignore-not-found`, and
// re-issuing is what recovers a delete that failed once — an admission webhook whose pod was being
// evicted, a throttled apiserver — instead of waiting four minutes on an object nothing ever
// successfully asked to remove.
func deleteAll(ctx context.Context, out io.Writer, objs []cloudBackedObject, quiet bool) {
	for _, o := range objs {
		if _, err := runKubectlBounded(ctx, lbKubectlTimeout,
			"delete", o.Kind, o.Name, "-n", o.Namespace, "--ignore-not-found", "--wait=false"); err != nil && !quiet {
			fmt.Fprintf(out, "   Warning: could not delete %s: %v\n", o, err)
		}
	}
}

// releaseOutcome is what the release step actually established, as data rather than prose.
//
// The destroy needs three things from it and a returned error can only carry one: whether the
// blocker was cleared (may the destroy be retried?), what is still holding cloud resources (what
// does the operator go and delete?), and whether we simply could not see (a claim we must not make).
type releaseOutcome struct {
	// Clean is true only when every cloud-backed object was released, or there were none.
	Clean bool
	// Released counts what this attempt actually DELETED, and it is what separates the two facts
	// Clean folds together: "the blocker was cleared" and "there was never a blocker".
	//
	// The retry branches on Clean to decide whether to pay for a SECOND `tofu destroy` — 10-15
	// minutes, the longest thing in the job — and its own rationale is "the second release
	// positively removed what the first could not". A cluster with zero LoadBalancer Services
	// returns Clean too, so a destroy that failed for an unrelated reason bought a second full
	// destroy that changed nothing: precisely the "paying twice for the same failure" the guard
	// forbids in the sentence above it.
	Released int
	// Remaining names what was still holding a cloud load balancer when we stopped waiting.
	Remaining []cloudBackedObject
	// Unknown records that the cluster stopped answering, so Remaining is not a complete list —
	// "we could not look" and "there is nothing there" are the two answers this file exists to keep
	// apart.
	Unknown bool
	// Skipped records why the step did not run at all (no cluster access, no state outputs). It is
	// not Clean: nothing was established.
	Skipped string
	// NoCluster narrows Skipped to the one case that is PERMANENT: this environment's state names
	// no API endpoint at all, so there was never a control plane to hold a load balancer. Every
	// other skip is potentially transient — a throttled apiserver, an exec-credential refresh, a
	// state-proxy blip — and those are worth a second attempt.
	//
	// It is a separate field rather than a match on Skipped's text because the two consumers both
	// decide something expensive with it (whether to retry a destroy, whether to alarm an
	// operator), and a sentence written for a human is not a predicate. Reworded once and both
	// silently change behaviour.
	NoCluster bool
	// MintFailed records that a hetzner state carried a talosconfig but a fresh admin kubeconfig could
	// not be minted from it, so the release never ran (#5330). It is always paired with Skipped, so the
	// retry and the billing warning treat it like any other transient skip; what it adds is that
	// RunDestroy then FAILS even when `tofu destroy` succeeded. The state proved a control plane existed,
	// so "the release did not run" here is not the quiet already-gone case — it is the one where an
	// hcloud CCM load balancer is most likely still billing.
	MintFailed string
}

// billingWarning renders the block appended to a failed destroy's error, or "" when there is
// nothing to warn about.
//
// ⚠️ THE ONLY BACKSTOP A CUSTOMER HAS. The scope-locked sweepers that catch this in CI are
// `scripts/e2e/*-cleanup.sh`, invoked by the e2e workflow; nothing in apps/runner or packages/core
// sweeps cloud load balancers after a failed destroy. So on a customer's teardown this text is the
// whole signal that something is still running and still charging — which is why it names the
// objects, says nothing will remove them, and gives the two ways out.
func (r releaseOutcome) billingWarning() string { return r.warning(toneAlarm) }

// warningTone is the volume the same facts are rendered at. A destroy that FAILED and one that
// SUCCEEDED owe the reader different things about an unreleased load balancer, and the difference
// is presentation, not fact — so it is a parameter here rather than a second renderer somewhere
// else. The comment on postDestroySuccessNotice used to claim this ("they cannot drift into
// disagreeing about what is still held") while its Skipped arm hand-wrote its own sentence.
type warningTone int

const (
	toneAlarm warningTone = iota // the destroy FAILED: the loudest thing the operator will see
	toneNote                     // the destroy SUCCEEDED: say what did not happen, quietly
)

func (r releaseOutcome) warning(tone warningTone) string {
	if r.Clean {
		return ""
	}
	// A BARE Skipped — nothing observed, the cluster never went unreadable mid-wait — is the only
	// outcome whose volume the tone changes. On a succeeded destroy it is a note, and on an
	// environment that never had a control plane it is nothing at all: alarming on every repeat
	// teardown of an already-gone environment is how a reader learns to scroll past the alarm that
	// matters.
	if tone == toneNote && r.Skipped != "" && len(r.Remaining) == 0 && !r.Unknown {
		if r.NoCluster {
			return ""
		}
		return fmt.Sprintf("   Note: the pre-destroy load-balancer release did not run (%s). "+
			"Everything in the state file is gone; a Service of type LoadBalancer or an Ingress "+
			"would not have been, so check the cloud console if this environment exposed one.", r.Skipped)
	}
	var b strings.Builder
	b.WriteString("\n\n⚠️  CLOUD LOAD BALANCERS MAY STILL EXIST AND STILL BILL.\n")
	switch {
	case r.Skipped != "":
		fmt.Fprintf(&b, "The pre-destroy release did not run: %s. Anything this environment exposed "+
			"through a Service of type LoadBalancer or an Ingress owns a cloud load balancer that is "+
			"not in the state file, so `tofu destroy` cannot remove it.\n", r.Skipped)
	case r.Unknown && len(r.Remaining) > 0:
		b.WriteString("The cluster stopped answering while the release was waiting, so what follows " +
			"is not a complete list — there may be more.\n")
	case r.Unknown:
		// Reached when the cluster was unreadable from the FIRST list, so nothing was ever
		// observed. Saying "what follows is not a complete list" and then following it with
		// nothing reads as "there is nothing" — the one meaning this type exists to keep apart
		// from "we could not look".
		b.WriteString("The cluster stopped answering before anything could be listed, so this " +
			"environment's LoadBalancer Services and Ingresses are UNKNOWN — not empty.\n")
	}
	if len(r.Remaining) > 0 {
		names := make([]string, 0, len(r.Remaining))
		for _, o := range r.Remaining {
			names = append(names, o.String())
		}
		fmt.Fprintf(&b, "Still holding one when the destroy ran: %s.\n", strings.Join(names, ", "))
	}
	if len(r.Remaining) > 0 {
		b.WriteString("NOTHING SWEEPS THESE AUTOMATICALLY. Either delete those objects from the cluster " +
			"and run the destroy again, or delete the load balancers in the cloud console directly.")
	} else {
		// "delete those objects" refers to nothing when nothing was named, which leaves the reader
		// with an alarm and no first step.
		b.WriteString("NOTHING SWEEPS THESE AUTOMATICALLY. Check this environment's load balancers " +
			"in the cloud console and delete any that remain.")
	}
	return b.String()
}

// LoadBalancersStillHeldError reports that the bounded wait ended with objects that own cloud load
// balancers still present in the cluster. It is a type rather than a sentence so a caller can ask
// WHAT is held with errors.As instead of matching the wording, and it stays in the chain of the
// error RunDestroy returns when the destroy then fails.
type LoadBalancersStillHeldError struct {
	// Held names each object as kind/namespace/name, as last observed.
	Held []string
	// Waited is the bound that expired.
	Waited time.Duration
}

// Error names what is held and what follows from it.
func (e *LoadBalancersStillHeldError) Error() string {
	return fmt.Sprintf("%d object(s) still held after %s: %s — their controllers have not "+
		"released the cloud load balancers, and the destroy that follows will fail on "+
		"whatever those are attached to",
		len(e.Held), e.Waited, strings.Join(e.Held, ", "))
}

// stillHeld returns the typed form of Remaining, or nil when nothing was observed held.
func (r releaseOutcome) stillHeld() *LoadBalancersStillHeldError {
	if len(r.Remaining) == 0 {
		return nil
	}
	held := make([]string, 0, len(r.Remaining))
	for _, o := range r.Remaining {
		held = append(held, o.String())
	}
	return &LoadBalancersStillHeldError{Held: held, Waited: lbReleaseTimeout}
}

// releaseCloudLoadBalancers deletes the in-cluster objects that own cloud load balancers and waits
// for their controllers to release the cloud resources.
//
// BEST EFFORT BY CONTRACT. It returns an error only so the caller can SAY what happened; the caller
// must not abort a teardown on it. A destroy that refuses to start because it could not tidy up
// first is worse than the bug this fixes — and the common case for a repeated destroy is a cluster
// that is already gone, where there is nothing to tidy and nothing to reach.
func releaseCloudLoadBalancers(ctx context.Context, out io.Writer) (releaseOutcome, error) {
	// THE ORDER (#6970): pause reconciliation, release and OBSERVE GONE, and only then remove what
	// carries the controllers. Each later step is conditional on what the earlier one established.
	pause := pauseArgoCDReconciling(ctx, out)
	if !pause.Paused {
		// The one path that still deletes the Applications first. Self-heal could not be stopped
		// any other way, and a release that re-creates load balancers behind itself is worse than
		// one that may leave an Ingress its controller can no longer finalize — said out loud,
		// because that is exactly what the wait below will then report.
		fmt.Fprintln(out, "   Falling back to deleting the ArgoCD Applications first. That also removes any "+
			"load-balancer controller ArgoCD installed, so an Ingress it owns may not be released.")
		stopArgoCDReconciling(ctx, out)
		return deleteAndAwaitCloudBackedObjects(ctx, out)
	}
	rel, err := deleteAndAwaitCloudBackedObjects(ctx, out)
	switch {
	case rel.Clean:
		// Marked BEFORE the controller comes back, so it returns to Applications that are already
		// deleting and cascades them; it never gets a pass in which to re-create anything.
		if stopArgoCDReconciling(ctx, out) {
			resumeArgoCDReconciling(ctx, out, pause)
		} else {
			fmt.Fprintln(out, "   Leaving the ArgoCD application controller paused: resuming it over "+
				"Applications that could not be deleted would re-create what was just released.")
		}
	case ctx.Err() != nil:
		// A cancelled teardown leaves a cluster that still serves. Put its GitOps controller back
		// and leave its Applications alone.
		resumeArgoCDReconciling(ctx, out, pause)
	default:
		// Something is still held, or the cluster could not be read. The controllers that can
		// release it are intact ONLY while the Applications are, so nothing is marked and nothing
		// is resumed: a retry then gets a fresh window against a cluster that can still finish.
		fmt.Fprintln(out, "   Leaving the ArgoCD Applications in place and the application controller paused, "+
			"so the controllers that release load balancers stay installed for a retry.")
	}
	return rel, err
}

// deleteAndAwaitCloudBackedObjects lists the objects that own cloud load balancers, deletes them and
// waits, bounded by lbReleaseTimeout, until the cluster no longer lists any.
func deleteAndAwaitCloudBackedObjects(ctx context.Context, out io.Writer) (releaseOutcome, error) {
	objs, err := listCloudBackedObjects(ctx)
	if err != nil {
		return releaseOutcome{Unknown: true}, err
	}
	if len(objs) == 0 {
		fmt.Fprintln(out, "   No LoadBalancer Services or Ingresses — nothing outside the state file to release.")
		// Released stays 0: nothing was cleared, because nothing was held.
		return releaseOutcome{Clean: true}, nil
	}

	names := make([]string, 0, len(objs))
	for _, o := range objs {
		names = append(names, o.String())
	}
	fmt.Fprintf(out, "   Releasing %d cloud-backed object(s) before destroy: %s\n", len(objs), strings.Join(names, ", "))
	deleteAll(ctx, out, objs, false)

	// The finalizer is the clock. Each object survives its own deletion until the controller has
	// removed the cloud resource, so waiting for the objects to disappear IS waiting for the load
	// balancers to be released.
	started := time.Now()
	deadline := started.Add(lbReleaseTimeout)
	var lastErr error
	consecutiveErrs := 0
	// The last list we actually got an answer to. `remaining` is nil on every error path, because
	// listCloudBackedObjects returns `nil, err` — so reporting `remaining` when the cluster stopped
	// answering names NOTHING, on exactly the path where the operator most needs a starting point.
	// This is what the billing warning is allowed to print: objects we really saw, stale by at most
	// one poll, rather than an empty list dressed up as an incomplete one.
	lastKnown := objs
	for {
		remaining, lerr := listCloudBackedObjects(ctx)
		switch {
		case lerr != nil:
			// NOT reported as success. A teardown is exactly when an apiserver throttles, a control
			// plane restarts, or an exec-credential refresh blips — and calling any of those
			// "the cluster is gone, therefore released" would claim a release over live load
			// balancers. Keep asking until the deadline, then say it could not be confirmed.
			lastErr, consecutiveErrs = lerr, consecutiveErrs+1
		case len(remaining) == 0:
			fmt.Fprintf(out, "   All cloud-backed objects released after %s.\n", format.Duration(time.Since(started)))
			return releaseOutcome{Clean: true, Released: len(objs)}, nil
		default:
			lastErr, consecutiveErrs = nil, 0
			lastKnown = remaining
			// Quietly, because a warning per object per poll would bury the outcome.
			deleteAll(ctx, out, remaining, true)
		}
		if time.Now().After(deadline) {
			if lastErr != nil {
				return releaseOutcome{Unknown: true, Remaining: lastKnown}, fmt.Errorf("could not confirm the load balancers were released: the cluster "+
					"has been unreachable for the last %d poll(s) over %s (%w) — if it is gone, so "+
					"are they; if it is throttling, they may still be live and the destroy that "+
					"follows will fail on whatever they are attached to",
					consecutiveErrs, lbReleaseTimeout, lastErr)
			}
			// `remaining` is non-empty here: an empty list returned above, and an unreadable one
			// took the branch before this.
			rel := releaseOutcome{Remaining: remaining}
			return rel, error(rel.stillHeld())
		}
		select {
		case <-ctx.Done():
			return releaseOutcome{Unknown: true, Remaining: lastKnown}, fmt.Errorf("context ended while waiting for the load balancers to be released: %w", ctx.Err())
		case <-time.After(lbReleasePoll):
		}
	}
}
