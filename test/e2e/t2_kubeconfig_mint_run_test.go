// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// KUBECONFIG-MINT orchestration (#5287) — the e2e_t2-tagged half that drives the pure surface
// (t2_kubeconfig_mint.go) against a live cluster. Invoked from TestT2RealCloudProvisioning after the
// day-2 access layer and BEFORE the guaranteed teardown, while the runner process is still serving.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// kubeconfigMintParams carries what the proof needs from the run under test.
type kubeconfigMintParams struct {
	provider    string
	region      string
	deployJobID string    // the DEPLOY whose state and snapshot the mint reads
	owner       string    // the runner's org (= user): the mint's tenancy
	graph       *a05Graph // the A0.5 project/environment, or nil
	clusterName string    // what the deploy reported (execution_metadata.cluster_name)
	cliDemo     *CLIDemoRun
}

// kubeconfigMintExecClouds are the clouds whose credential an exec plugin can re-mint (#5250
// decision 4). Hetzner and Alibaba issue certificates, so they are static-only BY DESIGN.
var kubeconfigMintExecClouds = map[string]bool{"aws": true, "gcp": true, "azure": true}

// mintedTier is one tier's credential, held in memory only.
type mintedTier struct {
	kc       staticKubeconfig
	file     string    // the kubeconfig on disk (0600, in the test's temp dir), for kubectl
	reported time.Time // the runner's reported expiry, when the driver can see it
	row      *mintRequestRow
}

