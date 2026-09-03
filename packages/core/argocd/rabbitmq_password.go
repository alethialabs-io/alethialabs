// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Reconciling a Hetzner `queue` node's BROKER to its credential Secret — #3590.
//
// #3304 made the Secret the store of record for a queue's password and stopped the chart rewriting
// it. That is not enough on a cluster that deployed BEFORE it, and the reason is a RabbitMQ
// property rather than anything this repo did:
//
//	`definitions.enabled` is false for these releases, so the ONLY thing that ever sets the user's
//	password is `RABBITMQ_DEFAULT_PASS` — and RabbitMQ honours that only while the Mnesia database
//	is EMPTY, i.e. on the queue's very first boot.
//
// Before #3304, ArgoCD rewrote that Secret on every reconcile. So on any queue that has been up for
// more than one reconcile, the broker still accepts the password from its FIRST boot while the
// Secret holds whatever the last selfHeal wrote — and `ReadDataEndpoints` publishes that Secret to
// the console as the queue's credential. An application that resolves the binding and authenticates
// with the published password fails. The value the broker does accept was overwritten long ago and
// cannot be recovered.
//
// So the reconciliation has to run the other way: make the BROKER match the Secret.
//
// ── Why not the declarative route ───────────────────────────────────────────────────────────────
//
// The chart exposes `definitions.existingSecret` and its values file shows exactly the shape that
// looks like the answer — `users: [{name, password_hash, hashing_algorithm}]` — with an autoReload
// sidecar on top. It is a dead end, and it was checked before any of this was written:
// https://www.rabbitmq.com/docs/definitions states "The definitions in the file will not overwrite
// anything already in the broker." Import is ADDITIVE. A user that already exists keeps the
// password it already has, which is the entire problem here.
//
// ── Why `rabbitmqctl`, and why no credential rides the command ──────────────────────────────────
//
// `rabbitmqctl` authenticates to the node with the ERLANG COOKIE, not with the user's password
// (https://www.rabbitmq.com/docs/man/rabbitmqctl.8), so it works precisely when the password is
// unknown — which is the situation by definition.
//
// The pod already holds both values in its environment, wired by the chart from the very Secret
// this reconciles to. So the command names environment VARIABLES and the container supplies the
// values: nothing reaches the runner's argv, the job log, or the config snapshot. (The password
// does appear in the container's own process list for the life of the call — `change_password`
// takes it as an argument and has no stdin form — which is a smaller exposure than the alternatives
// and is stated rather than glossed.)
//
// CONVERGENCE, NOT ROTATION. It sets the broker to the value the Secret already holds, so it is
// idempotent, it is a no-op on a queue whose password is already right, and it also repairs a
// password somebody changed by hand.

// queueBrokerContainer is the chart's container name. Named explicitly rather than left to
// kubectl's "first container" default: the release also runs an `init-erlang-cookie` init container
// today and an autoReload sidecar is one values flag away, and exec'ing into the wrong one fails in
// a way that reads like a broken broker.
const queueBrokerContainer = "rabbitmq"

// queuePasswordScript is the shell that runs INSIDE the broker container. It is a package-level
// constant so a test can execute it under a real `sh` rather than assert on its text — the two
// failures below are properties of how a shell behaves, and a substring check would pass on a
// script that had stopped having them.
//
// SINGLE-QUOTED at the call site on purpose. utils.ExecuteCommand runs the whole thing through
// `bash -c`, which strips the outer quotes and hands this string to the container's `sh` WITHOUT
// expanding `$…` — so both variables are resolved inside the pod, from the environment the chart
// populated out of the Secret. Double quotes there would expand them in the RUNNER, where they are
// empty, and would blank the broker's password while reporting success. (It therefore contains no
// single quote of its own, and cannot.)
//
// THE EMPTY GUARD IS NOT BELT-AND-BRACES. `change_password "" ""` is the same catastrophe as the
// double-quoted mistake, reached by a route that mistake's reasoning does not cover: these two
// names are an assumption about an UPSTREAM chart. `RABBITMQ_DEFAULT_USER` / `_PASS` are the
// official image's variables and `cloudpirates/rabbitmq` wires them today, but nothing in this
// repository pins that — the names appear in no values file, no manifest and no other Go file, so
// if the chart renames them or stops exporting them to this container, `sh` substitutes empty
// strings and this silently blanks the credential of a queue that was working. A guard is the only
// thing standing between an upstream rename and that outcome, and it costs one line.
//
// `exit 78` (EX_CONFIG) rather than 1, so the deploy log distinguishes "this container is not
// shaped the way we thought" from "rabbitmqctl refused".
const queuePasswordScript = `if [ -z "$RABBITMQ_DEFAULT_USER" ] || [ -z "$RABBITMQ_DEFAULT_PASS" ]; then ` +
	`echo "refusing to change the password: RABBITMQ_DEFAULT_USER/RABBITMQ_DEFAULT_PASS are not both set in this container" >&2; ` +
	`exit 78; fi; ` +
	`rabbitmqctl change_password "$RABBITMQ_DEFAULT_USER" "$RABBITMQ_DEFAULT_PASS"`

