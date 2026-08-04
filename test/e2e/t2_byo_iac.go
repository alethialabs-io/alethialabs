// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T2 BRING-YOUR-OWN IaC continuous-proof leg (#1765, the cloud-tier half of #845's BYO bullet) —
// the PURE, reusable half. Deliberately UNTAGGED (like t2_soak.go / t2_fabric_demo.go) so
// `go mod tidy` sees its deps and the resolve / parse / mutation-argv / verdict logic is
// unit-tested WITHOUT Postgres, a cloud, or a build tag (t2_byo_iac_pure_test.go).
//
// # What this leg proves, and why each step is there
//
// The BYO path is the one place Alethia runs code it did not write. The claim is not "a customer
// module can be applied" — it is the whole custody chain around it:
//
//	clone at a PINNED SHA  →  fail-closed iacsafety gate  →  signed verify receipt over the
//	CUSTOMER's own plan  →  apply  →  state held on ALETHIA's proxy, never by the customer  →
//	induced OUT-OF-BAND change  →  posture FLIPS to drifted  →  heal  →  in-sync  →  DESTROY  →
//	state cleared
//
// # The induced-drift decision
//
// #1765 originally proposed repeatedly re-proving one unchanged pinned commit, which needs no
// cloud resource at all. That was overruled: at the cloud tier a leg must INDUCE real drift and
// watch the posture flip. Re-running a refresh-only plan against a module nothing has touched
// re-proves the PIPELINE; it cannot distinguish a working drift detector from one that reports
// in_sync unconditionally. Only a mutation made behind Alethia's back can.
//
// The cost of that decision is that each cloud needs its own module owning one real mutable
// resource, so this leg is per-provider rather than cloud-agnostic. Each module owns exactly one
// object, chosen as the cheapest thing on that cloud that can genuinely drift (an SSM parameter,
// an empty resource group, a project-metadata item, an empty OSS bucket, an empty placement
// group) — no cluster, no VM, no gateway.
//
// # How each way this leg could go VACUOUS is defeated
//
//   - "the gate rubber-stamps everything" → a NEGATIVE case runs first: a second module in the
//     same repo at the same pinned SHA declares a provider that is NOT allowlisted, and its job
//     must FAIL with a provider-not-allowlisted finding. A gate that passes everything looks
//     exactly like a gate that works.
//   - "the pin didn't matter" → the SHA is resolved ONCE from the remote ref and every one of the
//     five jobs carries that same 40-hex commit; the runner's own "cloning … at pinned commit"
//     line must appear in the SHIPPED logs, so the assertion reads the runner's behaviour rather
//     than the harness's intent.
//   - "state was on the customer's backend" → the module declares NO backend; the platform
//     override forces the http proxy. The proxy is the harness's own recording control plane, so
//     non-empty state there with >0 managed instances is proof it is the sole sink.
//   - "the run quietly built a cluster" → the module emits NO cluster_name output, and that is
//     asserted MECHANICALLY against the state's outputs (not just documented), plus cluster_name
//     empty and cluster_ready false in the job metadata. That single omission is what keeps the
//     entire kubeconfig → CNI → ArgoCD tail off (provisioner/deploy.go: `if result.ClusterName != ""`).
//   - "the variables never reached the module" → the alethia_context output must equal
//     <project>/<environment>, which only the runner's frozen TF_VAR_alethia_* injection can produce.
//   - "drift was never really detected" → the posture must be in_sync BEFORE the mutation and
//     drifted AFTER it, and the drifted resource's TYPE must be this provider's probe resource —
//     so an unrelated wobble somewhere else cannot be credited as the induced drift.
//   - "it drifted and stayed broken" → a heal DEPLOY re-applies the SAME pinned commit and a third
//     DETECT_DRIFT must return to in_sync. Detection without convergence is half a claim.
//   - "the receipt is a signed envelope around nothing" → VerifySignedReceipt runs
//     AssertReceiptEvidence, so the receipt must carry real controls with a coherent tally.
package e2e

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// Env vars this leg reads. Every one must be referenced by .github/workflows/e2e-nightly.yml (as
// `${{ vars.X }}`, which keeps the leg OFF until a maintainer opts in) or
// TestScenarioEnablesReachTheNightly fails the build — a harness the nightly can never reach is
// dead code that looks shipped.
const (
	envByoIac            = "ALETHIA_E2E_BYO_IAC"
	envByoIacRepo        = "ALETHIA_E2E_BYO_IAC_REPO"
	envByoIacPath        = "ALETHIA_E2E_BYO_IAC_PATH"
	envByoIacRef         = "ALETHIA_E2E_BYO_IAC_REF"
	envByoIacBlockedPath = "ALETHIA_E2E_BYO_IAC_BLOCKED_PATH"
	envByoIacTimeout     = "ALETHIA_E2E_BYO_IAC_TIMEOUT"
	envByoIacSummary     = "ALETHIA_E2E_BYO_IAC_SUMMARY"
)

