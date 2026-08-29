// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/imagebuild"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// kubectlTimeout bounds one kubectl invocation against the customer's API server.
const kubectlTimeout = 60 * time.Second

// Build execution bounds. A kaniko build of a normal service image completes in minutes;
// the per-service ceiling keeps one wedged build from eating the whole 2h job deadline.
//
// They are package vars rather than consts purely so a test can shorten them — the same
// reason runner.go's loop intervals are vars. At the production values, reaching the
// watcher's poll branch costs a 10s wall-clock wait per iteration and its deadline branch
// costs 30 minutes. Production never reassigns them, and the values are the ones the
// watcher has always used.
var (
	buildWaitTimeout  = 30 * time.Minute
	buildPollInterval = 10 * time.Second
)

// buildResultKey is the execution_metadata key carrying the per-service digest map —
// the W2 seam contract (#585): { service_name → image_digest_uri }. The console (#590)
// persists each entry into project_services.resolved_image.
const buildResultKey = "build_result"

// executeBuild handles a BUILD job (W2 image build & push): for each of the environment's
// first-class services with source.kind=="repo", it schedules a kaniko Job IN the
// customer's own provisioned cluster (rendered by packages/core/imagebuild, pushed to the
// provisioned ECR via the build ServiceAccount's IRSA — customer compute, zero platform
// keys), watches it to completion, captures the pushed image digest, and reports the
// per-service digest map via execution_metadata.build_result.
//
// Trust boundary: the customer's Dockerfile executes IN THEIR OWN CLUSTER, never on the
// runner — runner-side work is rendering + kubectl against their API server, plus a
// commit-pinning clone (data fetch only, like ANALYZE_REPO; nothing from the repo is
// executed here). So no byoManagedGate / container sandbox is required.
//
// Fail-closed: a service whose ECR destination is missing (infra not provisioned), whose
// build Job fails, or whose digest cannot be captured fails the whole job — the console
// must never treat an unbuilt service as built. Digests captured before the failure are
// still posted (persisting a completed build is correct and idempotent).
//
// Registry credentials NEVER enter execution_metadata: the build authenticates in-cluster
// via IRSA, the runner never holds a registry credential at all, and the digest URI is
// non-secret (scrubMetadataTree + secret_nonleak_test guard the boundary).
func (w *Runner) executeBuild(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}
	if provider == "" {
		provider = string(vc.Provider)
	}
	if provider == "" {
		provider = "aws"
	}
	if identity != nil {
		vc.CloudAccountID = resolveAccountID(identity)
	}
	if vc.CloudAccountID == "" {
		vc.CloudAccountID = resolveAmbientAccountID(provider)
	}

	repoServices := repoSourcedServices(vc.Services)
	if len(repoServices) == 0 {
		fmt.Fprintf(stdout, "No repo-sourced services to build — nothing to do.\n")
		_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{buildResultKey: map[string]string{}})
		return nil
	}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
		"phase": "build", "progress": fmt.Sprintf("Building %d service image(s) in-cluster...", len(repoServices)),
	})

	// 1. The environment's tofu outputs (in-process, via the per-job state proxy): the ECR
	//    destination map + the build-SA contract + what ConfigureKubeconfig needs.
	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}
	outputs, err := provisioner.ReadStateOutputs(ctx, provisioner.ReadStateOutputsParams{
		IacVersion:   vc.IacVersion,
		StateBackend: stateBackend,
		Stdout:       stdout,
		Stderr:       stderr,
	})
	if err != nil {
		return fmt.Errorf("build could not read environment state: %w", err)
	}

	destURLs := extractOutputStringMap(outputs, "ecr_repository_urls_map")
	if len(destURLs) == 0 {
		return fmt.Errorf("no ecr_repository_urls_map in environment outputs — provision infra (with the W2 ECR wiring) before BUILD")
	}
	buildNamespace, buildSA := splitBuildServiceAccount(
		extractOutputStr(outputs, "ecr_build_service_account"))

	// 2. Cluster access, keyless: the provider builds an exec-plugin kubeconfig off the
	//    ambient federated creds (kube_token.go). BUILD needs the cluster, so a kubeconfig
	//    failure is a job error (unlike PROBE's honest-down).
	cloudProvider, err := cloud.NewCloudProvider(provider)
	if err != nil {
		return fmt.Errorf("build cannot run: %w", err)
	}
	if err := cloudProvider.ConfigureKubeconfig(ctx, vc, outputs, stdout); err != nil {
		return fmt.Errorf("build could not configure cluster access: %w", err)
	}

	// 3. The build namespace must exist before the Job lands in it (idempotent).
	if err := w.kubectlApplyManifest(ctx, namespaceManifest(buildNamespace), stderr); err != nil {
		return fmt.Errorf("ensure build namespace %q: %w", buildNamespace, err)
	}

	// 4. Build every repo-sourced service; collect digests, fail closed on the first error
	//    (but post what already built — a completed push is real regardless).
	results := map[string]string{}
	var buildErr error
	for _, svc := range repoServices {
		digest, err := w.buildOneService(ctx, job, svc, destURLs, buildNamespace, buildSA, stdout, stderr)
		if err != nil {
			buildErr = fmt.Errorf("build %s: %w", svc.Name, err)
			fmt.Fprintf(stderr, "Build failed for %s: %v\n", svc.Name, err)
			break
		}
		results[svc.Name] = digest
		fmt.Fprintf(stdout, "Built %s → %s\n", svc.Name, digest)
	}

	if len(results) > 0 || buildErr == nil {
		_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{buildResultKey: results})
	}
	return buildErr
}

