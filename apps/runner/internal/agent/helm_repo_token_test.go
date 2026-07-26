// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestHelmRepoPatchJSON(t *testing.T) {
	j := helmRepoPatchJSON("AWS", "s3cr3t")
	if !strings.Contains(j, `"username":"`+base64.StdEncoding.EncodeToString([]byte("AWS"))+`"`) {
		t.Errorf("patch missing base64 username: %s", j)
	}
	if !strings.Contains(j, `"password":"`+base64.StdEncoding.EncodeToString([]byte("s3cr3t"))+`"`) {
		t.Errorf("patch missing base64 password: %s", j)
	}
	// Only the rotating credentials — never the immutable pre-seeded fields.
	for _, k := range []string{"enableOCI", `"url"`, `"type"`} {
		if strings.Contains(j, k) {
			t.Errorf("patch must not touch immutable field %q: %s", k, j)
		}
	}
	// The raw token must never appear in plaintext (only base64'd into the Secret data).
	if strings.Contains(j, "s3cr3t") {
		t.Errorf("patch leaked the plaintext token: %s", j)
	}
}

func TestRunHelmRepoTokenLoop_OncePatchesCredentials(t *testing.T) {
	var gotNS, gotName, gotUser, gotPass string
	patch := func(_ context.Context, ns, name, user, pass string) error {
		gotNS, gotName, gotUser, gotPass = ns, name, user, pass
		return nil
	}
	mint := func(_ context.Context) (string, string, time.Time, error) {
		return "AWS", "tok-123", time.Now().Add(time.Hour), nil
	}
	if err := runHelmRepoTokenLoop(context.Background(), mint, patch, "argocd", "repo-helm-x", true); err != nil {
		t.Fatal(err)
	}
	if gotNS != "argocd" || gotName != "repo-helm-x" || gotUser != "AWS" || gotPass != "tok-123" {
		t.Fatalf("patch got ns=%q name=%q user=%q pass=%q", gotNS, gotName, gotUser, gotPass)
	}
}

func TestRunHelmRepoTokenLoop_FirstMintFatal(t *testing.T) {
	mint := func(_ context.Context) (string, string, time.Time, error) {
		return "", "", time.Time{}, errors.New("no cross-account trust")
	}
	patched := false
	patch := func(_ context.Context, _, _, _, _ string) error { patched = true; return nil }
	if err := runHelmRepoTokenLoop(context.Background(), mint, patch, "argocd", "s", true); err == nil {
		t.Fatal("a first-mint failure must be fatal (fail fast)")
	}
	if patched {
		t.Fatal("must not patch when the first mint fails")
	}
}

func TestRunHelmRepoTokenLoop_PatchErrorPropagates(t *testing.T) {
	mint := func(_ context.Context) (string, string, time.Time, error) {
		return "AWS", "tok", time.Now().Add(time.Hour), nil
	}
	patch := func(_ context.Context, _, _, _, _ string) error { return errors.New("rbac denied") }
	if err := runHelmRepoTokenLoop(context.Background(), mint, patch, "argocd", "s", true); err == nil {
		t.Fatal("a patch failure must propagate")
	}
}