// runT2KubeconfigMint mints a read-only and an admin kubeconfig and holds each to its tier. ON unless
// ALETHIA_E2E_KUBECONFIG_MINT is falsy. Bounded by kubeconfigMintBudget (its ladder term). A failure
// names its stage; the summary is written on every path that gets far enough to have one.
func runT2KubeconfigMint(t *testing.T, ctx context.Context, cp *ControlPlane, p kubeconfigMintParams) {
	t.Helper()
	if !KubeconfigMintEnabled() {
		t.Logf("kubeconfig-mint: skipped (%s is off)", envKubeconfigMint)
		return
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, kubeconfigMintBudget)
	defer cancel()

	driver := kubeconfigMintDriverRunner
	if p.cliDemo != nil {
		driver = kubeconfigMintDriverCLI
	}
	s := KubeconfigMintSummary{Enabled: true, Provider: p.provider, Driver: driver}
	var secrets []string
	failAt := func(stage, detail string) {
		if s.FailedStage == "" {
			s.FailedStage, s.FailedDetail = stage, detail
		}
	}
	dir := t.TempDir()
	suffix := t2ShortHex(t)
	t.Logf("kubeconfig-mint: minting read-only and admin kubeconfigs via %s (ttl %s)…", driver, kubeconfigMintTTL)

	var mint func(tier string) (mintedTier, error)
	switch driver {
	case kubeconfigMintDriverCLI:
		mint = func(tier string) (mintedTier, error) {
			return mintViaCLI(ctx, cp, p.cliDemo, tier, filepath.Join(dir, tier+".kubeconfig"))
		}
	default:
		target, err := prepareRunnerChannelTarget(ctx, cp, p)
		if err != nil {
			failAt(mintStageSetup, err.Error())
			finishKubeconfigMint(t, &s, secrets, started)
			return
		}
		mint = func(tier string) (mintedTier, error) {
			return mintViaRunnerChannel(ctx, cp, target, tier, filepath.Join(dir, tier+".kubeconfig"))
		}
	}

	for _, tier := range requiredStaticTiers {
		res := KubeconfigMintTier{Tier: tier, Shape: mintShapeStatic, TTLSeconds: int(kubeconfigMintTTL.Seconds())}
		requested := time.Now()
		m, err := mint(tier)
		secrets = append(secrets, m.kc.secrets()...)
		if m.row != nil {
			res.MintStatus, res.FailedReason, res.PrivateEndpoint = m.row.Status, m.row.FailureReason, m.row.PrivateEndpoint
			if s.PrivateEndpoint == nil {
				s.PrivateEndpoint = m.row.PrivateEndpoint
			}
		}
		if err != nil {
			res.Error = redactSecrets(err.Error(), secrets)
			finishTier(&res)
			s.Tiers = append(s.Tiers, res)
			stage := mintStageMint
			var oe *mintOpenError
			if errors.As(err, &oe) {
				stage = mintStageOpen
			}
			failAt(stage, fmt.Sprintf("%s: %s", tier, res.Error))
			continue
		}
		res.Minted = true
		res.CredentialKind = m.kc.credentialKind()
		exp, src := credentialExpiry(m.kc, m.reported)
		res.ExpirySource = src
		if !exp.IsZero() {
			res.ExpiresAt = exp.Format(time.RFC3339)
			in := int64(time.Until(exp).Seconds())
			res.ExpiresInSec = &in
		}
		if tier == mintTierReadonly {
			ok := true
			if eerr := readOnlyExpiryOK(exp, src, requested, time.Now(), kubeconfigMintTTL); eerr != nil {
				ok = false
				res.ExpiryError = eerr.Error()
				failAt(mintStageExpiry, eerr.Error())
			}
			res.ExpiryWithinTTL = &ok
		}
		kube, err := kubeaccess.NewClient(kubeaccess.Conn{
			Server: m.kc.Server, CAData: m.kc.CAData, Token: m.kc.Token,
			ClientCertData: m.kc.ClientCertData, ClientKeyData: m.kc.ClientKeyData, Timeout: 30 * time.Second,
		})
		if err != nil {
			res.Error = err.Error()
		} else {
			checks := readOnlyChecks(suffix)
			if tier == mintTierAdmin {
				checks = adminChecks(suffix)
			}
			awaitFirstRead(ctx, kube, "/api/v1/nodes", 30*time.Second, 2*time.Second)
			res.Checks = runKubeChecks(ctx, kube, checks)
			res.Checks = append(res.Checks, kubectlUsable(ctx, m.file))
		}
		finishTier(&res)
		if res.Verdict != "PASS" && s.FailedStage == "" {
			failAt(mintStageAssert, tier+": "+firstFailingCheck(res))
		}
		s.Tiers = append(s.Tiers, res)
	}

	// The exec shape, where the cloud supports it and the real binary is here to be the plugin.
	if driver == kubeconfigMintDriverCLI && kubeconfigMintExecClouds[p.provider] {
		res, sec := execShapeThroughCLI(ctx, cp, p.cliDemo, filepath.Join(dir, "exec.kubeconfig"))
		secrets = append(secrets, sec...)
		if res.Verdict != "PASS" {
			failAt(mintStageExec, firstFailingCheck(res)+res.Error)
		}
		s.Tiers = append(s.Tiers, res)
	}

	finishKubeconfigMint(t, &s, secrets, started)
}

// finishKubeconfigMint runs the canary over the bundle's sources, writes the summary, and fails the
// test at the named stage when the proof did not pass.
func finishKubeconfigMint(t *testing.T, s *KubeconfigMintSummary, secrets []string, started time.Time) {
	t.Helper()
	s.DurationSeconds = time.Since(started).Round(100 * time.Millisecond).Seconds()
	sources := []string{os.Getenv("ALETHIA_E2E_T2_RUNNER_LOG"), os.Getenv("ALETHIA_E2E_T2_TEST_LOG")}
	if len(secrets) == 0 {
		// Nothing was minted, so there is nothing to look for. Record it as not clean rather than
		// vouch for a bundle the canary could not test; the stage that failed earlier is the cause.
		s.CanaryClean = false
		if s.FailedStage == "" {
			s.FailedStage, s.FailedDetail = mintStageCanary, "no credential was minted, so the canary had nothing to look for"
		}
	} else {
		scanned, hits, err := scanFilesForSecrets(sources, secrets)
		s.CanaryScanned = scanned
		s.CanaryClean = err == nil && len(hits) == 0
		if err != nil && s.FailedStage == "" {
			s.FailedStage, s.FailedDetail = mintStageCanary, err.Error()
		}
		if len(hits) > 0 {
			// The stage is overwritten on purpose: a leaked credential outranks any other finding.
			s.FailedStage, s.FailedDetail = mintStageCanary, "a minted credential appears in: "+strings.Join(hits, ", ")
		}
	}
	if path := os.Getenv(envKubeconfigMintSummary); path != "" {
		if err := writeKubeconfigMintSummary(path, *s, secrets); err != nil {
			s.FailedStage, s.FailedDetail = mintStageSummary, err.Error()
			t.Logf("kubeconfig-mint: %v", err)
		} else {
			s.CanaryScanned = append(s.CanaryScanned, path)
		}
	}
	verdict := summarizeKubeconfigMint(*s)
	if !summaryPasses(*s) {
		t.Fatalf("kubeconfig-mint FAILED at stage %q: %s", s.FailedStage, verdict)
	}
	t.Logf("kubeconfig-mint proven: %s", verdict)
}

