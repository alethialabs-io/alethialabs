// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/iacsafety"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// byoBackendOverrideFile is written into the customer's cloned module so their own
// backend/cloud block (if any) is overridden by the platform HTTP state proxy.
// OpenTofu merges `*_override.tf` files LAST, and a backend block in an override
// replaces the original — so this empty `http` backend wins over whatever the
// customer declared, and the -backend-config params from WriteBackendHCL bind to
// it. The leading "zzz_" keeps it lexically last and out of the customer's way; the
// "alethia" marker makes its provenance obvious. It is written AFTER the static
// scan so the gate always inspects the pristine module.
const byoBackendOverrideFile = "zzz_alethia_backend_override.tf"

// byoBackendOverrideFileTofu is the `.tofu`-extension twin of byoBackendOverrideFile.
// OpenTofu 1.8+ makes a same-basename `.tofu` file take PRECEDENCE over its `.tf`
// sibling, so a customer who commits `zzz_alethia_backend_override.tofu` would
// otherwise shadow the platform `.tf` override — leaving no backend block, which
// silently falls back to the LOCAL backend and puts state on the runner disk. We
// therefore write the identical override under BOTH extensions (os.WriteFile
// overwrites any customer file at these exact paths); the iacsafety gate also
// rejects any customer-committed `*_override.*` file as defense in depth.
const byoBackendOverrideFileTofu = "zzz_alethia_backend_override.tofu"

// byoBackendOverrideHCL is the override content: an empty http backend block that
// the platform's -backend-config file (WriteBackendHCL) fills in at init time.
const byoBackendOverrideHCL = `# Managed by Alethia — overrides any customer backend/cloud block with the
# platform's per-job HTTP state proxy. Do not edit.
terraform {
  backend "http" {}
}
`

// prepareByoIacWorkdir clones the customer's pinned bring-your-own IaC module, runs
// the fail-closed static safety gate INLINE, writes the platform backend override,
// publishes the frozen TF_VAR_alethia_* context, and returns the resolved module
// directory plus the coerced customer tfvars.
//
// The returned restore func MUST be deferred by the caller — it unsets/restores the
// TF_VAR_alethia_* environment. It is shared by RunDeployV2 / RunDestroy /
// RunDriftDetection so all three enforce the identical gate before touching `tofu`.
//
// Security model:
//   - clone-at-pinned-SHA: CommitSHA is checked out (never the moving Ref), so we
//     provision the exact bytes the gate vetted (TOCTOU-safe).
//   - traversal-guarded path: Path is resolved with filepath.Clean("/"+Path) then
//     re-checked to stay inside the clone (a symlink/`..` cannot escape).
//   - inline iacsafety gate, fail-closed: any scan error or error-severity finding
//     blocks BEFORE any plan/apply. This is defense in depth — the runner's IAC_SCAN
//     row is never trusted alone (an older/newer runner, or a different commit).
func prepareByoIacWorkdir(vc *types.ProjectConfig, gitToken, cloneDir string, stdout, stderr io.Writer) (tfDir string, tfvars map[string]interface{}, restore func(), err error) {
	src := vc.IacSource
	if src == nil {
		return "", nil, nil, fmt.Errorf("prepareByoIacWorkdir called without an IacSource")
	}
	if strings.TrimSpace(src.RepoURL) == "" {
		return "", nil, nil, fmt.Errorf("BYO IaC source is missing repo_url")
	}
	// Untrusted RepoURL: only remote git transports (https / ssh / scp-like) are
	// allowed. A file:// (or other local) transport would make the runner clone an
	// on-box repository — the git.go transforms accept file:// for local-fixture
	// tests, so reject it here at the untrusted entry point.
	if err := validateByoRepoURL(src.RepoURL); err != nil {
		return "", nil, nil, err
	}
	if strings.TrimSpace(src.CommitSHA) == "" {
		return "", nil, nil, fmt.Errorf("BYO IaC source is missing commit_sha (a pinned commit is required — a ref alone is TOCTOU-unsafe)")
	}

	fmt.Fprintf(stdout, "BYO IaC: cloning %s (ref %q) at pinned commit %s\n", src.RepoURL, src.Ref, src.CommitSHA)

	// Parent clone (trusted: holds the git token + egress). Uses token auth when a
	// token is present, else an SSH/public clone.
	var repo *git.GIT
	if strings.TrimSpace(gitToken) != "" {
		repo = git.NewGITWithToken(src.RepoURL, cloneDir, false, gitToken)
	} else {
		repo = git.NewGIT(src.RepoURL, cloneDir, false)
	}
	if cloneErr := repo.CloneAndCheckoutCommit(src.Ref, src.CommitSHA, true); cloneErr != nil {
		return "", nil, nil, fmt.Errorf("BYO IaC clone/checkout failed: %w", cloneErr)
	}

	// Resolve the module dir INSIDE the clone. filepath.Clean on a rooted path strips
	// `..` traversal; we then re-verify containment against the clone root (defense
	// against symlinks pointing outside the clone).
	moduleDir, resolveErr := resolveByoModuleDir(cloneDir, src.Path)
	if resolveErr != nil {
		return "", nil, nil, resolveErr
	}

	// Inline static gate, FAIL-CLOSED. Runs over the pristine module (before the
	// backend override is written).
	if scanErr := scanByoIacFailClosed(moduleDir, stdout, stderr); scanErr != nil {
		return "", nil, nil, scanErr
	}

	// Override the customer's backend with the platform HTTP state proxy.
	if wErr := writeByoBackendOverride(moduleDir); wErr != nil {
		return "", nil, nil, wErr
	}

	// Publish the frozen Alethia context contract as TF_VAR_* env vars.
	restore = setByoAlethiaTFVars(vc)

	// Coerce the customer's var_values to scalar tfvars.
	tfvars = coerceByoVarValues(src.VarValues, stdout, stderr)

	return moduleDir, tfvars, restore, nil
}

