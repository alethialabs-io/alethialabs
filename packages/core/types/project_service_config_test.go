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
