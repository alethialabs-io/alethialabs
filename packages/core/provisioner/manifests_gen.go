// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// generateAppManifests renders Kubernetes manifests for the project's FIRST-CLASS
// services (vc.Services — the W1 canvas model; the scanner-DetectedService path is
// retired) and commits them to the apps (GitOps) repo — but ONLY when that repo has no
// manifests yet, so a bring-your-own manifests repo is NEVER clobbered. It is
// safe-by-construction: it writes to an EMPTY manifests repo or does nothing. No-op when
// there are no renderable services.
//
// Images are REAL (W2): each service renders with its ResolvedImage (the BUILD job's
// digest URI) or its prebuilt Source.Image — never a fabricated ":latest" (which the
// elench verify gate fails). Unrenderable services (unbuilt, or a workload type without a
// template yet) are reported to stdout, not silently dropped.
//
// Returns `warnings`: non-fatal manifest-generation issues (a skipped service, an unresolved
// binding endpoint, an unsatisfiable credential facet) that the caller attaches to GitopsStatus so
// the console surfaces them — the render we deploy IS authoritative here, so these explain why a
// service may boot misconfigured. A bring-your-own manifests repo returns no warnings: the
// customer's manifests own the deploy, so our render (and its warnings) don't apply.
func generateAppManifests(ctx context.Context, vc *types.ProjectConfig, outputs map[string]interface{}, token string, stdout, stderr io.Writer) (warnings []string, err error) {
	if vc.Repositories.AppsDestinationRepo == "" || token == "" {
		return nil, nil
	}
	// Normalize the tofu outputs to string values so the pure renderer can resolve a service's
	// W3 binding endpoints (a database's endpoint, etc.) into concrete env values.
	strOutputs := make(map[string]string, len(outputs))
	for k, v := range outputs {
		if s, ok := v.(string); ok {
			strOutputs[k] = s
		}
	}
	// Keyless per-cloud DB auth (#722) is dark by default: only when ALETHIA_KEYLESS_DB_AUTH_ENABLED
	// is set does a service→database binding to an iam_auth database use the local auth-proxy sidecar
	// (holding no password) instead of the ExternalSecret path. Off → every credential facet keeps
	// the existing password path unchanged.
	keylessOn := os.Getenv("ALETHIA_KEYLESS_DB_AUTH_ENABLED") == "true"
	mopts := manifests.Options{
		Namespace:     appNamespace,
		Domain:        vc.DNS.DomainName,
		Outputs:       strOutputs,
		Provider:      string(vc.Provider), // selects the per-cloud tofu endpoint output keys (#711)
		KeylessDBAuth: keylessOn,
		Databases:     vc.Databases,                      // lookup source for a binding target's iam_auth (#722)
		RunnerImage:   os.Getenv("ALETHIA_RUNNER_IMAGE"), // the db-token / db-bootstrap sidecar image
	}
	apps, skipped := manifests.FromServices(vc.Services, mopts)
	for _, reason := range skipped {
		fmt.Fprintf(stdout, "Manifest generation skipped %s\n", reason)
	}
	warnings = append(warnings, skipped...)
	if len(apps) == 0 {
		return warnings, nil // no renderable services to scaffold (but report why they were skipped)
	}

	dir, err := os.MkdirTemp("", "alethia-apps-*")
	if err != nil {
		return warnings, err
	}
	defer os.RemoveAll(dir)

	repo := git.NewGITWithToken(vc.Repositories.AppsDestinationRepo, dir, false, token)
	if err := repo.Clone(ctx, "", false); err != nil {
		return warnings, fmt.Errorf("clone apps repo: %w", err)
	}

	if hasManifests(dir) {
		fmt.Fprintf(stdout, "Apps repo already contains manifests — leaving it untouched (bring-your-own).\n")
		return nil, nil // BYO owns the manifests; our render + its warnings don't apply
	}

	written, err := manifests.WriteManifests(dir, apps)
	if err != nil {
		return warnings, err
	}
	// W3 — the keyless credential last hop: for each service's credential-facet bindings, write an
	// ExternalSecret alongside the app manifests. ArgoCD applies it; ESO (via the per-cloud
	// ClusterSecretStore) materializes the k8s Secret the workload's secretKeyRef reads. The Secret
	// name matches BindingSecretName(s.Name, target) — exactly the secretKeyRef.name the renderer
	// emitted for this service (per-service, so no two ExternalSecrets fight over one Secret).
	esSkips, esCount, err := writeBindingExternalSecrets(dir, vc, strOutputs, keylessOn, stdout)
	if err != nil {
		return warnings, err
	}
	warnings = append(warnings, esSkips...)
	// Keyless least-priv bootstrap (#722 R5): for each keyless database, write the one-shot ArgoCD
	// PreSync Job that creates/scopes the app's DB role as admin (+ its admin ExternalSecret on
	// AWS/GCP). Without it a keyless app has an identity but no role to log in as. A Job that can't be
	// rendered (a missing admin output) is REPORTED, not fatal — consistent with the binding lane.
	jobSkips, jobCount, err := writeBootstrapJobs(dir, vc, mopts, stdout)
	if err != nil {
		return warnings, err
	}
	warnings = append(warnings, jobSkips...)
	if err := repo.AddAndCommit("chore: scaffold app manifests (alethia)"); err != nil {
		return warnings, fmt.Errorf("commit generated manifests: %w", err)
	}
	if err := repo.Push(); err != nil {
		return warnings, fmt.Errorf("push generated manifests: %w", err)
	}
	fmt.Fprintf(stdout, "Scaffolded %d app manifest(s)%s%s into the GitOps repo: %s\n",
		len(written), esCountSuffix(esCount), jobCountSuffix(jobCount), strings.Join(written, ", "))
	return warnings, nil
}