// firstFailingCheck names the first failed check of a tier, for the stage detail.
func firstFailingCheck(r KubeconfigMintTier) string {
	for _, c := range r.Checks {
		if !c.Pass {
			return fmt.Sprintf("%s want %s, got %s (HTTP %d %s) %s", c.Name, c.Want, c.Outcome, c.StatusCode, c.Reason, c.Error)
		}
	}
	if r.Error != "" {
		return r.Error
	}
	if r.ExpiryError != "" {
		return r.ExpiryError
	}
	return "no check ran"
}

// kubectlUsable proves the file is what a person would hand to kubectl: `kubectl get nodes` through it
// exits 0. Its stderr is never kept — only whether it worked.
func kubectlUsable(ctx context.Context, kubeconfig string) KubeCheckResult {
	r := KubeCheckResult{Name: "kubectl-get-nodes", Want: string(kubeAllowed)}
	if _, err := kubectlRead(ctx, 60*time.Second, kubeconfig, "get", "nodes", "-o", "name"); err != nil {
		r.Outcome, r.Error = string(kubeError), "kubectl could not list nodes through the minted kubeconfig"
		return r
	}
	r.Outcome, r.Pass = string(kubeAllowed), true
	return r
}

// mintOpenError marks a mint that was delivered but could not be opened or decoded — a separate
// stage from a mint that never arrived.
type mintOpenError struct{ msg string }

// Error returns the fixed description; it never carries plaintext.
func (e *mintOpenError) Error() string { return e.msg }

// ─────────────────────────── runner-channel driver ───────────────────────────

// runnerChannelTarget is the cluster row and snapshot every runner-channel mint names.
type runnerChannelTarget struct {
	owner, projectID, envID, clusterID, deployJobID string
	snapshot                                        []byte
}

// prepareRunnerChannelTarget writes the console rows a mint needs (the cluster row, the actor's
// profile) and reads the deploy's snapshot, which every mint job carries verbatim.
func prepareRunnerChannelTarget(ctx context.Context, cp *ControlPlane, p kubeconfigMintParams) (runnerChannelTarget, error) {
	tgt := runnerChannelTarget{owner: p.owner, deployJobID: p.deployJobID}
	if p.graph != nil {
		tgt.projectID, tgt.envID = p.graph.projectID, p.graph.envID
	}
	clusterID, projectID, err := cp.ensureMintCluster(ctx, p.owner, tgt.projectID, tgt.envID, p.clusterName, p.region)
	if err != nil {
		return tgt, err
	}
	tgt.clusterID, tgt.projectID = clusterID, projectID
	if tgt.snapshot, err = cp.JobConfigSnapshot(ctx, p.deployJobID); err != nil {
		return tgt, fmt.Errorf("read the deploy's snapshot: %w", err)
	}
	return tgt, nil
}

