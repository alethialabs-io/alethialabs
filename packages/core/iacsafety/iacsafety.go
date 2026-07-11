// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package iacsafety is the fail-closed static policy gate for bring-your-own
// IaC (customers supplying their own OpenTofu root module from git).
//
// Running `tofu plan` on arbitrary HCL is remote code execution: providers are
// arbitrary binaries fetched at init time, `external` data sources execute a
// program during plan, and `local-exec`/`remote-exec` provisioners run
// commands at apply. This package therefore PARSES configuration only — it
// never evaluates expressions (no hcl.EvalContext is ever supplied), never
// runs `tofu`, and never follows remote (git/registry) module sources. It
// walks the syntax tree of the root module and every LOCAL child module it
// references, staying inside the scan root, and reports policy findings.
//
// Non-local module sources are recorded but not fetched or scanned: the
// provider allowlist still protects execution, because any provider a remote
// child module needs must either be declared in a scanned required_providers
// block or resolve to an implied hashicorp/<name> address, both of which are
// checked against the allowlist before anything is executed.
package iacsafety

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclparse"
	"github.com/zclconf/go-cty/cty"
)

// Severity values for Finding.Severity.
const (
	SeverityError   = "error"
	SeverityWarning = "warning"
)

// Rule slugs — stable identifiers for policy findings.
const (
	// RuleProviderNotAllowlisted — a required_providers source is not in the
	// allowlist (or could not be statically resolved, which fails closed).
	RuleProviderNotAllowlisted = "provider-not-allowlisted"
	// RuleProviderImplied — a resource/data source implies a provider that has
	// no required_providers entry and is not derivable from the allowlist.
	RuleProviderImplied = "provider-implied"
	// RuleProvisionerBlock — any provisioner block/attribute anywhere: code execution.
	RuleProvisionerBlock = "provisioner-block"
	// RuleExternalDataSource — data "external": code execution at plan time.
	RuleExternalDataSource = "external-data-source"
	// RuleHTTPDataSource — data "http": network access at plan time (warning).
	RuleHTTPDataSource = "http-data-source"
	// RuleBackendDeclared — terraform backend/cloud block; the platform
	// overrides the backend, so the user's declaration is ignored (warning).
	RuleBackendDeclared = "backend-declared"
	// RuleModuleEscapesRoot — a local module source resolves outside the scan root.
	RuleModuleEscapesRoot = "module-escapes-root"
	// RuleModuleNotFound — a local module source points at a missing directory (warning).
	RuleModuleNotFound = "module-not-found"
	// RuleModuleSourceUnresolvable — a module source is not a static string literal.
	RuleModuleSourceUnresolvable = "module-source-unresolvable"
	// RuleParseError — a .tf/.tf.json file failed to parse. Fail closed: what
	// we cannot read, we cannot vouch for.
	RuleParseError = "parse-error"
)

// Finding is one policy violation or observation.
type Finding struct {
	Severity string // "error" | "warning"
	Rule     string // stable slug, e.g. "provider-not-allowlisted"
	File     string // repo-relative path
	Line     int    // 1-based; 0 when unknown
	Detail   string // human-readable
}

// Report is the full result of a static scan.
type Report struct {
	Findings  []Finding
	Providers []string // normalized required_providers source addresses (e.g. "hashicorp/aws")
	Modules   []string // every module source discovered (registry, git, local)
	OK        bool     // true iff no error-severity findings
}

// impliedUse records a resource/data/provider reference whose provider is
// implied by its local name; checked once all declarations are collected.
type impliedUse struct {
	name string // provider local name, e.g. "aws"
	file string
	line int
}

// scanner carries the state of one Scan invocation.
type scanner struct {
	parser   *hclparse.Parser
	root     string // absolute, symlink-resolved scan root
	allowed  map[string]bool
	findings []Finding
	// providers/modules are accumulated as sets, sorted at the end.
	providers map[string]bool
	modules   map[string]bool
	// declared holds provider local names seen in any required_providers block
	// (union across scanned modules — a deliberate simplification: provider
	// requirements inherit into child modules, so a union over the local tree
	// only errs toward fewer provider-implied warnings, never fewer
	// provider-not-allowlisted errors).
	declared map[string]bool
	implied  []impliedUse
	visited  map[string]bool // module dirs already scanned (cycle guard)
	queue    []string        // module dirs pending scan
}