// byoIacDefaultRepo is the PUBLIC enterprise-demo repo — the same one the #845 fabric-demo gate
// defaults to. Public matters twice over here: prepareByoIacWorkdir clones anonymously when the
// git token is empty and validateByoRepoURL accepts https, so a public repo needs no git server,
// no token and no new maintainer-held secret. It is also honest about what BYO means — the module
// lives in a repo Alethia does not own the state of.
const byoIacDefaultRepo = "https://github.com/alethialabs-io/enterprise-demo"

// byoIacDefaultRef is the branch the pinned SHA is resolved FROM. The SHA — never this ref — is
// what every job carries; the ref is only how the harness discovers it once, at the top of the run.
const byoIacDefaultRef = "main"

// byoIacDefaultPathPrefix + the provider name is the per-cloud module directory
// (iac/drift/aws, iac/drift/gcp, …). Per-cloud because inducing real drift needs a real mutable
// resource, and there is no cloud-agnostic one.
const byoIacDefaultPathPrefix = "iac/drift/"

// byoIacDefaultBlockedPath is the NEGATIVE fixture: a module in the same repo, at the same pinned
// commit, declaring a provider that is not on DefaultProviderAllowlist. It provisions nothing —
// the gate refuses it before `tofu init` resolves anything — and it is what stops the gate
// assertion from being "the deploy succeeded, so presumably something was checked".
const byoIacDefaultBlockedPath = "iac/blocked"

// byoIacBaselineMarker is the module's default drift_marker. The out-of-band mutation moves the
// live value AWAY from it; the heal apply puts it back.
const byoIacBaselineMarker = "baseline"

// byoIacProbeResourceType maps a provider onto the ONE resource type its drift module owns. It is
// the non-vacuity key for the drift assertion: the posture must flip because THIS resource
// changed, not because something unrelated wobbled. A provider absent from this table has no
// module, so the leg refuses to run rather than reporting a green skip.
var byoIacProbeResourceType = map[string]string{
	"aws":     "aws_ssm_parameter",
	"gcp":     "google_compute_project_metadata_item",
	"azure":   "azurerm_resource_group",
	"alibaba": "alicloud_oss_bucket",
	"hetzner": "hcloud_placement_group",
}

// byoIacEnabled reports whether the opt-in leg should run. Off by default: the base T2 proof is
// unchanged unless a maintainer sets ALETHIA_E2E_BYO_IAC.
func byoIacEnabled() bool { return t2Truthy(os.Getenv(envByoIac)) }

// byoIacRepo resolves the customer repo for this cloud, per-provider-overridable via the shared
// <BASE>_<PROVIDER> idiom, defaulting to the public enterprise-demo.
func byoIacRepo(provider string) string {
	return t2ArgoEnvForProvider(envByoIacRepo, provider, byoIacDefaultRepo)
}