// mintViaRunnerChannel queues one static mint as the console's request route would, lets the REAL
// runner serve it, and opens the result with a key that never left this process — the same kubeaccess
// calls `alethia cluster kubeconfig` makes.
func mintViaRunnerChannel(ctx context.Context, cp *ControlPlane, tgt runnerChannelTarget, tier, file string) (mintedTier, error) {
	var m mintedTier
	key, err := kubeaccess.GenerateClientKey()
	if err != nil {
		return m, fmt.Errorf("generate the client key: %w", err)
	}
	jobID := newUUID()
	// Before the row exists, so the runner can never read outputs from an empty slot.
	cp.AliasStateToJob(jobID, cp.resolveStateKey(tgt.deployJobID))
	mintID, err := cp.enqueueKubeconfigMint(ctx, mintEnqueue{
		JobID: jobID, Owner: tgt.owner, ProjectID: tgt.projectID, EnvironmentID: tgt.envID, ClusterID: tgt.clusterID,
		Snapshot: tgt.snapshot, Tier: tier, Shape: mintShapeStatic, TTLSeconds: int(kubeconfigMintTTL.Seconds()),
		ClientPublicKey: key.PublicKey(),
	})
	if err != nil {
		return m, err
	}
	remaining := kubeconfigMintBudget
	if dl, ok := ctx.Deadline(); ok {
		remaining = time.Until(dl)
	}
	jobStatus, werr := cp.WaitTerminal(ctx, jobID, remaining)
	if m.row, err = cp.KubeconfigMintRow(ctx, mintID); err != nil {
		return m, fmt.Errorf("read the mint row: %w", err)
	}
	if werr != nil {
		return m, fmt.Errorf("the MINT_KUBECONFIG job did not finish: %w", werr)
	}
	if m.row == nil || m.row.Status != "ready" {
		status := "missing"
		if m.row != nil {
			status = m.row.Status
		}
		return m, fmt.Errorf("the mint ended %s (job %s)", status, jobStatus)
	}
	cred, err := openMintCredential(key, m.row, tier)
	if err != nil {
		return m, err
	}
	if m.kc, err = parseStaticKubeconfig([]byte(cred.Kubeconfig)); err != nil {
		return m, &mintOpenError{"the static kubeconfig the runner sealed is unusable: " + err.Error()}
	}
	m.reported = cred.ExpiresAt
	if err := os.WriteFile(file, []byte(cred.Kubeconfig), 0o600); err != nil {
		return m, err
	}
	m.file = file
	return m, nil
}

// openMintCredential opens a ready row's ciphertext and strict-decodes the credential, refusing one
// whose tier or shape is not what was asked — the client-side checks the CLI makes. No error carries
// plaintext.
func openMintCredential(key *kubeaccess.ClientKey, row *mintRequestRow, tier string) (types.KubeconfigMintCredential, error) {
	var cred types.KubeconfigMintCredential
	plain, err := key.Open(row.Sealed, row.ID, row.ClusterID)
	if err != nil {
		return cred, &mintOpenError{"the sealed credential did not open with this mint's key and ids"}
	}
	defer clear(plain)
	dec := json.NewDecoder(bytes.NewReader(plain))
	dec.DisallowUnknownFields()
	if dec.Decode(&cred) != nil {
		return cred, &mintOpenError{"the opened credential is not the expected JSON"}
	}
	if cred.Validate() != nil {
		return cred, &mintOpenError{"the opened credential failed validation"}
	}
	if string(cred.Tier) != tier || string(cred.Shape) != mintShapeStatic {
		return cred, &mintOpenError{fmt.Sprintf("asked for %s/%s, the runner sealed %s/%s", tier, mintShapeStatic, cred.Tier, cred.Shape)}
	}
	return cred, nil
}

// ─────────────────────────── cli driver ───────────────────────────

// mintViaCLI runs `alethia cluster kubeconfig <project> --static --output <file> --no-input` (plus
// `--admin`), then reads the request row the console wrote for it, so the summary's status, reason
// and endpoint privacy come from the row rather than from CLI text.
func mintViaCLI(ctx context.Context, cp *ControlPlane, run *CLIDemoRun, tier, file string) (mintedTier, error) {
	var m mintedTier
	args := []string{"cluster", "kubeconfig", run.Project, "--static", "--ttl", kubeconfigMintTTL.String(), "--output", file, "--no-input"}
	if tier == mintTierAdmin {
		args = append(args, "--admin")
	}
	since := time.Now().Add(-30 * time.Second)
	out, runErr := runAlethia(ctx, run, nil, args...)
	m.row, _ = cp.LatestKubeconfigMint(ctx, run.OrgID, tier, mintShapeStatic, since)
	raw, readErr := os.ReadFile(file)
	if readErr == nil {
		if kc, perr := parseStaticKubeconfig(raw); perr == nil {
			m.kc = kc
		}
	}
	if runErr != nil {
		return m, fmt.Errorf("`alethia %s` failed: %v\n%s", strings.Join(args[:2], " "), runErr, t2Truncate(redactSecrets(out, m.kc.secrets()), 1500))
	}
	if readErr != nil {
		return m, &mintOpenError{"the CLI exited 0 but wrote no kubeconfig"}
	}
	kc, err := parseStaticKubeconfig(raw)
	if err != nil {
		return m, &mintOpenError{"the kubeconfig the CLI wrote is unusable: " + err.Error()}
	}
	m.kc, m.file = kc, file
	return m, nil
}