// Scan walks dir (the customer root module and any LOCAL child modules it
// references, recursively, staying inside dir — never following git/registry
// module sources) and applies the policy. allowlist overrides the default
// provider allowlist when non-nil. Expressions are never evaluated.
func Scan(dir string, allowlist []string) (*Report, error) {
	rootAbs, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("iacsafety: resolving scan root: %w", err)
	}
	// Resolve symlinks so containment checks compare real paths — a symlinked
	// module dir inside the repo pointing outside it must not pass.
	root, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return nil, fmt.Errorf("iacsafety: scan root %q: %w", dir, err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("iacsafety: scan root %q: %w", dir, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("iacsafety: scan root %q is not a directory", dir)
	}

	if allowlist == nil {
		allowlist = DefaultProviderAllowlist()
	}
	allowed := make(map[string]bool, len(allowlist))
	for _, a := range allowlist {
		allowed[normalizeProviderSource(a)] = true
	}

	s := &scanner{
		parser:    hclparse.NewParser(),
		root:      root,
		allowed:   allowed,
		providers: map[string]bool{},
		modules:   map[string]bool{},
		declared:  map[string]bool{},
		visited:   map[string]bool{},
	}

	s.enqueue(root)
	for len(s.queue) > 0 {
		next := s.queue[0]
		s.queue = s.queue[1:]
		if err := s.scanModuleDir(next); err != nil {
			return nil, err
		}
	}
	s.checkImpliedProviders()

	report := &Report{
		Findings:  s.findings,
		Providers: sortedKeys(s.providers),
		Modules:   sortedKeys(s.modules),
		OK:        true,
	}
	for _, f := range report.Findings {
		if f.Severity == SeverityError {
			report.OK = false
			break
		}
	}
	return report, nil
}

// enqueue adds a module directory to the scan queue exactly once.
func (s *scanner) enqueue(dir string) {
	if s.visited[dir] {
		return
	}
	s.visited[dir] = true
	s.queue = append(s.queue, dir)
}

// addFinding appends a policy finding.
func (s *scanner) addFinding(severity, rule, file string, line int, detail string) {
	s.findings = append(s.findings, Finding{
		Severity: severity,
		Rule:     rule,
		File:     file,
		Line:     line,
		Detail:   detail,
	})
}

// relPath converts an absolute path under the scan root to a repo-relative
// path with forward slashes.
func (s *scanner) relPath(abs string) string {
	rel, err := filepath.Rel(s.root, abs)
	if err != nil {
		return abs
	}
	return filepath.ToSlash(rel)
}

// scanModuleDir scans every .tf / .tf.json file directly inside one module
// directory (Terraform module semantics: a module is a single directory,
// never a recursive file walk).
func (s *scanner) scanModuleDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("iacsafety: reading module dir %q: %w", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names) // deterministic finding order
	for _, name := range names {
		path := filepath.Join(dir, name)
		switch {
		case strings.HasSuffix(name, ".tf.json"):
			s.scanJSONFile(path, dir)
		case strings.HasSuffix(name, ".tf"):
			s.scanNativeFile(path, dir)
		}
	}
	return nil
}

// recordModuleSource records a module source and, when it is a local path,
// resolves it inside the scan root and enqueues it for scanning. Local paths
// are exactly those Terraform treats as local: "./" or "../" prefixed.
func (s *scanner) recordModuleSource(source, file string, line int, moduleDir string) {
	s.modules[source] = true
	if !strings.HasPrefix(source, "./") && !strings.HasPrefix(source, "../") {
		// Remote (registry/git/http/s3/...) source: recorded only, never
		// fetched. See the package comment for why this stays safe.
		return
	}
	target := filepath.Clean(filepath.Join(moduleDir, filepath.FromSlash(source)))
	// Lexical containment check first (works even if the path doesn't exist).
	if rel, err := filepath.Rel(s.root, target); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		s.addFinding(SeverityError, RuleModuleEscapesRoot, file, line,
			fmt.Sprintf("module source %q resolves outside the scan root", source))
		return
	}
	// Then resolve symlinks and re-check: a symlink inside the tree must not
	// smuggle the walk outside the root.
	real, err := filepath.EvalSymlinks(target)
	if err != nil {
		s.addFinding(SeverityWarning, RuleModuleNotFound, file, line,
			fmt.Sprintf("local module source %q does not resolve to a directory", source))
		return
	}
	if rel, err := filepath.Rel(s.root, real); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		s.addFinding(SeverityError, RuleModuleEscapesRoot, file, line,
			fmt.Sprintf("module source %q resolves outside the scan root (via symlink)", source))
		return
	}
	info, err := os.Stat(real)
	if err != nil || !info.IsDir() {
		s.addFinding(SeverityWarning, RuleModuleNotFound, file, line,
			fmt.Sprintf("local module source %q is not a directory", source))
		return
	}
	s.enqueue(real)
}

