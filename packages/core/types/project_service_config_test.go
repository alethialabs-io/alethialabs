// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestProjectServiceConfig_ResolvedImageRoundTrip locks the W2 build write-back contract (#591):
// resolved_image must survive the JSON round-trip the runner does when it reads a service off the
// deploy snapshot to substitute the built image for the workload — and it must be OMITTED entirely
// when empty, so a not-yet-built service carries no image key (rather than an empty string that a
// naive renderer could turn back into `<name>:` / ":latest", the very thing W2 retires).
//
// The serialized key is asserted explicitly because it is a cross-language contract: the console
// (TS) writes `resolved_image` into the snapshot and the console persists into it from a BUILD
// job's result; a silent Go tag rename would break both halves without a compile error.
func TestProjectServiceConfig_ResolvedImageRoundTrip(t *testing.T) {
	const digestURI = "111122223333.dkr.ecr.us-east-1.amazonaws.com/acme-api@sha256:" +
		"3f1a9c2b7e4d5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9"

	svc := ProjectServiceConfig{
		Name:          "api",
		Type:          "deployment",
		Source:        ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/monorepo", Path: "apps/api"},
		Build:         &ProjectServiceBuild{Dockerfile: "apps/api/Dockerfile", Context: "apps/api"},
		Replicas:      2,
		ResolvedImage: digestURI,
	}

	b, err := json.Marshal(svc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"resolved_image":`) {
		t.Fatalf("resolved_image not serialized under its contract key:\n%s", b)
	}

	var got ProjectServiceConfig
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ResolvedImage != digestURI {
		t.Errorf("ResolvedImage round-trip:\n got %q\nwant %q", got.ResolvedImage, digestURI)
	}

	// A service that has not been built yet must not emit the key at all (omitempty), so the
	// snapshot distinguishes "no image resolved" from an empty-string image.
	svc.ResolvedImage = ""
	b2, err := json.Marshal(svc)
	if err != nil {
		t.Fatalf("marshal (empty ResolvedImage): %v", err)
	}
	if strings.Contains(string(b2), "resolved_image") {
		t.Errorf("empty ResolvedImage must be omitempty, but was emitted:\n%s", b2)
	}
}

// TestProjectServiceConfig_BindingsRoundTrip locks the W3 binding contract (#615): a service's
// declared edges to backing resources survive the JSON round-trip the runner reads off the deploy
// snapshot to resolve endpoints/credentials into workload env. Every field (target kind/name, and
// each injection's env/from) must round-trip under its exact key — this is the cross-language
// contract the TS zod schema, the snapshot, and the (downstream) manifest renderer all speak.
func TestProjectServiceConfig_BindingsRoundTrip(t *testing.T) {
	svc := ProjectServiceConfig{
		Name:   "api",
		Type:   "deployment",
		Source: ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/api", Path: "."},
		Bindings: []ServiceBinding{
			{
				Target: ServiceBindingTarget{Kind: "database", Name: "orders-db"},
				Inject: []ServiceBindingInjection{
					{Env: "DATABASE_HOST", From: "endpoint"},
					{Env: "DATABASE_PORT", From: "port"},
					{Env: "DATABASE_PASSWORD", From: "password"},
				},
			},
			{
				Target: ServiceBindingTarget{Kind: "cache", Name: "sessions"},
				Inject: []ServiceBindingInjection{{Env: "REDIS_URL", From: "connection_string"}},
			},
		},
	}

	b, err := json.Marshal(svc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// The contract keys the TS side + the snapshot depend on.
	for _, key := range []string{`"bindings":`, `"target":`, `"inject":`, `"kind":`, `"from":`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("binding not serialized under contract key %s:\n%s", key, b)
		}
	}

	var got ProjectServiceConfig
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Bindings) != 2 {
		t.Fatalf("bindings round-trip: got %d, want 2", len(got.Bindings))
	}
	db := got.Bindings[0]
	if db.Target.Kind != "database" || db.Target.Name != "orders-db" {
		t.Errorf("target round-trip: got %+v", db.Target)
	}
	if len(db.Inject) != 3 || db.Inject[2].Env != "DATABASE_PASSWORD" || db.Inject[2].From != "password" {
		t.Errorf("inject round-trip: got %+v", db.Inject)
	}
	if got.Bindings[1].Inject[0].From != "connection_string" {
		t.Errorf("cache facet round-trip: got %q", got.Bindings[1].Inject[0].From)
	}
}