// byoIacRef resolves the branch/tag the pinned SHA is read from.
func byoIacRef(provider string) string {
	return t2ArgoEnvForProvider(envByoIacRef, provider, byoIacDefaultRef)
}

// byoIacPath resolves the module directory inside the repo, defaulting to iac/drift/<provider>.
// The default is derived rather than listed so adding a cloud to byoIacProbeResourceType and
// adding its directory upstream is the whole change.
func byoIacPath(provider string) string {
	return t2ArgoEnvForProvider(envByoIacPath, provider, byoIacDefaultPathPrefix+strings.ToLower(strings.TrimSpace(provider)))
}

// byoIacBlockedPath resolves the negative fixture's directory.
func byoIacBlockedPath(provider string) string {
	return t2ArgoEnvForProvider(envByoIacBlockedPath, provider, byoIacDefaultBlockedPath)
}

// byoIacTimeout bounds each job wait — ALETHIA_E2E_BYO_IAC_TIMEOUT when set (a Go duration), else
// 15m. Each wait returns the moment the job goes terminal, so the default only costs time on a
// genuinely stuck job.
func byoIacTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv(envByoIacTimeout)); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return 15 * time.Minute
}

// isFullCommitSHA reports whether s is a full 40-character lowercase-hex git commit id. The BYO
// contract REQUIRES a pinned full SHA (a ref alone is TOCTOU-unsafe), so a short or abbreviated
// id must be refused rather than silently passed to the runner.
func isFullCommitSHA(s string) bool {
	if len(s) != 40 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f':
		default:
			return false
		}
	}
	return true
}

// parseLsRemoteSHA extracts the commit id from `git ls-remote <repo> <ref>` output. ls-remote
// prints one "<sha>\t<refname>" line per match and can print SEVERAL (refs/heads/main and
// refs/tags/main both match the bare name "main"), so an ambiguous answer is an ERROR: silently
// taking the first line would pin whichever ref git happened to list first, and the whole point of
// this leg is that the pin is deliberate.
func parseLsRemoteSHA(out, ref string) (string, error) {
	type hit struct{ sha, name string }
	var hits []hit
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		sha, name, ok := strings.Cut(line, "\t")
		if !ok {
			sha, name, ok = strings.Cut(line, " ")
		}
		if !ok {
			continue
		}
		sha = strings.TrimSpace(sha)
		name = strings.TrimSpace(name)
		// A peeled annotated tag (refs/tags/x^{}) and its tag object both appear; the peeled
		// entry is the commit, so drop the unpeeled duplicate when both are present.
		if !isFullCommitSHA(sha) {
			continue
		}
		hits = append(hits, hit{sha: sha, name: name})
	}
	if len(hits) == 0 {
		return "", fmt.Errorf("git ls-remote resolved no commit for ref %q — the repo or the ref is wrong (output: %q)", ref, strings.TrimSpace(out))
	}
	if len(hits) > 1 {
		// Prefer the peeled tag if that is the only disambiguation needed.
		var peeled []hit
		for _, h := range hits {
			if strings.HasSuffix(h.name, "^{}") {
				peeled = append(peeled, h)
			}
		}
		if len(peeled) == 1 {
			return peeled[0].sha, nil
		}
		names := make([]string, 0, len(hits))
		for _, h := range hits {
			names = append(names, h.name)
		}
		return "", fmt.Errorf("git ls-remote matched %d refs for %q (%s) — the pin would be ambiguous; name the ref fully (refs/heads/… or refs/tags/…)", len(hits), ref, strings.Join(names, ", "))
	}
	return hits[0].sha, nil
}

// byoIacSource is the ProjectIacSourceConfig shape the console would persist, built here by the
// harness because the T2 control plane seeds jobs by direct SQL and therefore never runs
// attachIacSource / scanIacSource. Everything the runner needs is in the snapshot.
type byoIacSource struct {
	RepoURL   string
	Ref       string
	Path      string
	CommitSHA string
}