// buildOneService renders, applies, and watches one kaniko build Job, returning the pushed
// image's digest URI.
func (w *Runner) buildOneService(ctx context.Context, job *Job, svc types.ProjectServiceConfig, destURLs map[string]string, namespace, serviceAccount string, stdout, stderr *JobLogger) (string, error) {
	dest := destURLs[svc.Name]
	if dest == "" {
		return "", fmt.Errorf("no ECR repository provisioned for service %q (ecr_repository_urls_map has no entry) — re-run infra provisioning", svc.Name)
	}

	// Pin the exact commit being built: shallow-resolve the repo's HEAD runner-side. The
	// git token (when the repo is private) stays HERE — it is used for this clone only and
	// never reaches the in-cluster Job spec or execution_metadata.
	sha, err := w.resolveHeadSHA(ctx, job.ID, svc.Source.RepoURL, stderr)
	if err != nil {
		return "", fmt.Errorf("resolve HEAD of %s: %w", svc.Source.RepoURL, err)
	}

	manifest, err := imagebuild.RenderBuildJob(svc, imagebuild.Options{
		Destination:    dest,
		Tag:            sha,
		GitContext:     gitContextFor(svc.Source.RepoURL, sha),
		ServiceAccount: serviceAccount,
		Namespace:      namespace,
	})
	if err != nil {
		return "", fmt.Errorf("render kaniko job: %w", err)
	}
	jobName := buildJobName(svc.Name)

	fmt.Fprintf(stdout, "Scheduling in-cluster build of %s @ %s → %s\n", svc.Name, shortSHA12(sha), dest)
	// Replace any prior build Job for this service (idempotent re-run), then apply.
	_ = w.runKubectl(ctx, stderr, "delete", "job", jobName, "-n", namespace, "--ignore-not-found=true", "--wait=true")
	if err := w.kubectlApplyManifest(ctx, manifest, stderr); err != nil {
		return "", fmt.Errorf("apply kaniko job: %w", err)
	}

	if err := w.waitForJob(ctx, jobName, namespace, stdout, stderr); err != nil {
		// Surface the build log tail so the console shows WHY the Dockerfile failed.
		//
		// EVERY attempt, not one. `kubectl logs job/<name>` prints "Found 2 pods, using pod/…" and
		// picks arbitrarily, and a build Job runs to DefaultBackoffLimit — so the tail an operator
		// is shown may be a retry rather than the failure that started it.
		//
		// PRINTED EVEN WHEN THE READ FAILED. `kubectl logs -l` reads the pods in sequence and stops
		// at the first one it cannot open — after writing the ones before it. On a failed build the
		// pod that cannot be opened is a likely one, and discarding what came back would throw away
		// the log tail on exactly the runs it exists for.
		if logs, lerr := w.kubectlOutput(ctx, "logs", "-l", buildJobPodSelector+jobName, "-n", namespace,
			"--tail=50", "--prefix"); logs != "" {
			fmt.Fprintf(stderr, "--- kaniko log tail (%s) ---\n%s\n", svc.Name, logs)
			if lerr != nil {
				fmt.Fprintf(stderr, "(the log read stopped early: %v — later attempts are missing)\n", lerr)
			}
		} else if lerr != nil {
			fmt.Fprintf(stderr, "(no kaniko log for %s: %v)\n", svc.Name, lerr)
		}
		return "", err
	}

	// 5. Capture the pushed digest. Primary: the pod's termination message — the renderer
	//    points kaniko's --image-name-with-digest-file at /dev/termination-log
	//    (imagebuild.DigestFilePath), so the digest is readable AFTER completion without
	//    depending on log retention. Fallbacks, loudly: the kaniko log line, then the
	//    immutable git-SHA tag (still a pinned, verify-passing reference).
	//    ⚠️ EVERY pod, not `items[0]`. The Job's backoffLimit is 1 by default, so a build that
	//    failed once and succeeded on the retry leaves TWO pods and `items[0]` is whichever the API
	//    server lists first. Half the time that is the FAILED attempt, whose termination message
	//    carries no digest — because kaniko only writes the digest file on success. The read then
	//    finds nothing, the log read below picks a pod just as arbitrarily, and the build silently
	//    degrades from a digest-pinned reference to a tag under a message that reads like a benign
	//    fallback. Concatenating every pod's message is safe for exactly the reason the bug is
	//    possible: only a successful attempt has a digest to find.
	if msg, terr := w.kubectlOutput(ctx, "get", "pods", "-n", namespace,
		"-l", buildJobPodSelector+jobName, "-o",
		`jsonpath={range .items[*]}{.status.containerStatuses[0].state.terminated.message}{"\n"}{end}`); terr == nil {
		if digest := parseKanikoDigest(msg); digest != "" {
			return dest + "@" + digest, nil
		}
	}
	// Same correction on the fallback. `--tail=-1` is explicit because kubectl defaults a SELECTOR
	// read to the last 10 lines, and the digest line is not reliably in the last 10.
	logs, err := w.kubectlOutput(ctx, "logs", "-l", buildJobPodSelector+jobName, "-n", namespace,
		"--tail=-1", "--prefix")
	// PARSED BEFORE THE ERROR IS CHECKED. A selector read that stopped at an unopenable pod has
	// already written the ones before it, and the successful attempt — the only one with a digest —
	// may be among them. Failing on the error while holding the answer would degrade a digest-pinned
	// image to a tag for a reason that is in hand.
	if digest := parseKanikoDigest(logs); digest != "" {
		return dest + "@" + digest, nil
	}
	if err != nil {
		return "", fmt.Errorf("read build digest (termination message and logs both unavailable): %w", err)
	}
	fmt.Fprintf(stderr, "No digest in termination message or logs for %s — falling back to the immutable git-SHA tag.\n", svc.Name)
	return dest + ":" + sha, nil
}

