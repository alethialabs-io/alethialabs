// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestWaitForCRDEstablishedRefusesShellMetacharacters is #2021's repro, kept.
//
// An add-on's declared CRD names ride the DEPLOY job's config snapshot and were interpolated
// straight into `kubectl wait … crd/%s`, which utils.ExecuteCommand runs via `bash -c`. A tampered
// snapshot or a catalog bug therefore executed arbitrary commands as the runner.
func TestWaitForCRDEstablishedRefusesShellMetacharacters(t *testing.T) {
	work := t.TempDir()
	marker := filepath.Join(work, "pwned")

	// A `kubectl` that always succeeds, so only the injection can produce the marker.
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "kubectl"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	err := waitForCRDEstablished("widgets.example.com; touch "+marker+"; #", io.Discard, io.Discard)

	if _, statErr := os.Stat(marker); statErr == nil {
		t.Fatalf("COMMAND INJECTION: the CRD name's payload executed — %s was created", marker)
	}
	if err == nil {
		t.Error("waitForCRDEstablished accepted a CRD name carrying shell metacharacters; want a refusal")
	} else if !strings.Contains(err.Error(), "not a valid CRD name") {
		t.Errorf("refused, but not for the reason under test: %v", err)
	}
}

// TestApplyManifestAddOnsRefusesBadCRDName drives the whole rail, not just the leaf.
//
// waitForCRDEstablished's own guard would stop the injection either way, but the add-on must also be
// COUNTED as failed rather than skipped quietly: a CRD name that cannot be one means the schema was
// never confirmed, and letting the add-on report installed is the fail-open half of the same bug.
func TestApplyManifestAddOnsRefusesBadCRDName(t *testing.T) {
	work := t.TempDir()
	marker := filepath.Join(work, "pwned-rail")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("kind: CustomResourceDefinition\n"))
	}))
	defer srv.Close()

	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "kubectl"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	addons := []types.AddOnInstall{{
		ID: "evil-operator", Mode: "managed", Source: "manifest",
		ChartRepo: srv.URL + "/op.yaml", Version: "v1.0.0",
		CRDs: []string{"widgets.example.com; touch " + marker + "; #"},
	}}

	var stdout, stderr strings.Builder
	err := ApplyManifestAddOns(context.Background(), addons, &stdout, &stderr)

	if _, statErr := os.Stat(marker); statErr == nil {
		t.Fatalf("COMMAND INJECTION through the rail — %s was created", marker)
	}
	// It was the only add-on, so the whole rail failing is the aggregate contract.
	if err == nil {
		t.Error("ApplyManifestAddOns returned nil; an add-on whose only CRD was refused must count as failed")
	}
	if !strings.Contains(stderr.String(), "not a valid kubernetes CRD name") {
		t.Errorf("no refusal warning naming the cause:\n%s", stderr.String())
	}
	if strings.Contains(stdout.String(), "✓ evil-operator installed") {
		t.Error("the add-on reported installed despite its CRD never being confirmed")
	}
}

// TestCRDNameGrammar pins what the guard accepts. The accept half matters as much as the reject
// half here: reusing addon_secrets.go's single-label k8sNameRe would have refused every real CRD
// name, since they all carry dots — a guard that blocks the whole feature is not a fix.
func TestCRDNameGrammar(t *testing.T) {
	valid := []string{
		"clusters.postgresql.cnpg.io",
		"certificates.cert-manager.io",
		"rabbitmqclusters.rabbitmq.com",
		"widgets.example.com",
		"prometheuses.monitoring.coreos.com",
		"scaledobjects.keda.sh",
		"widgets", // no group: unusual for a CRD, but a valid subdomain and not our business to refuse
	}
	for _, s := range valid {
		if !crdNameRe.MatchString(s) {
			t.Errorf("crdNameRe rejected the real CRD name %q", s)
		}
	}

	invalid := []string{
		"",
		"widgets.example.com; touch /tmp/pwned; #", // #2021's payload
		"widgets.example.com && id",
		"widgets.example.com$(id)",
		"widgets.example.com`id`",
		"widgets.example.com | cat",
		"widgets example.com",  // a space would split the kubectl argv
		"widgets.example.com/", // a slash would address a different resource
		"crd/widgets.example.com",
		"Widgets.example.com", // kubernetes names are lowercase
		"-widgets.example.com",
		"widgets.example.com-",
		".widgets.example.com", // leading dot = empty label
		"widgets.example.com.", // trailing dot = empty label
		"widgets..example.com", // doubled dot = empty label
		"widgets.example.com\nid",
	}
	for _, s := range invalid {
		if crdNameRe.MatchString(s) {
			t.Errorf("crdNameRe(%q) = true, want false (must fail closed)", s)
		}
	}
}