// allowInsecureRepoURLForTest, when true, lets validateByoRepoURL accept a file://
// RepoURL. It exists ONLY so the byo_iac tests can clone local fixture repos;
// production leaves it false, so an untrusted BYO RepoURL can never point the runner
// at an on-box path.
var allowInsecureRepoURLForTest bool

// validateByoRepoURL rejects any RepoURL whose transport is not a remote git
// transport — https, ssh (ssh:// or scp-like git@host:path). Everything else,
// notably file:// and http://, is refused on the untrusted BYO path (a file://
// clone would read an on-box repo). The allowInsecureRepoURLForTest escape re-admits
// file:// for the local-fixture tests only.
func validateByoRepoURL(repoURL string) error {
	u := strings.TrimSpace(repoURL)
	// scp-like SSH shorthand: git@host:owner/repo(.git).
	if strings.HasPrefix(u, "git@") {
		return nil
	}
	lower := strings.ToLower(u)
	if strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "ssh://") {
		return nil
	}
	if allowInsecureRepoURLForTest && strings.HasPrefix(lower, "file://") {
		return nil
	}
	return fmt.Errorf("BYO IaC repo_url %q must use an https or ssh git transport (insecure/local schemes such as file:// are rejected on the untrusted path)", repoURL)
}

// resolveByoModuleDir resolves the customer's module path inside the clone and
// verifies it stays within the clone (no `..` / symlink escape), returning the
// absolute module directory.
func resolveByoModuleDir(cloneDir, path string) (string, error) {
	cloneAbs, err := filepath.Abs(cloneDir)
	if err != nil {
		return "", fmt.Errorf("resolving clone dir: %w", err)
	}
	// filepath.Clean("/"+path) collapses any leading `..` against a virtual root, so a
	// "../../etc" path becomes "/etc" then joins under the clone as clone/etc — it can
	// never climb above the clone lexically.
	rel := filepath.Clean("/" + strings.TrimSpace(path))
	moduleDir := filepath.Join(cloneAbs, rel)

	// Belt-and-suspenders: re-check lexical containment after the Join.
	relToClone, err := filepath.Rel(cloneAbs, moduleDir)
	if err != nil || relToClone == ".." || strings.HasPrefix(relToClone, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("BYO IaC path %q resolves outside the repository clone", path)
	}
	info, err := os.Stat(moduleDir)
	if err != nil {
		return "", fmt.Errorf("BYO IaC module path %q not found in repository: %w", path, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("BYO IaC module path %q is not a directory", path)
	}

	// Symlink-resolved containment. The lexical check above is purely textual, but
	// os.Stat FOLLOWS symlinks — so a repo-committed symlink (`evil -> /outside`,
	// Path="evil") passes the lexical check yet points OUTSIDE the clone, which would
	// land tfDir + the backend-override write outside the containment boundary.
	// Resolve both real paths and re-verify containment (mirrors what iacsafety does
	// for module sources); return the RESOLVED module dir so all downstream writes
	// stay inside the resolved clone.
	realClone, err := filepath.EvalSymlinks(cloneAbs)
	if err != nil {
		return "", fmt.Errorf("resolving clone dir symlinks: %w", err)
	}
	realModule, err := filepath.EvalSymlinks(moduleDir)
	if err != nil {
		return "", fmt.Errorf("resolving BYO IaC module path %q: %w", path, err)
	}
	relReal, err := filepath.Rel(realClone, realModule)
	if err != nil || relReal == ".." || strings.HasPrefix(relReal, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("BYO IaC path %q resolves outside the repository clone (via symlink)", path)
	}
	return realModule, nil
}

// scanByoIacFailClosed re-runs the iacsafety static gate over the cloned module
// INLINE and fails closed. Any scan error, or any error-severity finding, blocks —
// the provisioner never proceeds to `tofu` on an unvetted module.
func scanByoIacFailClosed(moduleDir string, stdout, stderr io.Writer) error {
	rep, err := iacsafety.Scan(moduleDir, iacsafety.AllowlistFromEnv())
	if err != nil {
		return fmt.Errorf("BYO IaC static gate failed to run (fail-closed): %w", err)
	}
	if !rep.OK {
		var b strings.Builder
		for _, f := range rep.Findings {
			if f.Severity == iacsafety.SeverityError {
				fmt.Fprintf(&b, "\n  - [%s] %s:%d %s", f.Rule, f.File, f.Line, f.Detail)
			}
		}
		return fmt.Errorf("BYO IaC static gate BLOCKED (fail-closed) — error-severity findings:%s", b.String())
	}
	// Surface warnings without blocking.
	for _, f := range rep.Findings {
		if f.Severity != iacsafety.SeverityError {
			fmt.Fprintf(stderr, "BYO IaC gate warning [%s] %s:%d %s\n", f.Rule, f.File, f.Line, f.Detail)
		}
	}
	fmt.Fprintf(stdout, "BYO IaC static gate: OK (providers=%v, %d local module(s), %d finding(s))\n",
		rep.Providers, len(rep.Modules), len(rep.Findings))
	return nil
}

// writeByoBackendOverride writes the platform backend override into the module dir
// under BOTH the `.tf` and `.tofu` extensions. Writing both closes the OpenTofu 1.8+
// precedence gap: a `.tofu` override outranks a `.tf` one, so a customer-committed
// `zzz_alethia_backend_override.tofu` would otherwise shadow a `.tf`-only platform
// override and drop the http backend (state escapes to the local backend on disk).
// os.WriteFile overwrites any customer file already at these exact paths.
func writeByoBackendOverride(moduleDir string) error {
	for _, name := range []string{byoBackendOverrideFile, byoBackendOverrideFileTofu} {
		path := filepath.Join(moduleDir, name)
		if err := os.WriteFile(path, []byte(byoBackendOverrideHCL), 0o600); err != nil {
			return fmt.Errorf("failed to write backend override %s: %w", name, err)
		}
	}
	return nil
}

// setByoAlethiaTFVars publishes the FROZEN Alethia context contract to the child
// tofu as TF_VAR_* environment variables and returns a restore func (mirrors
// HTTPBackendConfig.SetAuthEnv). Undeclared TF_VARs are silently ignored by
// OpenTofu, so a module declaring none of these is unaffected; a module that
// declares e.g. `variable "alethia_project" {}` receives the value.
//
// This set is a PUBLIC CONTRACT — customers author modules against these exact
// names — so it is FROZEN: only ADD keys in future, never rename or remove one.
//
//	TF_VAR_alethia_project        — project name        (vc.ProjectName)
//	TF_VAR_alethia_environment    — environment stage   (vc.EnvironmentStage)
//	TF_VAR_alethia_region         — primary region      (vc.Region)
//	TF_VAR_alethia_project_id     — Alethia config id    (vc.ID)
//	TF_VAR_alethia_environment_id — Alethia environment id (vc.ID today; the config
//	                                snapshot carries a single id — the KEY is the
//	                                frozen contract, its source refines when the
//	                                snapshot splits project/environment ids)
func setByoAlethiaTFVars(vc *types.ProjectConfig) func() {
	vars := map[string]string{
		"TF_VAR_alethia_project":        vc.ProjectName,
		"TF_VAR_alethia_environment":    vc.EnvironmentStage,
		"TF_VAR_alethia_region":         vc.Region,
		"TF_VAR_alethia_project_id":     vc.ID,
		"TF_VAR_alethia_environment_id": vc.ID,
	}
	type prev struct {
		val string
		had bool
	}
	saved := make(map[string]prev, len(vars))
	for k, v := range vars {
		old, had := os.LookupEnv(k)
		saved[k] = prev{val: old, had: had}
		_ = os.Setenv(k, v)
	}
	return func() {
		for k, p := range saved {
			if p.had {
				_ = os.Setenv(k, p.val)
			} else {
				_ = os.Unsetenv(k)
			}
		}
	}
}

// byoReservedVarPrefix is the reserved platform variable namespace. The frozen
// Alethia context is published as TF_VAR_alethia_* env vars (setByoAlethiaTFVars);
// a customer var_values entry named alethia_* would be written to the -var-file,
// which is HIGHER precedence than TF_VAR_* env vars — so it would SHADOW the frozen
// platform context (e.g. spoof alethia_project_id). Such keys are dropped.
const byoReservedVarPrefix = "alethia_"

// coerceByoVarValues converts the customer's arbitrary var_values into a scalar
// tfvars map. Only string / number / bool pass; nested objects, arrays, and other
// shapes are REJECTED (skipped with a warning) so nothing structured or injectable
// reaches the tfvars file. nil values are skipped so the module's own default
// applies. Any key in the reserved alethia_ namespace is dropped (a var-file entry
// there would override the frozen TF_VAR_alethia_* platform context — see
// byoReservedVarPrefix).
func coerceByoVarValues(in map[string]any, stdout, stderr io.Writer) map[string]interface{} {
	out := make(map[string]interface{}, len(in))
	for k, v := range in {
		if strings.HasPrefix(k, byoReservedVarPrefix) {
			fmt.Fprintf(stderr, "Warning: BYO var %q uses the reserved %q platform namespace; dropping (it cannot override the frozen Alethia context)\n", k, byoReservedVarPrefix)
			continue
		}
		switch v.(type) {
		case string, bool, float64, float32, int, int32, int64, json.Number:
			out[k] = v
		case nil:
			// skip — let the module default apply
		default:
			fmt.Fprintf(stderr, "Warning: BYO var %q has unsupported type %T; skipping (only string/number/bool are allowed)\n", k, v)
		}
	}
	if len(out) > 0 {
		fmt.Fprintf(stdout, "BYO IaC: applying %d customer variable(s)\n", len(out))
	}
	return out
}