// buildJobName is the imagebuild renderer's Job naming contract, so the watcher/digest reads
// address the Job the rendered manifest creates.
//
// It CALLS the renderer rather than mirroring it. The previous version restated the sanitization by
// hand and omitted the length budget the renderer applies (63 minus len("build-") = 57), so any
// service whose sanitized name ran past 57 characters produced a name that exists nowhere: the
// kaniko Job applied and ran, `kubectl get job <name>` answered NotFound, and executeBuild failed
// the whole BUILD with "watch build job failed" — a message pointing nowhere near the cause (#2032).
//
// Two derivations of one name is the defect, not the omitted cap; a second copy with the cap added
// would drift again the next time the renderer changed.
func buildJobName(serviceName string) string {
	return imagebuild.BuildJobName(serviceName)
}

// resolveHeadSHA pins the commit a build renders against: a shallow clone (with the job's
// git token when one exists) and HeadSHA. The clone is a data fetch only — nothing from
// the repository executes on the runner.
func (w *Runner) resolveHeadSHA(ctx context.Context, jobID, repoURL string, stderr *JobLogger) (string, error) {
	if repoURL == "" {
		return "", fmt.Errorf("service has no repo_url")
	}
	dir, err := os.MkdirTemp("", "alethia-build-pin-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)

	token, err := w.api.FetchGitToken(jobID, repoURL)
	if err != nil {
		fmt.Fprintf(stderr, "No git token (%v); attempting public clone.\n", err)
		token = ""
	}
	repo := git.NewGITWithToken(repoURL, dir, false, token)
	if err := repo.Clone(ctx, "", false); err != nil {
		return "", fmt.Errorf("clone for commit pinning: %w", err)
	}
	return repo.HeadSHA()
}

// waitForJob polls the build Job's conditions until Complete, Failed, or the deadline.
func (w *Runner) waitForJob(ctx context.Context, name, namespace string, stdout, stderr *JobLogger) error {
	deadline := time.Now().Add(buildWaitTimeout)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		out, err := w.kubectlOutput(ctx, "get", "job", name, "-n", namespace,
			"-o", `jsonpath={range .status.conditions[*]}{.type}={.status} {end}`)
		if err != nil {
			return fmt.Errorf("watch build job %s: %w", name, err)
		}
		switch {
		case strings.Contains(out, "Complete=True"):
			return nil
		case strings.Contains(out, "Failed=True"):
			return fmt.Errorf("build job %s failed (kaniko exited non-zero)", name)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("build job %s did not complete within %s", name, buildWaitTimeout)
		}
		fmt.Fprintf(stdout, "Build %s in progress...\n", name)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(buildPollInterval):
		}
	}
}