// checkProviderEntry validates one required_providers entry against the
// allowlist. localName is the entry key; the value may be an object with a
// "source" attribute or a bare version-constraint string (legacy syntax, in
// which case the source is the implied hashicorp/<localName>). The expression
// is evaluated with a nil context, which succeeds only for pure literals —
// anything referencing variables/functions fails closed.
func (s *scanner) checkProviderEntry(localName string, expr hcl.Expression, file string, line int) {
	s.declared[strings.ToLower(localName)] = true

	source := ""
	v, diags := expr.Value(nil)
	switch {
	case diags.HasErrors() || !v.IsKnown() || v.IsNull():
		s.addFinding(SeverityError, RuleProviderNotAllowlisted, file, line,
			fmt.Sprintf("required_providers entry %q: source is not a static literal and cannot be verified", localName))
		return
	case v.Type().IsObjectType() || v.Type().IsMapType():
		if v.Type().IsObjectType() && v.Type().HasAttribute("source") {
			sv := v.GetAttr("source")
			if sv.IsNull() || !sv.Type().Equals(cty.String) {
				s.addFinding(SeverityError, RuleProviderNotAllowlisted, file, line,
					fmt.Sprintf("required_providers entry %q: source is not a string literal", localName))
				return
			}
			source = sv.AsString()
		}
		// No source attribute → implied hashicorp/<localName> (handled below).
	case v.Type().Equals(cty.String):
		// Legacy `aws = "~> 2.7"` version-constraint form: implied source.
	default:
		s.addFinding(SeverityError, RuleProviderNotAllowlisted, file, line,
			fmt.Sprintf("required_providers entry %q has an unsupported value shape", localName))
		return
	}

	if source == "" {
		source = localName
	}
	norm := normalizeProviderSource(source)
	s.providers[norm] = true
	if !s.allowed[norm] {
		s.addFinding(SeverityError, RuleProviderNotAllowlisted, file, line,
			fmt.Sprintf("provider %q (entry %q) is not in the allowlist", norm, localName))
	}
}

// recordImpliedUse queues a provider-implied-by-name reference (resource /
// data source / provider block) for the post-scan implied-provider check.
// The builtin "terraform" provider (terraform_data, terraform_remote_state)
// is exempt — it ships with OpenTofu itself.
func (s *scanner) recordImpliedUse(typeName, file string, line int) {
	name := typeName
	if i := strings.Index(typeName, "_"); i > 0 {
		name = typeName[:i]
	}
	name = strings.ToLower(name)
	if name == "terraform" || name == "" {
		return
	}
	s.implied = append(s.implied, impliedUse{name: name, file: file, line: line})
}

// checkImpliedProviders runs after all modules are scanned: any implied
// provider with no required_providers entry anywhere in the tree AND whose
// implied address hashicorp/<name> is not in the allowlist gets a warning.
// (Implied providers default to hashicorp/<name>, so when that address is
// allowlisted the rule-1 check already covers execution safety.)
func (s *scanner) checkImpliedProviders() {
	warned := map[string]bool{}
	for _, u := range s.implied {
		if s.declared[u.name] || s.allowed["hashicorp/"+u.name] {
			continue
		}
		key := u.name + "\x00" + u.file
		if warned[key] {
			continue // one warning per provider per file is enough signal
		}
		warned[key] = true
		s.addFinding(SeverityWarning, RuleProviderImplied, u.file, u.line,
			fmt.Sprintf("provider %q is implied by a resource/data type but has no required_providers entry and hashicorp/%s is not allowlisted", u.name, u.name))
	}
}

// sortedKeys returns the keys of a string set, sorted.
func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