// appNamespace is the namespace both the generated Deployments (via App.normalize's default) and
// their binding ExternalSecrets deploy into. They MUST match — a secretKeyRef reads a Secret in its
// own namespace — so this single constant keeps them aligned.
const appNamespace = "default"

// esCountSuffix renders the ExternalSecret count for the summary line (nothing when zero).
func esCountSuffix(n int) string {
	if n == 0 {
		return ""
	}
	return fmt.Sprintf(" + %d ExternalSecret(s)", n)
}

// jobCountSuffix renders the keyless bootstrap-Job count for the summary line (nothing when zero).
func jobCountSuffix(n int) string {
	if n == 0 {
		return ""
	}
	return fmt.Sprintf(" + %d keyless bootstrap Job(s)", n)
}

// writeBootstrapJobs renders the keyless least-priv DB bootstrap Job (#722 R5) for each keyless
// database bound by a service, writing the Job (and its admin ExternalSecret on AWS/GCP) into dir for
// ArgoCD to run as a PreSync hook. Deduped per (kind, name) so multiple services binding the same
// database share ONE Job. No-op when keyless is off (mopts.KeylessDBAuth). A Job that can't be
// rendered (a missing admin tofu output) is REPORTED to stdout AND returned as `skips`, never fatal —
// the app still deploys (its keyless binding fail-closes in lock-step), and the reason surfaces on the
// Deploy tab. The skip reasons carry no secret values (kind/name/output names only).
func writeBootstrapJobs(dir string, vc *types.ProjectConfig, mopts manifests.Options, stdout io.Writer) (skips []string, count int, err error) {
	if !mopts.KeylessDBAuth {
		return nil, 0, nil
	}
	seen := map[string]bool{}
	for _, s := range vc.Services {
		for _, b := range s.Bindings {
			if !manifests.KeylessDBTarget(mopts.Provider, b.Target, vc.Databases) {
				continue
			}
			key := string(b.Target.Kind) + "/" + b.Target.Name
			if seen[key] {
				continue // one bootstrap Job per keyless database, not per binding
			}
			seen[key] = true

			res, renderErr := manifests.RenderBootstrapJob(mopts, b.Target)
			if renderErr != nil {
				msg := fmt.Sprintf("keyless bootstrap Job for %s/%s: %v — app role not provisioned (fail-closed)", b.Target.Kind, b.Target.Name, renderErr)
				fmt.Fprintln(stdout, "Bootstrap Job skipped "+msg)
				skips = append(skips, msg)
				continue
			}
			if writeErr := os.WriteFile(filepath.Join(dir, res.Name+".yaml"), []byte(res.JobYAML), 0o644); writeErr != nil {
				return skips, count, writeErr
			}
			if res.AdminSecretYAML != "" {
				if writeErr := os.WriteFile(filepath.Join(dir, res.Name+"-admin-externalsecret.yaml"), []byte(res.AdminSecretYAML), 0o644); writeErr != nil {
					return skips, count, writeErr
				}
			}
			count++
		}
	}
	return skips, count, nil
}