// ConvergeQueuePassword makes the running broker accept the password in the queue's credential
// Secret.
//
// Returns nil when there is no Ready broker to talk to — that is the ordinary state on the deploy
// that CREATES a queue (the broker takes the Secret's password on its first boot anyway, so there
// is nothing to reconcile), and the next deploy re-runs this. It is reported rather than passed
// over in silence, because "no broker yet" and "converged" must not look alike in a job log.
func ConvergeQueuePassword(q HetznerQueue, stdout, stderr io.Writer) error {
	if !q.valid() {
		return fmt.Errorf("refusing to reconcile the broker password for invalid queue %q/%q", q.Namespace, q.Name)
	}
	release := AddOnAppName(q.AddOnID)
	if !k8sNameRe.MatchString(release) {
		return fmt.Errorf("refusing to reconcile the broker password for queue %q: %q is not a valid release name", q.Name, release)
	}
	pod, err := readyQueueBrokerPod(q, release, stderr)
	if err != nil {
		return err
	}
	if pod == "" {
		fmt.Fprintf(stderr, "No Ready broker pod for queue %s (namespace %s) — its password was NOT reconciled "+
			"against %s. Harmless on the deploy that creates the queue, since the broker takes the Secret's "+
			"password on its first boot; the next deploy re-runs this.\n",
			q.Name, q.Namespace, q.CredentialSecretName())
		return nil
	}
	fmt.Fprintf(stdout, "Reconciling queue %s's broker password to %s/%s...\n",
		q.Name, q.Namespace, q.CredentialSecretName())
	// See queuePasswordScript for why the quoting is what it is, and why it guards its own inputs.
	cmd := fmt.Sprintf(
		`kubectl exec %s -n %s -c %s -- sh -c '%s'`,
		pod, q.Namespace, queueBrokerContainer, queuePasswordScript,
	)
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("reconcile the broker password for queue %s: %w", q.Name, err)
	}
	return nil
}

// readyQueueBrokerPod returns the name of a pod whose broker container is Ready, or "" when there is
// none. An unreadable listing is an ERROR rather than "no pod": the two mean different things, and
// reporting a failed read as an absence is how a deploy silently stops reconciling.
func readyQueueBrokerPod(q HetznerQueue, release string, stderr io.Writer) (string, error) {
	var pods struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Phase             string `json:"phase"`
				ContainerStatuses []struct {
					Name  string `json:"name"`
					Ready bool   `json:"ready"`
				} `json:"containerStatuses"`
			} `json:"status"`
		} `json:"items"`
	}
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get pod -n %s -l app.kubernetes.io/instance=%s -o json", q.Namespace, release),
		".", nil,
	)
	if err != nil {
		return "", fmt.Errorf("list broker pods for queue %s: %w", q.Name, err)
	}
	if err := json.Unmarshal([]byte(raw), &pods); err != nil {
		return "", fmt.Errorf("decode broker pods for queue %s: %w", q.Name, err)
	}
	for _, item := range pods.Items {
		if item.Status.Phase != "Running" {
			continue
		}
		// READY, not merely Running. A broker still replaying its Mnesia log answers the CLI port
		// with a connection refused, and the failure reads like a wrong erlang cookie.
		for _, cs := range item.Status.ContainerStatuses {
			if cs.Name != queueBrokerContainer || !cs.Ready {
				continue
			}
			// The name comes back from the API server, which already constrains it — but it
			// interpolates into a command string this package runs through `bash -c`, and a
			// shell-command builder does not get to assume somebody upstream checked.
			if !k8sNameRe.MatchString(item.Metadata.Name) {
				fmt.Fprintf(stderr, "Warning: skipping broker pod %q for queue %s — not a name this can safely exec into\n",
					item.Metadata.Name, q.Name)
				continue
			}
			return item.Metadata.Name, nil
		}
	}
	return "", nil
}