// snapshotFragment renders the source as the `iac_source` block of a config_snapshot. Marshalled
// through the same JSON tags the runner decodes (types.ProjectIacSourceConfig), so a rename on
// either side cannot drift silently past this.
func (s byoIacSource) snapshotFragment() map[string]any {
	return map[string]any{
		"repo_url":   s.RepoURL,
		"ref":        s.Ref,
		"path":       s.Path,
		"commit_sha": s.CommitSHA,
		"var_values": map[string]any{},
	}
}

// validate refuses a source that could not prove anything. An empty repo, a non-https transport
// (validateByoRepoURL would refuse it at the runner, but failing here costs no cloud time), an
// empty path, or an unpinned/abbreviated commit are all hard errors.
func (s byoIacSource) validate() error {
	if strings.TrimSpace(s.RepoURL) == "" {
		return fmt.Errorf("%s resolved empty — there is no customer module to prove anything about", envByoIacRepo)
	}
	if !strings.HasPrefix(s.RepoURL, "https://") && !strings.HasPrefix(s.RepoURL, "ssh://") && !strings.HasPrefix(s.RepoURL, "git@") {
		return fmt.Errorf("%s = %q — the runner's validateByoRepoURL accepts only https/ssh transports", envByoIacRepo, s.RepoURL)
	}
	if strings.TrimSpace(s.Path) == "" {
		return fmt.Errorf("%s resolved empty — refusing to point a BYO deploy at the repository root by accident", envByoIacPath)
	}
	if !isFullCommitSHA(s.CommitSHA) {
		return fmt.Errorf("resolved commit %q is not a full 40-hex sha — a moving ref is TOCTOU-unsafe and the runner refuses it", s.CommitSHA)
	}
	return nil
}

// buildByoIacSnapshot returns the runner-facing config_snapshot for a BYO job. It carries NO
// `addons` and NO `cluster` block: a customer module emits no cluster_name, so the add-on /
// ArgoCD tail never runs and including them would only misdescribe what this leg does.
//
// Every job in the leg (deploy, drift ×3, heal, destroy) is built from THIS one function, so their
// ProviderTfvars and their pinned commit can never disagree — which is what lets the drift jobs'
// refresh-only plans reconcile the deploy's exact recorded state.
func buildByoIacSnapshot(project, env, provider, region string, src byoIacSource) map[string]any {
	return map[string]any{
		"id":                "e2e-" + env + "-byoiac",
		"project_name":      project,
		"environment_stage": env,
		"region":            region,
		"provider":          provider,
		"iac_source":        src.snapshotFragment(),
	}
}

// tfstateOutputs is the `outputs` section of an OpenTofu state document.
type tfstateOutputs map[string]struct {
	Value     any  `json:"value"`
	Sensitive bool `json:"sensitive"`
}

// parseTfstateOutputs reads the root outputs out of a state document. An empty or unparseable
// document is an error — a leg that shrugged at unreadable state would assert nothing.
func parseTfstateOutputs(state []byte) (tfstateOutputs, error) {
	if len(strings.TrimSpace(string(state))) == 0 {
		return nil, errors.New("state document is empty")
	}
	var st struct {
		Outputs tfstateOutputs `json:"outputs"`
	}
	if err := json.Unmarshal(state, &st); err != nil {
		return nil, fmt.Errorf("parse tfstate: %w", err)
	}
	return st.Outputs, nil
}

// outputString reads a string-valued output, erroring when it is absent or not a string.
func (o tfstateOutputs) outputString(name string) (string, error) {
	v, ok := o[name]
	if !ok {
		return "", fmt.Errorf("the module emitted no %q output", name)
	}
	s, ok := v.Value.(string)
	if !ok {
		return "", fmt.Errorf("output %q is %T, want a string", name, v.Value)
	}
	if strings.TrimSpace(s) == "" {
		return "", fmt.Errorf("output %q is empty", name)
	}
	return s, nil
}