// runKubectl runs one bounded kubectl invocation, streaming combined output to the log.
func (w *Runner) runKubectl(ctx context.Context, stderr *JobLogger, args ...string) error {
	cctx, cancel := context.WithTimeout(ctx, kubectlTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", append(args, "--request-timeout=30s")...)
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(stderr, "kubectl %s: %s\n", strings.Join(args, " "), strings.TrimSpace(string(out)))
		return fmt.Errorf("kubectl %s: %w", args[0], err)
	}
	return nil
}

// kubectlOutput runs one bounded kubectl invocation and returns its stdout.
func (w *Runner) kubectlOutput(ctx context.Context, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, kubectlTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", append(args, "--request-timeout=30s")...).Output()
	if err != nil {
		// `.Output()` fills ExitError.Stderr and nothing was reading it, so a missing CRD, an RBAC
		// refusal and an unreachable API server all reached the operator as `exit status 1` — three
		// faults with three different next steps, rendered as one number. Kept OUT of the returned
		// value: callers here parse stdout for a digest, and folding kubectl's error text into it
		// would hand them a string that can match on the failure path.
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			if msg := strings.TrimSpace(string(ee.Stderr)); msg != "" {
				return strings.TrimSpace(string(out)), fmt.Errorf("%w: %s", err, msg)
			}
		}
		return strings.TrimSpace(string(out)), err
	}
	return strings.TrimSpace(string(out)), nil
}

// kubectlApplyManifest applies one manifest (JSON or YAML) from stdin.
func (w *Runner) kubectlApplyManifest(ctx context.Context, manifest string, stderr *JobLogger) error {
	cctx, cancel := context.WithTimeout(ctx, kubectlTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "apply", "-f", "-", "--request-timeout=30s")
	cmd.Stdin = strings.NewReader(manifest)
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(stderr, "kubectl apply: %s\n", strings.TrimSpace(string(out)))
		return fmt.Errorf("kubectl apply: %w", err)
	}
	return nil
}

