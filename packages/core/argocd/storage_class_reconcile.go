// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// A StorageClass's `provisioner` is IMMUTABLE. From the API server's own validation
// (pkg/apis/storage/validation/validation.go, ValidateStorageClassUpdate):
//
//	apivalidation.ValidateImmutableField(storageClass.Provisioner, oldStorageClass.Provisioner, …)
//
// alongside `parameters`, `reclaimPolicy` and `volumeBindingMode`. So `kubectl apply` against a
// cluster whose class already carries a DIFFERENT provisioner does not converge — it is rejected:
//
//	The StorageClass "gp3" is invalid: provisioner: Forbidden: updates to provisioner are forbidden
//
// and ApplyApplications is fatal, so the whole GitOps step of the deploy fails.
//
// This matters because #3310 changed exactly that field: the aws default class named EKS Auto
// Mode's `ebs.csi.eks.amazonaws.com` while the cluster installs the add-on that registers
// `ebs.csi.aws.com`, so every PVC stayed Pending. A FRESH cluster gets the fix for free — which is
// every e2e run, and why the e2e would never have shown this. An EXISTING environment gets a failed
// deploy instead, on its next redeploy, for a class that was already broken.
//
// DELETING THE CLASS IS SAFE FOR EXISTING VOLUMES. A bound PersistentVolume carries its own
// `spec.csi.driver` and does not consult the class again; only NEW dynamic provisioning reads it,
// and the apply that follows recreates it in the same step. What a delete cannot do is rescue a
// PVC that is Pending against the old class — but under the old value nothing was provisioning it
// anyway, which is the defect being repaired.

// storageClassRef is a StorageClass this deploy intends to apply.
type storageClassRef struct {
	Name        string
	Provisioner string
	File        string
}

// storageClassesInManifests scans rendered manifests for StorageClass documents and returns the
// name/provisioner pairs they declare.
//
// A deliberately small YAML reader rather than a parser dependency: the inputs are this repo's own
// rendered templates, one document per file, and the two fields are top-level scalars. It is pure
// over the file contents so the extraction is testable without a cluster — which is the half that
// has to be right, because a scan that silently matches nothing would make this a no-op that reads
// like a safeguard.
func storageClassesInManifests(dir string) ([]storageClassRef, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("reading rendered manifests: %w", err)
	}
	var out []storageClassRef
	for _, e := range entries {
		if e.IsDir() || !(strings.HasSuffix(e.Name(), ".yaml") || strings.HasSuffix(e.Name(), ".yml")) {
			continue
		}
		b, rerr := os.ReadFile(filepath.Join(dir, e.Name()))
		if rerr != nil {
			return nil, fmt.Errorf("reading %s: %w", e.Name(), rerr)
		}
		ref := parseStorageClassDoc(string(b))
		if ref == nil {
			continue
		}
		ref.File = e.Name()
		out = append(out, *ref)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// parseStorageClassDoc returns the StorageClass a rendered document declares, or nil when the
// document is not one. A StorageClass whose name or provisioner cannot be read is NOT silently
// skipped — it is returned with the missing field empty so the caller can refuse it, because
// "there is no StorageClass here" and "I could not read the one that is here" are different facts.
func parseStorageClassDoc(doc string) *storageClassRef {
	var isSC bool
	var name, provisioner string
	inMetadata := false
	sc := bufio.NewScanner(strings.NewReader(doc))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "kind: StorageClass"):
			isSC = true
		case strings.HasPrefix(line, "metadata:"):
			inMetadata = true
		case strings.HasPrefix(line, "provisioner:"):
			provisioner = strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "provisioner:")), `"'`)
			inMetadata = false
		case len(line) > 0 && line[0] != ' ' && line[0] != '#':
			inMetadata = false
		case inMetadata && strings.HasPrefix(line, "  name:"):
			name = strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "  name:")), `"'`)
		}
	}
	if !isSC {
		return nil
	}
	return &storageClassRef{Name: name, Provisioner: provisioner}
}

// liveProvisionerFn reads the cluster's current provisioner for a class; deleteClassFn removes it.
// Injected so the DECISION — which is the part that can be wrong — is testable without a cluster.
// The alternative is a function whose only untested branch is the one that fires on the day it
// matters, which is how a safeguard becomes decoration.
type liveProvisionerFn func(name string) (provisioner string, found bool, err error)
type deleteClassFn func(name string) error