// assertNoClusterNameOutput is the MECHANICAL form of this leg's load-bearing omission.
//
// provisioner/deploy.go continues into kubeconfig → CNI → reachability → ArgoCD → add-ons only
// `if result.ClusterName != ""`, and ClusterName comes from cloud.ExtractClusterName over the
// module's outputs. So a customer module that emits a cluster_name (or a provider-specific alias
// ExtractClusterName recognises) silently turns this cheap probe into a full cluster provision —
// with the cost and the runtime that implies. Documenting the omission in the module's comments is
// not enough; a comment cannot fail a build.
func assertNoClusterNameOutput(o tfstateOutputs) error {
	for _, name := range []string{"cluster_name", "eks_cluster_name", "gke_cluster_name", "aks_cluster_name", "ack_cluster_name", "talos_cluster_name"} {
		if _, present := o[name]; present {
			return fmt.Errorf("the customer module emits a %q output — that is exactly the signal that makes the runner continue into the kubeconfig → CNI → ArgoCD tail, so this probe would provision a real cluster instead of one cheap resource", name)
		}
	}
	return nil
}

// byoIacMutationOpts carries the ambient context two of the five CLIs need. Passed explicitly
// rather than read from the environment inside the builder so the argv stays a pure function of
// its inputs and the unit tests can pin every flag.
type byoIacMutationOpts struct {
	// Region is required by `aliyun oss`: its endpoint is built as oss-<region>.aliyuncs.com, and
	// when neither --region nor a profile region resolves, the CLI hard-errors. Passing it removes
	// the dependency on whatever profile the workflow happened to leave behind.
	Region string
	// Account is the GCP project id. gcloud CAN take it from CLOUDSDK_CORE_PROJECT, but the ambient
	// variable this repo's harness actually resolves is GOOGLE_PROJECT (a Terraform provider
	// variable that gcloud does NOT read), so relying on ambient resolution would work for tofu and
	// silently target the wrong — or no — project for the CLI. Empty ⇒ the flag is omitted and
	// gcloud falls back to its own configuration.
	Account string
}

// byoIacMutationArgv returns the OUT-OF-BAND command that changes the one value the module owns,
// for this provider's probe resource. It deliberately does NOT go through tofu: editing
// drift_marker and re-applying is an ordinary change and proves nothing about detecting what
// happened behind Alethia's back.
//
// Four of the five are targeted single-key updates that leave everything else in the account
// alone:
//
//	aws      put-parameter --overwrite on ONE parameter name. --type String is kept so the same
//	         command works whether the parameter is being created or updated; changing an existing
//	         parameter's type would raise HierarchyTypeMismatchException, and we never do.
//	azure    az group update --set tags.<key> — reads, mutates in memory, writes back, so other
//	         tags survive. --force-string stops the CLI's shell_safe_json_parse from coercing a
//	         value that happens to look like JSON into a non-string.
//	gcp      add-metadata — documented as "only metadata keys that are provided are mutated".
//	hetzner  add-label --overwrite — merges into the existing label map; WITHOUT --overwrite the
//	         CLI refuses an existing key, which in CI would look like a broken probe.
//
// Alibaba is the exception, and deliberately so: `aliyun oss bucket-tagging --method put` maps to
// PUT /?tagging, which REPLACES the whole tag set — so this also drops the module's three
// descriptive tags. That is still a genuine out-of-band change to the probe resource (which is all
// the drift assertion claims), and the heal apply restores all four tags. The alternative — echoing
// every tag back on every mutation — would couple this argv to the module's tag list and break
// quietly the first time the module gained a tag.
//
// An unknown provider is a hard error: returning a no-op argv would let the leg "induce" nothing
// and then read the unchanged in_sync posture as a pass.
func byoIacMutationArgv(provider, target, newValue string, opts byoIacMutationOpts) ([]string, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if strings.TrimSpace(target) == "" {
		return nil, errors.New("drift target is empty — nothing to mutate, so the drift assertion would be vacuous")
	}
	if strings.TrimSpace(newValue) == "" {
		return nil, errors.New("the new drift-marker value is empty")
	}
	if newValue == byoIacBaselineMarker {
		return nil, fmt.Errorf("the new drift-marker value equals the module's baseline %q — the live value would not change and no drift could be detected", byoIacBaselineMarker)
	}
	switch provider {
	case "aws":
		return []string{"aws", "ssm", "put-parameter", "--name", target, "--type", "String", "--value", newValue, "--overwrite"}, nil
	case "azure":
		return []string{"az", "group", "update", "--name", target, "--force-string", "--set", "tags.drift_marker=" + newValue}, nil
	case "gcp":
		argv := []string{"gcloud", "compute", "project-info", "add-metadata", "--metadata", target + "=" + newValue}
		if a := strings.TrimSpace(opts.Account); a != "" {
			argv = append(argv, "--project", a)
		}
		return argv, nil
	case "alibaba":
		region := strings.TrimSpace(opts.Region)
		if region == "" {
			return nil, errors.New("alibaba out-of-band mutation needs a region: `aliyun oss` builds its endpoint as oss-<region>.aliyuncs.com and hard-errors without one")
		}
		return []string{"aliyun", "oss", "bucket-tagging", "--method", "put", "--region", region, "oss://" + target, "drift_marker#" + newValue}, nil
	case "hetzner":
		return []string{"hcloud", "placement-group", "add-label", "--overwrite", target, "drift_marker=" + newValue}, nil
	}
	return nil, fmt.Errorf("no out-of-band mutation is wired for provider %q — this leg cannot induce drift there, so it must not claim to have detected any", provider)
}