// ── pure helpers (unit-tested in build_test.go) ─────────────────────

// repoSourcedServices filters the environment's services to the buildable ones.
func repoSourcedServices(services []types.ProjectServiceConfig) []types.ProjectServiceConfig {
	out := make([]types.ProjectServiceConfig, 0, len(services))
	for _, s := range services {
		if s.Source.Kind == "repo" {
			out = append(out, s)
		}
	}
	return out
}

// extractOutputStr reads a string tofu output, unwrapping the {value: …} envelope
// tofu's JSON output format uses.
func extractOutputStr(outputs map[string]interface{}, key string) string {
	raw, ok := outputs[key]
	if !ok {
		return ""
	}
	if env, ok := raw.(map[string]interface{}); ok {
		if v, exists := env["value"]; exists {
			raw = v
		}
	}
	s, _ := raw.(string)
	return s
}

// extractOutputStringMap reads a map(string) tofu output, unwrapping the {value: …}
// envelope tofu's JSON output format uses.
func extractOutputStringMap(outputs map[string]interface{}, key string) map[string]string {
	raw, ok := outputs[key]
	if !ok {
		return nil
	}
	if env, ok := raw.(map[string]interface{}); ok {
		if v, exists := env["value"]; exists {
			raw = v
		}
	}
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		if s, ok := v.(string); ok && s != "" {
			out[k] = s
		}
	}
	return out
}

// Defaults for the build-SA contract when the template output is absent (pre-W2 state) —
// they mirror infra/templates/project/aws/irsa.tf's locals verbatim.
const (
	defaultBuildNamespace      = "alethia-build"
	defaultBuildServiceAccount = "kaniko-builder"
)

// splitBuildServiceAccount parses the template's "namespace:serviceaccount" contract
// output, falling back to the fixed defaults.
func splitBuildServiceAccount(v string) (namespace, sa string) {
	if parts := strings.SplitN(v, ":", 2); len(parts) == 2 && parts[0] != "" && parts[1] != "" {
		return parts[0], parts[1]
	}
	return defaultBuildNamespace, defaultBuildServiceAccount
}

// gitContextFor composes kaniko's git build context pinned to the exact commit:
// "git://<host>/<path>.git#<sha>" (the #587 renderer contract).
func gitContextFor(repoURL, sha string) string {
	u := strings.TrimSpace(repoURL)
	u = strings.TrimPrefix(u, "https://")
	u = strings.TrimPrefix(u, "http://")
	u = strings.TrimPrefix(u, "git://")
	u = strings.TrimSuffix(u, "/")
	if !strings.HasSuffix(u, ".git") {
		u += ".git"
	}
	return "git://" + u + "#" + sha
}

// kanikoDigestRe matches the pushed-image digest kaniko logs on success.
var kanikoDigestRe = regexp.MustCompile(`sha256:[a-f0-9]{64}`)

// parseKanikoDigest extracts the pushed image digest from kaniko's log output ("" when no
// digest line is present).
// buildJobPodSelector labels a build Job's pods.
//
// `job-name` rather than `batch.kubernetes.io/job-name`: both are set on a current cluster, and
// only the legacy one exists on an older control plane, so this is the wider of the two. It is also
// what this file already used for the termination-message read.
const buildJobPodSelector = "job-name="

func parseKanikoDigest(logs string) string {
	return kanikoDigestRe.FindString(logs)
}

// namespaceManifest renders the minimal namespace the build Jobs run in.
func namespaceManifest(name string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %s
  labels:
    app.kubernetes.io/managed-by: alethia
`, name)
}

// shortID returns the first n runes-worth of bytes of s, or all of s when it is shorter than n —
// a panic-safe replacement for s[:n] on ids of unknown length (a short runner_id / job id must
// not crash a log line with a slice-bounds panic).
func shortID(s string, n int) string {
	if n < 0 || len(s) < n {
		return s
	}
	return s[:n]
}

// shortSHA12 abbreviates a SHA for log lines.
func shortSHA12(sha string) string {
	return shortID(sha, 12)
}