// ReconcileImmutableStorageClasses deletes any StorageClass this deploy is about to apply whose
// LIVE provisioner differs from the one being applied, so the apply can recreate it.
//
// Called before ApplyApplications, and fatal on a delete failure: the apply that follows would fail
// anyway, and it would fail with the API server's message rather than this one — which names the
// field but not the reason.
func ReconcileImmutableStorageClasses(renderedDir string, stdout, stderr io.Writer) error {
	classes, err := storageClassesInManifests(renderedDir)
	if err != nil {
		return err
	}
	return reconcileStorageClasses(classes, liveStorageClassProvisioner, deleteStorageClass, stdout, stderr)
}

// reconcileStorageClasses is the decision, over an already-read set of classes.
func reconcileStorageClasses(classes []storageClassRef, live liveProvisionerFn, del deleteClassFn, stdout, stderr io.Writer) error {
	for _, c := range classes {
		if c.Name == "" || c.Provisioner == "" {
			return fmt.Errorf("rendered %s declares a StorageClass this deploy cannot read (name=%q provisioner=%q) — refusing to apply it blind, because a provisioner mismatch is only repairable before the apply", c.File, c.Name, c.Provisioner)
		}
		liveProvisioner, found, lerr := live(c.Name)
		if lerr != nil {
			// Not fatal: a cluster that cannot answer this is a cluster the apply is about to fail
			// against anyway, with a better message. Never silent, though.
			fmt.Fprintf(stderr, "Warning: could not read the live provisioner of StorageClass %s (%v); applying as-is\n", c.Name, lerr)
			continue
		}
		if !found || liveProvisioner == c.Provisioner {
			continue
		}
		fmt.Fprintf(stdout, "StorageClass %s carries provisioner %q and this deploy applies %q. "+
			"That field is immutable, so the class is deleted and recreated — bound volumes are "+
			"unaffected (a PersistentVolume carries its own driver reference).\n", c.Name, liveProvisioner, c.Provisioner)
		if derr := del(c.Name); derr != nil {
			return fmt.Errorf("StorageClass %s must be recreated to change its provisioner from %q to %q, and deleting it failed: %w", c.Name, liveProvisioner, c.Provisioner, derr)
		}
	}
	return nil
}

// deleteStorageClass removes a class so the apply that follows can recreate it with the new
// provisioner. `--ignore-not-found` because a concurrent deploy may already have done it.
func deleteStorageClass(name string) error {
	return exec.Command("kubectl", "delete", "storageclass", name, "--ignore-not-found").Run()
}

// liveStorageClassProvisioner reads the cluster's current provisioner for a class.
func liveStorageClassProvisioner(name string) (provisioner string, found bool, err error) {
	out, runErr := exec.Command("kubectl", "get", "storageclass", name, "-o", "jsonpath={.provisioner}").CombinedOutput()
	return classifyLiveProvisioner(out, runErr)
}

// classifyLiveProvisioner turns kubectl's output into the three answers this decision needs, and it
// is separated from the exec because the classification is the part that can be WRONG.
//
// `found=false, err=nil` is the fresh-cluster case — the class does not exist, so there is nothing
// to reconcile and the apply will create it. `err != nil` is "the cluster could not tell me", which
// is NOT the same and must not be read as absent: reading a real failure as "no class here" would
// skip the reconcile on exactly the cluster that needed it, and the apply would then fail with the
// immutability error this exists to prevent.
func classifyLiveProvisioner(out []byte, runErr error) (provisioner string, found bool, err error) {
	text := string(out)
	if runErr != nil {
		if strings.Contains(text, "NotFound") || strings.Contains(text, "not found") {
			return "", false, nil
		}
		return "", false, fmt.Errorf("%v: %s", runErr, strings.TrimSpace(text))
	}
	p := strings.TrimSpace(text)
	if p == "" {
		// A class that exists with an EMPTY provisioner is not a thing the API server allows, so an
		// empty read on a successful command means the jsonpath matched nothing — treat it as
		// absent, which is the safe direction: the apply creates it and the API server decides.
		return "", false, nil
	}
	return p, true, nil
}