// byoIacDriftedProbe reports whether the posture's drifted resources include THIS provider's probe
// resource type. Without it, any unrelated drift in the same state would be credited as the
// induced change and the leg would pass for the wrong reason.
func byoIacDriftedProbe(provider string, types []string) bool {
	want, ok := byoIacProbeResourceType[strings.ToLower(strings.TrimSpace(provider))]
	if !ok {
		return false
	}
	for _, t := range types {
		if strings.TrimSpace(t) == want {
			return true
		}
	}
	return false
}

// ByoIacSummary is the machine-readable result of the BYO-IaC continuous-proof leg, written to
// ALETHIA_E2E_BYO_IAC_SUMMARY so the proof capture can fold one line into the per-provider step
// summary. It carries only names, booleans, counts and the PUBLIC plan digest + commit — no
// secrets (the repo is public and the module holds nothing).
type ByoIacSummary struct {
	Enabled  bool   `json:"enabled"`
	Provider string `json:"provider"`
	Repo     string `json:"repo"`
	Ref      string `json:"ref"`
	Path     string `json:"path"`
	// PinnedSHA is the commit EVERY job in this leg carried — resolved once from the remote ref.
	PinnedSHA string `json:"pinned_commit_sha"`
	// GateBlockedNonAllowlisted is the negative case: a module at the same commit declaring a
	// provider off the allowlist must FAIL. Without it the gate assertion proves nothing.
	GateBlockedNonAllowlisted bool `json:"gate_blocked_non_allowlisted"`
	// CloneAtPinnedLogged is the runner's OWN "cloning … at pinned commit <sha>" line, read back
	// out of the shipped job logs rather than inferred from what the harness asked for.
	CloneAtPinnedLogged bool   `json:"clone_at_pinned_commit_logged"`
	GatePassedLogged    bool   `json:"gate_passed_logged"`
	DeployStatus        string `json:"deploy_status"`
	// ReceiptPlanSHA is the digest the signed receipt over the CUSTOMER's plan was sealed to.
	ReceiptPlanSHA string `json:"receipt_plan_sha256"`
	// StateResources / StateOnProxy prove Alethia's proxy is the sole state sink.
	StateOnProxy   bool `json:"state_on_proxy"`
	StateResources int  `json:"state_resources"`
	// NoClusterNameOutput is the mechanically-checked omission that keeps the cluster tail off.
	NoClusterNameOutput bool   `json:"no_cluster_name_output"`
	AlethiaContextEcho  string `json:"alethia_context"`
	DriftTarget         string `json:"drift_target"`
	// The three postures, in order: clean apply → induced change → heal.
	BaselineInSync  bool     `json:"baseline_in_sync"`
	MutationApplied bool     `json:"mutation_applied"`
	DriftedCount    int      `json:"drifted_count"`
	DriftedTypes    []string `json:"drifted_types"`
	DriftedIsProbe  bool     `json:"drifted_is_probe_resource"`
	HealStatus      string   `json:"heal_status"`
	HealedInSync    bool     `json:"healed_in_sync"`
	DestroyStatus   string   `json:"destroy_status"`
	StateCleared    bool     `json:"state_cleared"`
	Verdict         string   `json:"verdict"`
}

