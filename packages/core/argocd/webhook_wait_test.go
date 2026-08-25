// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

// ingressNginxMidPatch is the state that broke hetzner/addons: the chart has created the
// ValidatingWebhookConfiguration and the patch Job has not yet filled in the caBundle. An
// Ingress created in this window is refused with `x509: certificate signed by unknown authority`.
const ingressNginxMidPatch = `{"items":[
 {"metadata":{"name":"ingress-nginx-admission"},
  "webhooks":[{"name":"validate.nginx.ingress.kubernetes.io",
   "clientConfig":{"caBundle":"","service":{"namespace":"ingress-nginx","name":"ingress-nginx-controller-admission"}}}]}
]}`

// ingressNginxPatched is the same webhook once the patch Job has run.
const ingressNginxPatched = `{"items":[
 {"metadata":{"name":"ingress-nginx-admission"},
  "webhooks":[{"name":"validate.nginx.ingress.kubernetes.io",
   "clientConfig":{"caBundle":"LS0tLS1CRUdJTg==","service":{"namespace":"ingress-nginx","name":"ingress-nginx-controller-admission"}}}]}
]}`

func decodeList(t *testing.T, raw string) webhookConfigList {
	t.Helper()
	var l webhookConfigList
	if err := json.Unmarshal([]byte(raw), &l); err != nil {
		t.Fatalf("fixture does not decode: %v", err)
	}
	return l
}

func TestUnservableWebhooks(t *testing.T) {
	t.Run("THE REGRESSION: an empty caBundle is not servable", func(t *testing.T) {
		unservable, backings := unservableWebhooks(decodeList(t, ingressNginxMidPatch))
		if len(unservable) != 1 {
			t.Fatalf("want the ingress-nginx webhook reported unservable, got %v", unservable)
		}
		if !strings.Contains(unservable[0], "ingress-nginx-admission") || !strings.Contains(unservable[0], "caBundle") {
			t.Errorf("the finding must name the webhook and why: %q", unservable[0])
		}
		// A webhook that is not servable must not ALSO be queued for an endpoint check —
		// its readiness is already decided.
		if len(backings) != 0 {
			t.Errorf("an unservable webhook must not contribute a backing to check: %v", backings)
		}
	})

	t.Run("a patched caBundle moves it to the endpoint check", func(t *testing.T) {
		unservable, backings := unservableWebhooks(decodeList(t, ingressNginxPatched))
		if len(unservable) != 0 {
			t.Fatalf("a patched webhook must not be unservable: %v", unservable)
		}
		if len(backings) != 1 || backings[0].Namespace != "ingress-nginx" {
			t.Fatalf("the backing Service must be queued for an endpoint check, got %v", backings)
		}
	})

	t.Run("a URL-backed webhook is ignored in BOTH directions", func(t *testing.T) {
		// Served from outside the cluster: nothing this deploy does can make it ready, so
		// blocking a wave on one would hang every install in a cluster that has an external
		// policy webhook. It must contribute neither a finding nor a backing.
		raw := `{"items":[{"metadata":{"name":"external-policy"},
		  "webhooks":[{"name":"corp.example.com","clientConfig":{"caBundle":""}}]}]}`
		unservable, backings := unservableWebhooks(decodeList(t, raw))
		if len(unservable) != 0 || len(backings) != 0 {
			t.Errorf("a URL-backed webhook must be ignored, got unservable=%v backings=%v", unservable, backings)
		}
	})

	t.Run("no webhooks at all is servable, and says what it checked", func(t *testing.T) {
		unservable, backings := unservableWebhooks(decodeList(t, `{"items":[]}`))
		if len(unservable) != 0 || len(backings) != 0 {
			t.Errorf("an empty cluster has nothing to wait for, got %v / %v", unservable, backings)
		}
	})

	t.Run("one backing Service is de-duplicated across webhooks", func(t *testing.T) {
		raw := `{"items":[{"metadata":{"name":"c"},"webhooks":[
		  {"name":"a","clientConfig":{"caBundle":"x","service":{"namespace":"ns","name":"svc"}}},
		  {"name":"b","clientConfig":{"caBundle":"x","service":{"namespace":"ns","name":"svc"}}}]}]}`
		_, backings := unservableWebhooks(decodeList(t, raw))
		if len(backings) != 1 {
			t.Errorf("one Service backing two webhooks must be checked once, got %v", backings)
		}
	})

	t.Run("a mixed cluster reports only the broken one", func(t *testing.T) {
		raw := `{"items":[
		 {"metadata":{"name":"ok"},"webhooks":[{"name":"w","clientConfig":{"caBundle":"x","service":{"namespace":"a","name":"s"}}}]},
		 {"metadata":{"name":"broken"},"webhooks":[{"name":"w","clientConfig":{"caBundle":"","service":{"namespace":"b","name":"s"}}}]}]}`
		unservable, backings := unservableWebhooks(decodeList(t, raw))
		if len(unservable) != 1 || !strings.Contains(unservable[0], "broken") {
			t.Errorf("want only the broken webhook, got %v", unservable)
		}
		if len(backings) != 1 || backings[0].Namespace != "a" {
			t.Errorf("the healthy webhook's backing must still be checked, got %v", backings)
		}
	})
}

