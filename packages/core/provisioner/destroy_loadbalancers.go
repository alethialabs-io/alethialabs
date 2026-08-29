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
// open — the timeout expires, `tofu destroy` runs anyway, and whatever the destroy cannot remove is
// left to the sweeper, exactly as before this existed.
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

// listCloudBackedObjects reads both kinds. A kind the cluster does not serve — no Ingress API on a
// stripped cluster — is not an error and contributes nothing.
func listCloudBackedObjects(ctx context.Context) ([]cloudBackedObject, error) {
	svcOut, err := runKubectlBounded(ctx, lbKubectlTimeout, "get", "services", "--all-namespaces", "-o", "json")
	if err != nil {
		// The Services API is not optional. Failing to read it means the cluster is unreachable,
		// which the caller reports and treats as "skip", never as "there are none".
		return nil, fmt.Errorf("list services: %w", err)
	}
	objs, err := parseLoadBalancerServices([]byte(svcOut))
	if err != nil {
		return nil, fmt.Errorf("parse services: %w", err)
	}
	ingOut, ingErr := runKubectlBounded(ctx, lbKubectlTimeout, "get", "ingresses", "--all-namespaces", "-o", "json")
	if ingErr == nil {
		ings, perr := parseIngresses([]byte(ingOut))
		if perr != nil {
			return nil, fmt.Errorf("parse ingresses: %w", perr)
		}
		objs = append(objs, ings...)
	}
	return objs, nil
}

// releaseCloudLoadBalancers deletes the in-cluster objects that own cloud load balancers and waits
// for their controllers to release the cloud resources.
//
// BEST EFFORT BY CONTRACT. It returns an error only so the caller can SAY what happened; the caller
// must not abort a teardown on it. A destroy that refuses to start because it could not tidy up
// first is worse than the bug this fixes — and the common case for a repeated destroy is a cluster
// that is already gone, where there is nothing to tidy and nothing to reach.
func releaseCloudLoadBalancers(ctx context.Context, out io.Writer) error {
	objs, err := listCloudBackedObjects(ctx)
	if err != nil {
		return err
	}
	if len(objs) == 0 {
		fmt.Fprintln(out, "   No LoadBalancer Services or Ingresses — nothing outside the state file to release.")
		return nil
	}

	names := make([]string, 0, len(objs))
	for _, o := range objs {
		names = append(names, o.String())
	}
	fmt.Fprintf(out, "   Releasing %d cloud-backed object(s) before destroy: %s\n", len(objs), strings.Join(names, ", "))

	for _, o := range objs {
		if _, derr := runKubectlBounded(ctx, lbKubectlTimeout,
			"delete", o.Kind, o.Name, "-n", o.Namespace, "--ignore-not-found", "--wait=false"); derr != nil {
			// Named, and NOT fatal: one object we cannot delete still leaves the others worth
			// waiting for, and the sweeper remains the guarantee for whatever is left.
			fmt.Fprintf(out, "   Warning: could not delete %s: %v\n", o, derr)
		}
	}

	// The finalizer is the clock. Each object survives its own deletion until the controller has
	// removed the cloud resource, so waiting for the objects to disappear IS waiting for the load
	// balancers to be released.
	started := time.Now()
	deadline := started.Add(lbReleaseTimeout)
	for {
		remaining, lerr := listCloudBackedObjects(ctx)
		if lerr != nil {
			// The cluster went away mid-wait, which on a teardown is a perfectly good outcome:
			// there is nothing left to hold anything.
			fmt.Fprintf(out, "   Cluster no longer reachable after %s (%v) — proceeding to destroy.\n",
				time.Since(started).Round(time.Second), lerr)
			return nil
		}
		if len(remaining) == 0 {
			fmt.Fprintf(out, "   All cloud-backed objects released after %s.\n", time.Since(started).Round(time.Second))
			return nil
		}
		if time.Now().After(deadline) {
			// SAID, with the names. `tofu destroy` is about to fail on whatever these are holding,
			// and this line is the difference between seven subnet DependencyViolations with no
			// cause and seven with one.
			left := make([]string, 0, len(remaining))
			for _, o := range remaining {
				left = append(left, o.String())
			}
			return fmt.Errorf("%d object(s) still held after %s: %s — their controllers have not "+
				"released the cloud load balancers, and the destroy that follows will fail on "+
				"whatever those are attached to",
				len(remaining), lbReleaseTimeout, strings.Join(left, ", "))
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("context ended while waiting for %d object(s) to be released: %w", len(remaining), ctx.Err())
		case <-time.After(lbReleasePoll):
		}
	}
}