// byoIacVerdictPass reports whether every step that RAN passed non-vacuously. There is no partial
// credit: the leg's claim is the whole custody chain, and any link missing makes the claim false.
func byoIacVerdictPass(s ByoIacSummary) bool {
	if !s.Enabled {
		return false
	}
	if !isFullCommitSHA(s.PinnedSHA) {
		return false
	}
	if !s.GateBlockedNonAllowlisted || !s.CloneAtPinnedLogged || !s.GatePassedLogged {
		return false
	}
	if s.DeployStatus != "SUCCESS" || len(s.ReceiptPlanSHA) != 64 {
		return false
	}
	if !s.StateOnProxy || s.StateResources == 0 || !s.NoClusterNameOutput {
		return false
	}
	if strings.TrimSpace(s.AlethiaContextEcho) == "" || strings.TrimSpace(s.DriftTarget) == "" {
		return false
	}
	// The three postures in order. A drifted count of zero after a real mutation is the failure
	// this whole leg exists to catch, and it must never read green.
	if !s.BaselineInSync || !s.MutationApplied || s.DriftedCount == 0 || !s.DriftedIsProbe {
		return false
	}
	if s.HealStatus != "SUCCESS" || !s.HealedInSync {
		return false
	}
	return s.DestroyStatus == "SUCCESS" && s.StateCleared
}

// byoIacSummaryVerdict renders the one-line human verdict embedded in ByoIacSummary.Verdict.
func byoIacSummaryVerdict(s ByoIacSummary) string {
	if !s.Enabled {
		return "byo-iac: skipped (" + envByoIac + " unset)"
	}
	icon := "✅"
	if !byoIacVerdictPass(s) {
		icon = "❌"
	}
	drifted := "none"
	if len(s.DriftedTypes) > 0 {
		drifted = strings.Join(s.DriftedTypes, ",")
	}
	return fmt.Sprintf("%s byo-iac on %s: %s@%s %s · gate-blocks-bad=%t · pinned-clone-logged=%t · receipt=%s · state-on-proxy=%t(%d res) · no-cluster-output=%t · ctx=%s · drift baseline-in-sync=%t → induced(%s)=%d[%s] → healed-in-sync=%t · destroy=%s state-cleared=%t",
		icon, s.Provider, s.Path, shortPlanSHA(s.PinnedSHA), s.Repo,
		s.GateBlockedNonAllowlisted, s.CloneAtPinnedLogged, shortPlanSHA(s.ReceiptPlanSHA),
		s.StateOnProxy, s.StateResources, s.NoClusterNameOutput, s.AlethiaContextEcho,
		s.BaselineInSync, s.DriftTarget, s.DriftedCount, drifted, s.HealedInSync,
		s.DestroyStatus, s.StateCleared)
}

// writeByoIacSummary persists the summary as indented JSON (names, booleans, counts, a public
// commit id and a public plan digest — no secrets).
func writeByoIacSummary(path string, s ByoIacSummary) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}