// credentialSecretOutputKey maps a binding kind to the tofu output holding the resource's
// provisioned master-credentials secret name. AWS-first; "" → no provisioned credential secret for
// that kind, so RenderExternalSecret reports the facet unsatisfiable (never silently dropped).
func credentialSecretOutputKey(kind string) string {
	switch kind {
	case "database":
		return "rds_master_credentials_secret_name"
	default:
		return ""
	}
}

// credentialRemoteOutputKey returns the tofu output NAME holding a target's master-credentials
// secret (the ExternalSecret RemoteKey source). A BYO-IaC target (Address != "") uses the customer
// module's declared output (manifests.ByoCredentialOutputKey — "" when the module exported none, so
// RenderExternalSecret reports it unsatisfiable); a first-class target uses the platform template
// key. This branches identically to resolveBindings' credential gate, so the secretKeyRef the
// workload reads and the ExternalSecret this lane writes stay in lock-step.
func credentialRemoteOutputKey(t types.ServiceBindingTarget) string {
	if t.Address != "" {
		return manifests.ByoCredentialOutputKey(t)
	}
	return credentialSecretOutputKey(string(t.Kind))
}

// writeBindingExternalSecrets renders an ExternalSecret per service credential-facet binding and
// writes it into dir (alongside the app manifests) for ArgoCD to apply. It passes ServiceName:
// s.Name so the materialized Secret's name equals the renderer's per-service secretKeyRef target.
// Unsatisfiable facets (no store for the cloud, no provisioned secret, a facet the secret lacks)
// are reported to stdout AND returned as `skips`, never dropped silently. Returns those skip reasons
// + the count written. The skip reasons carry no secret values (facet/kind/provider names only).
func writeBindingExternalSecrets(dir string, vc *types.ProjectConfig, outputs map[string]string, keylessOn bool, stdout io.Writer) (skips []string, count int, err error) {
	for _, s := range vc.Services {
		for _, b := range s.Bindings {
			facets := manifests.CredentialFacetNames(b)
			if len(facets) == 0 {
				continue // endpoint/port-only binding needs no Secret
			}
			// Keyless DB bindings (#722) hold no password — the renderer wired an auth-proxy sidecar
			// instead of a secretKeyRef, so there is no Secret to materialize here. Skip in lock-step
			// with FromServices' keyless decision (same KeylessDBTarget predicate) so the two lanes
			// never disagree about which bindings are keyless.
			if keylessOn && manifests.KeylessDBTarget(string(vc.Provider), b.Target, vc.Databases) {
				continue
			}
			yaml, skipped, renderErr := manifests.RenderExternalSecret(manifests.ExternalSecretParams{
				ServiceName: s.Name,
				Namespace:   appNamespace,
				Target:      b.Target,
				Provider:    string(vc.Provider),
				RemoteKey:   outputs[credentialRemoteOutputKey(b.Target)],
				Facets:      facets,
			})
			if renderErr != nil {
				return skips, count, fmt.Errorf("render ExternalSecret for %s→%s/%s: %w", s.Name, b.Target.Kind, b.Target.Name, renderErr)
			}
			for _, reason := range skipped {
				fmt.Fprintf(stdout, "ExternalSecret skipped %s\n", reason)
			}
			skips = append(skips, skipped...)
			if yaml == "" {
				continue
			}
			file := filepath.Join(dir, manifests.BindingSecretName(s.Name, b.Target)+"-externalsecret.yaml")
			if writeErr := os.WriteFile(file, []byte(yaml), 0o644); writeErr != nil {
				return skips, count, writeErr
			}
			count++
		}
	}
	return skips, count, nil
}

// hasManifests reports whether the repo root already holds any Kubernetes YAML — the
// guard that keeps generation from overwriting a bring-your-own manifests repo.
func hasManifests(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return true // be conservative: unknown state → don't write
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := strings.ToLower(e.Name())
		if strings.HasSuffix(n, ".yaml") || strings.HasSuffix(n, ".yml") {
			return true
		}
	}
	return false
}