func TestEndpointsReady(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want bool
	}{
		{"one ready address", `{"subsets":[{"addresses":[{"ip":"10.0.0.1"}]}]}`, true},
		// The window where the pod exists but has not passed its readiness probe. A caBundle
		// can be published before the pod presenting that certificate accepts connections, so
		// a non-empty caBundle is necessary and NOT sufficient — this is the other half.
		{"only not-ready addresses", `{"subsets":[{"notReadyAddresses":[{"ip":"10.0.0.1"}]}]}`, false},
		{"an empty subset", `{"subsets":[{}]}`, false},
		{"no subsets at all", `{}`, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := endpointsReady([]byte(tc.raw))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("endpointsReady = %v, want %v", got, tc.want)
			}
		})
	}

	t.Run("an unreadable body is an ERROR, never 'not ready'", func(t *testing.T) {
		// Reported rather than folded into the not-ready branch: "we could not tell" and
		// "we looked and it is not ready" must not decide alike.
		if _, err := endpointsReady([]byte(`not json`)); err == nil {
			t.Fatal("want an error for an unparseable endpoints body")
		}
	})
}

// TestWebhookWaitBudgetIsWholeDeploy pins the bound that keeps this gate from becoming the
// problem it solves: four waves must not be able to spend the timeout four times inside a deploy
// job whose own ceiling is 25 minutes.
func TestWebhookWaitBudgetIsWholeDeploy(t *testing.T) {
	b := newWebhookWaitBudget()
	if b.remaining != admissionWebhookWaitBudget {
		t.Fatalf("a fresh budget must start full, got %s", b.remaining)
	}
	if left := b.spend(admissionWebhookWaitBudget / 2); left != admissionWebhookWaitBudget/2 {
		t.Errorf("half spent should leave half, got %s", left)
	}
	if left := b.spend(admissionWebhookWaitBudget); left != 0 {
		t.Errorf("an over-spend must clamp at zero, not go negative, got %s", left)
	}
}

// TestExhaustedBudgetReportsRatherThanPasses — a gate that returns success when it did not run
// is indistinguishable from one that ran and found nothing. This repository's dominant defect.
func TestExhaustedBudgetReportsRatherThanPasses(t *testing.T) {
	b := &webhookWaitBudget{remaining: 0}
	err := WaitAdmissionWebhooksServable(b, io.Discard, io.Discard)
	if err == nil {
		t.Fatal("an exhausted budget must report that the check was SKIPPED, not return success")
	}
	if !strings.Contains(err.Error(), "skipped") {
		t.Errorf("the message must say the check did not run, got %q", err)
	}
}

// ── The poll loop, driven hermetically ───────────────────────────────────────────────────────
//
// The behaviour that matters is not "an empty caBundle is unservable" — that is one function call.
// It is that the gate KEEPS LOOKING and returns the moment the cluster converges, and gives up
// with a description when it does not. Neither can be exercised against a function that shells out
// to a live cluster, which is why webhookKubectl is a seam.

// stubKubectl installs a scripted kubectl for one test and restores the real one after.
func stubKubectl(t *testing.T, fn func(cmd string) (string, error)) {
	t.Helper()
	prev, prevInterval := webhookKubectl, admissionWebhookPollInterval
	webhookKubectl = fn
	admissionWebhookPollInterval = time.Millisecond
	t.Cleanup(func() { webhookKubectl, admissionWebhookPollInterval = prev, prevInterval })
}

const readyEndpoints = `{"subsets":[{"addresses":[{"ip":"10.0.0.1"}]}]}`

