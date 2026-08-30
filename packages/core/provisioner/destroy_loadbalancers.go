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

// stopArgoCDReconciling deletes every ArgoCD Application before anything else is touched.
//
// ⚠️ WITHOUT THIS THE REST OF THE FILE IS WORSE THAN USELESS. The add-ons that own these load
// balancers run under Applications rendered `automated: {prune: true, selfHeal: true}`
// (argocd/addons.go), beneath an app-of-apps that is also self-healing. So `kubectl delete svc` is
// out-of-band DRIFT: the application controller re-creates the Service within seconds, the cloud
// controller manager creates a NEW load balancer, and the wait below burns its whole budget while
// the environment ends up with MORE orphans than it started with — the original released, a
// replacement created.
//
// This repo already states the invariant on the placed path: runNamespaceDestroy deletes "the
// Application first — otherwise ArgoCD re-syncs the tenant's resources into the namespace", with
// tests pinning it. The dedicated path needs the same and did not have it.
//
// `--wait=false`: an Application carries `resources-finalizer.argocd.argoproj.io` and survives its
// own deletion until ArgoCD has removed everything it manages — which is exactly the cascade we
// want, but waiting for it here would serialise the whole add-on set behind one slow chart. Marking
// them for deletion is enough to stop reconciliation; the wait that matters is the one on the
// objects that hold cloud resources.
func stopArgoCDReconciling(ctx context.Context, out io.Writer) {
	if _, err := runKubectlBounded(ctx, lbKubectlTimeout,
		"delete", "applications.argoproj.io", "--all-namespaces", "--all", "--ignore-not-found", "--wait=false"); err != nil {
		if noIngressAPI(err) {
			fmt.Fprintln(out, "   No ArgoCD Applications on this cluster (no CRD) — nothing to stop reconciling.")
			return
		}
		// NAMED and not fatal, because it is the most likely reason the wait below fails: anything
		// still reconciling will put back whatever is deleted next.
		fmt.Fprintf(out, "   Warning: could not delete ArgoCD Applications (%v) — anything still "+
			"reconciling will re-create the objects deleted below.\n", err)
		return
	}
	fmt.Fprintln(out, "   ArgoCD Applications marked for deletion (they self-heal what follows otherwise).")
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
	// Clean is true only when every cloud-backed object was released, or there were none. It is the
	// ONE field the retry is allowed to branch on: retrying a destroy without having changed
	// anything is just paying twice for the same failure.
	Clean bool
	// Remaining names what was still holding a cloud load balancer when we stopped waiting.
	Remaining []cloudBackedObject
	// Unknown records that the cluster stopped answering, so Remaining is not a complete list —
	// "we could not look" and "there is nothing there" are the two answers this file exists to keep
	// apart.
	Unknown bool
	// Skipped records why the step did not run at all (no cluster access, no state outputs). It is
	// not Clean: nothing was established.
	Skipped string
}

// billingWarning renders the block appended to a failed destroy's error, or "" when there is
// nothing to warn about.
//
// ⚠️ THE ONLY BACKSTOP A CUSTOMER HAS. The scope-locked sweepers that catch this in CI are
// `scripts/e2e/*-cleanup.sh`, invoked by the e2e workflow; nothing in apps/runner or packages/core
// sweeps cloud load balancers after a failed destroy. So on a customer's teardown this text is the
// whole signal that something is still running and still charging — which is why it names the
// objects, says nothing will remove them, and gives the two ways out.
func (r releaseOutcome) billingWarning() string {
	if r.Clean {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n⚠️  CLOUD LOAD BALANCERS MAY STILL EXIST AND STILL BILL.\n")
	switch {
	case r.Skipped != "":
		fmt.Fprintf(&b, "The pre-destroy release did not run: %s. Anything this environment exposed "+
			"through a Service of type LoadBalancer or an Ingress owns a cloud load balancer that is "+
			"not in the state file, so `tofu destroy` cannot remove it.\n", r.Skipped)
	case r.Unknown:
		b.WriteString("The cluster stopped answering while the release was waiting, so what follows " +
			"is not a complete list — there may be more.\n")
	}
	if len(r.Remaining) > 0 {
		names := make([]string, 0, len(r.Remaining))
		for _, o := range r.Remaining {
			names = append(names, o.String())
		}
		fmt.Fprintf(&b, "Still holding one when the destroy ran: %s.\n", strings.Join(names, ", "))
	}
	b.WriteString("NOTHING SWEEPS THESE AUTOMATICALLY. Either delete those objects from the cluster " +
		"and run the destroy again, or delete the load balancers in the cloud console directly.")
	return b.String()
}

// releaseCloudLoadBalancers deletes the in-cluster objects that own cloud load balancers and waits
// for their controllers to release the cloud resources.
//
// BEST EFFORT BY CONTRACT. It returns an error only so the caller can SAY what happened; the caller
// must not abort a teardown on it. A destroy that refuses to start because it could not tidy up
// first is worse than the bug this fixes — and the common case for a repeated destroy is a cluster
// that is already gone, where there is nothing to tidy and nothing to reach.
func releaseCloudLoadBalancers(ctx context.Context, out io.Writer) (releaseOutcome, error) {
	// FIRST, always — before anything is listed, let alone deleted.
	stopArgoCDReconciling(ctx, out)

	objs, err := listCloudBackedObjects(ctx)
	if err != nil {
		return releaseOutcome{Unknown: true}, err
	}
	if len(objs) == 0 {
		fmt.Fprintln(out, "   No LoadBalancer Services or Ingresses — nothing outside the state file to release.")
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
			fmt.Fprintf(out, "   All cloud-backed objects released after %s.\n", time.Since(started).Round(time.Second))
			return releaseOutcome{Clean: true}, nil
		default:
			lastErr, consecutiveErrs = nil, 0
			// Quietly, because a warning per object per poll would bury the outcome.
			deleteAll(ctx, out, remaining, true)
		}
		if time.Now().After(deadline) {
			if lastErr != nil {
				return releaseOutcome{Unknown: true, Remaining: remaining}, fmt.Errorf("could not confirm the load balancers were released: the cluster "+
					"has been unreachable for the last %d poll(s) over %s (%w) — if it is gone, so "+
					"are they; if it is throttling, they may still be live and the destroy that "+
					"follows will fail on whatever they are attached to",
					consecutiveErrs, lbReleaseTimeout, lastErr)
			}
			left := make([]string, 0, len(remaining))
			for _, o := range remaining {
				left = append(left, o.String())
			}
			return releaseOutcome{Remaining: remaining}, fmt.Errorf("%d object(s) still held after %s: %s — their controllers have not "+
				"released the cloud load balancers, and the destroy that follows will fail on "+
				"whatever those are attached to",
				len(remaining), lbReleaseTimeout, strings.Join(left, ", "))
		}
		select {
		case <-ctx.Done():
			return releaseOutcome{Unknown: true, Remaining: remaining}, fmt.Errorf("context ended while waiting for the load balancers to be released: %w", ctx.Err())
		case <-time.After(lbReleasePoll):
		}
	}
}