// runAlethia runs the binary under test with the cli-demo environment (plus extra), returning its
// combined output. The output is only ever logged through redactSecrets.
func runAlethia(ctx context.Context, run *CLIDemoRun, extra []string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, run.Bin, args...)
	cmd.Env = append(cliDemoEnv(run), extra...)
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	return buf.String(), err
}

// execShapeThroughCLI writes the DEFAULT (exec) read-only kubeconfig and drives kubectl through it, so
// kubectl itself runs `alethia cluster token` as its credential plugin. The token the plugin served is
// then read back through the same command, only so the canary can look for it.
func execShapeThroughCLI(ctx context.Context, cp *ControlPlane, run *CLIDemoRun, file string) (KubeconfigMintTier, []string) {
	res := KubeconfigMintTier{Tier: mintTierReadonly, Shape: mintShapeExec, TTLSeconds: int(kubeconfigMintTTL.Seconds())}
	since := time.Now().Add(-30 * time.Second)
	out, err := runAlethia(ctx, run, nil, "cluster", "kubeconfig", run.Project, "--ttl", kubeconfigMintTTL.String(), "--output", file, "--no-input")
	row, _ := cp.LatestKubeconfigMint(ctx, run.OrgID, mintTierReadonly, mintShapeExec, since)
	if row != nil {
		res.MintStatus, res.FailedReason, res.PrivateEndpoint = row.Status, row.FailureReason, row.PrivateEndpoint
	}
	if err != nil {
		res.Error = fmt.Sprintf("`alethia cluster kubeconfig` (exec) failed: %v\n%s", err, t2Truncate(out, 1500))
		finishTier(&res)
		return res, nil
	}
	res.Minted = true
	// kubectl finds the plugin by the name the kubeconfig carries (`alethia`), so put the binary under
	// test on PATH under that name — never whatever else is installed.
	binDir := filepath.Join(filepath.Dir(file), "bin")
	if err := os.MkdirAll(binDir, 0o700); err == nil {
		_ = os.Symlink(run.Bin, filepath.Join(binDir, kubeaccess.DefaultExecCommand))
	}
	env := append(cliDemoEnv(run), "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	check := KubeCheckResult{Name: "kubectl-get-nodes-via-exec-plugin", Want: string(kubeAllowed)}
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", file, "get", "nodes", "-o", "name")
	cmd.Env = env
	if kout, kerr := cmd.Output(); kerr != nil || strings.TrimSpace(string(kout)) == "" {
		check.Outcome, check.Error = string(kubeError), "kubectl could not list nodes through the exec plugin"
	} else {
		check.Outcome, check.Pass = string(kubeAllowed), true
	}
	res.Checks = append(res.Checks, check)

	var secrets []string
	if row != nil {
		if tokOut, terr := runAlethia(ctx, run, nil, "cluster", "token", row.ClusterID); terr == nil {
			var ec struct {
				Status struct {
					Token string `json:"token"`
				} `json:"status"`
			}
			if json.Unmarshal([]byte(tokOut), &ec) == nil {
				secrets = credentialSecrets(ec.Status.Token, "")
				if t, ok := jwtExpiry(ec.Status.Token); ok {
					res.ExpiresAt, res.ExpirySource = t.Format(time.RFC3339), expiryFromTokenClaim
				}
			}
		}
	}
	finishTier(&res)
	return res, secrets
}