func TestWaitAdmissionWebhooksServableConverges(t *testing.T) {
	// THE POINT OF THE GATE: the first read is the ingress-nginx mid-patch state, the second is
	// patched with ready endpoints. The wait must not fail on the first read, and must return as
	// soon as the second lands.
	calls := 0
	stubKubectl(t, func(cmd string) (string, error) {
		if strings.Contains(cmd, "endpoints") {
			return readyEndpoints, nil
		}
		calls++
		if calls == 1 {
			return ingressNginxMidPatch, nil
		}
		return ingressNginxPatched, nil
	})

	var out strings.Builder
	if err := WaitAdmissionWebhooksServable(newWebhookWaitBudget(), &out, io.Discard); err != nil {
		t.Fatalf("the gate must succeed once the caBundle is patched, got %v", err)
	}
	if calls < 2 {
		t.Errorf("the gate returned without re-reading — it did not poll (calls=%d)", calls)
	}
	// The success line must say what it checked. "nothing unservable" over an empty cluster and
	// over a real one are different facts, and a gate that renders them identically is unauditable.
	if !strings.Contains(out.String(), "backing service(s) with ready endpoints") {
		t.Errorf("the success path must report what it checked, got %q", out.String())
	}
}

func TestWaitAdmissionWebhooksServableGivesUpWithADescription(t *testing.T) {
	stubKubectl(t, func(cmd string) (string, error) {
		if strings.Contains(cmd, "endpoints") {
			return readyEndpoints, nil
		}
		return ingressNginxMidPatch, nil // never converges
	})

	err := WaitAdmissionWebhooksServable(&webhookWaitBudget{remaining: 20 * time.Millisecond}, io.Discard, io.Discard)
	if err == nil {
		t.Fatal("a webhook that never becomes servable must be reported")
	}
	if !strings.Contains(err.Error(), "ingress-nginx-admission") {
		t.Errorf("the failure must NAME the webhook that held it up, got %q", err)
	}
	if !strings.Contains(err.Error(), "x509") {
		t.Errorf("the failure should point at the symptom an operator will actually see, got %q", err)
	}
}

func TestWaitAdmissionWebhooksServableWaitsForEndpointsToo(t *testing.T) {
	// A patched caBundle with no ready endpoints must NOT satisfy the gate: the certificate can be
	// published before the pod that presents it accepts connections.
	stubKubectl(t, func(cmd string) (string, error) {
		if strings.Contains(cmd, "endpoints") {
			return `{"subsets":[{"notReadyAddresses":[{"ip":"10.0.0.1"}]}]}`, nil
		}
		return ingressNginxPatched, nil
	})

	err := WaitAdmissionWebhooksServable(&webhookWaitBudget{remaining: 20 * time.Millisecond}, io.Discard, io.Discard)
	if err == nil {
		t.Fatal("a caBundle without ready endpoints must not pass the gate")
	}
	if !strings.Contains(err.Error(), "no ready endpoints") {
		t.Errorf("the failure must say the endpoints were the problem, got %q", err)
	}
}

func TestWaitAdmissionWebhooksServableTreatsAMissingEndpointsObjectAsNotReady(t *testing.T) {
	// The window between the Service existing and its pod being admitted. Treating the 404 as
	// "fine" would wave the gate through in exactly the state it exists to catch.
	stubKubectl(t, func(cmd string) (string, error) {
		if strings.Contains(cmd, "endpoints") {
			return "", errors.New(`Error from server (NotFound): endpoints "x" not found`)
		}
		return ingressNginxPatched, nil
	})

	err := WaitAdmissionWebhooksServable(&webhookWaitBudget{remaining: 20 * time.Millisecond}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "no Endpoints object yet") {
		t.Fatalf("a missing Endpoints object must read as not ready, got %v", err)
	}
}

func TestWaitAdmissionWebhooksServableReportsAnUnreadableCluster(t *testing.T) {
	// kubectl itself failing is not "no webhooks". It is "we could not tell", and the caller
	// reports it as a warning rather than proceeding as though the check had passed.
	stubKubectl(t, func(string) (string, error) { return "", errors.New("connection refused") })

	err := WaitAdmissionWebhooksServable(newWebhookWaitBudget(), io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "could not read admission webhook configurations") {
		t.Fatalf("an unreadable cluster must be reported, not passed, got %v", err)
	}
}

func TestWaitAdmissionWebhooksServableOnAnEmptyCluster(t *testing.T) {
	stubKubectl(t, func(string) (string, error) { return `{"items":[]}`, nil })

	var out strings.Builder
	if err := WaitAdmissionWebhooksServable(newWebhookWaitBudget(), &out, io.Discard); err != nil {
		t.Fatalf("a cluster with no webhooks has nothing to wait for, got %v", err)
	}
	if !strings.Contains(out.String(), "0 in-cluster backing service(s)") {
		t.Errorf("the success line must distinguish an empty cluster from a checked one, got %q", out.String())
	}
}
