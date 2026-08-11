// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The CLI-ONLY DEMO surface — one legible table that IS the answer to "can the whole product be
// driven from the terminal, and where can it not?"
//
// Every other T2 surface asks whether the PLATFORM works. This one asks whether the PRODUCT is
// reachable: a prospect watching a demo must get from an empty account to a running, verified,
// torn-down cluster using `alethia` alone. A step that needs a console click is a failure of that
// claim even when the platform underneath it is perfect — and, until this file existed, nothing in
// the repo asserted it. The console-only gaps were discoverable only by trying, one at a time, in
// front of an audience.
//
// Deliberately UNTAGGED (like t2_day2_offer.go / t2_day2_access.go) so the table's well-formedness
// is unit-tested WITHOUT a cloud (t2_cli_demo_pure_test.go, which ci.yml runs) and `go mod tidy`
// sees its deps. The real-cloud half is t2_cli_demo_run_test.go behind `e2e_t2`.
//
// WHY THE STEP IS A TYPED VERDICT AND NOT A BOOLEAN. "CLI-driven: yes/no" collapses three facts
// that call for three different actions, and collapsing them is how a gap stops being counted:
//
//   - the CLI cannot reach something the product genuinely does      → OUR debt, file an issue
//   - the CLOUD offers no API for it at all                          → a ceiling, file it anyway
//   - it is console-only ON PURPOSE (an approval a human must see)   → not a gap; must say why
//
// The maintainer's ruling for the investor benchmark is that the first two BOTH score FAIL — a
// prospect does not care whose fault the click is. But they are still recorded apart, because the
// remedies differ and a merged list is exactly how `MaxConfigStateProof` once let two chart-backed
// kinds hide inside a "the cloud cannot do this" sentence (see maxconfig.go's DeferredInProduct).
//
// Opt-in via ALETHIA_E2E_CLI_DEMO=1.

import (
	"fmt"
	"os"
	"sort"
	"strings"
)

// CLIReach is WHY one demo step is or is not reachable from `alethia` — the verdict for a step.
// A closed set of exactly four; the zero value is deliberately NOT one of them, so a step nobody
// filled in fails loudly instead of reading as "pending".
type CLIReach string

const (
	// CLIDriven — the step completes through `alethia`, with no console and no cloud portal. The
	// claim is checked, not asserted: the run half executes `alethia <Argv...> --help` and a
	// non-zero exit means the table is lying about a command that does not exist.
	CLIDriven CLIReach = "cli"
	// CLIGap — the product genuinely does this, and the CLI cannot reach it. OUR debt. Requires an
	// Issue (so it is tracked) and a WantArgv naming the command that SHOULD exist — which the run
	// half asserts still does NOT resolve. That inversion is the ratchet: the day somebody ships
	// the command, this test goes red and forces the table to record the win. A gap that silently
	// stays listed after it is fixed is worse than no list, because it understates the product.
	CLIGap CLIReach = "cli_gap"
	// CloudManual — no API exists on the cloud side; a human must open that cloud's console. Not
	// our defect, and still a FAIL for the demo bar: the prospect watching cannot tell the
	// difference, and neither can their procurement team. Requires an Issue and a Why.
	//
	// Read "no API exists" literally. If the cloud has an API and we simply have not called it,
	// that is CLIGap. Hetzner Object Storage keys are the real CloudManual case: Hetzner ships no
	// endpoint that mints them, so a human creates them in the console or the bucket kind cannot
	// be provisioned at all.
	CloudManual CLIReach = "cloud_manual"
	// ConsoleOnly — deliberately not in the CLI, and that is the design. A human-in-the-loop
	// approval whose whole value is that a person SAW it does not belong behind a scriptable verb.
	// Requires a Why, and the Why must survive being read aloud to a skeptic: this verdict is the
	// one an author reaches for to make a red table green, so it carries the burden of proof.
	ConsoleOnly CLIReach = "console_only"
)

// DemoStep is ONE step of the end-to-end demo and its reachability verdict. Build the table below
// in the order a demo actually runs — the sequence is part of the claim, and a reader should be
// able to follow it top to bottom as a script.
type DemoStep struct {
	// ID is the stable handle used in the ledger row and for issue dedup. Never renamed once
	// filed: the issue title derives from it.
	ID string
	// Title is the phrase a human would use for this step.
	Title string
	// Argv is the `alethia` command path proving the step, WITHOUT the binary name —
	// e.g. {"project", "apply"}. CLIDriven only, and required there.
	Argv []string
	// WantArgv is the command that SHOULD exist but does not. CLIGap only, and required there.
	// The run half asserts it still fails to resolve.
	WantArgv []string
	// Reach is the verdict. Empty = the step was never filled in ⇒ a hard error, not a skip.
	Reach CLIReach
	// Why documents a non-CLIDriven verdict. Required for CLIGap, CloudManual and ConsoleOnly:
	// an exclusion nobody can read is indistinguishable from an oversight.
	Why string
	// Issue is the tracking issue. Required for CLIGap and CloudManual — the maintainer's ruling
	// is that every one of these is filed, so a verdict without a number is an unkept promise.
	Issue string
	// Clouds narrows the step to specific clouds. Empty means every cloud. Used by the per-cloud
	// prerequisites that only one provider imposes.
	Clouds []string
}

// AppliesTo reports whether this step is in scope for the given cloud.
func (s DemoStep) AppliesTo(cloud string) bool {
	if len(s.Clouds) == 0 {
		return true
	}
	for _, c := range s.Clouds {
		if c == cloud {
			return true
		}
	}
	return false
}

// Validate is the read-back that makes the verdict load-bearing. Every rule here exists because
// the opposite shape would let a step claim a verdict it has not earned.
func (s DemoStep) Validate() error {
	if s.ID == "" {
		return fmt.Errorf("step has no ID — the ledger row and the issue title both derive from it")
	}
	if s.Title == "" {
		return fmt.Errorf("step %q has no Title", s.ID)
	}
	switch s.Reach {
	case CLIDriven:
		if len(s.Argv) == 0 {
			return fmt.Errorf("step %q: verdict %q must name the Argv that proves it — an unproven claim of CLI coverage is the whole defect this table exists to prevent", s.ID, s.Reach)
		}
		if len(s.WantArgv) > 0 {
			return fmt.Errorf("step %q: verdict %q must not carry WantArgv — the command exists, so there is nothing to want", s.ID, s.Reach)
		}
		if s.Issue != "" {
			return fmt.Errorf("step %q: verdict %q must not name an Issue (%s) — a working step has nothing to track", s.ID, s.Reach, s.Issue)
		}
	case CLIGap:
		if len(s.WantArgv) == 0 {
			return fmt.Errorf("step %q: verdict %q must name the WantArgv it lacks — without it nothing can detect the day the gap closes, and a stale gap understates the product", s.ID, s.Reach)
		}
		if len(s.Argv) > 0 {
			return fmt.Errorf("step %q: verdict %q must not carry Argv — the claim IS that no command reaches it", s.ID, s.Reach)
		}
		if s.Issue == "" {
			return fmt.Errorf("step %q: verdict %q needs an Issue — an untracked gap is a silent gap", s.ID, s.Reach)
		}
		if s.Why == "" {
			return fmt.Errorf("step %q: verdict %q needs a Why", s.ID, s.Reach)
		}
	case CloudManual:
		if len(s.Argv) > 0 || len(s.WantArgv) > 0 {
			return fmt.Errorf("step %q: verdict %q must be empty of Argv/WantArgv — no command on either side can reach an API that does not exist", s.ID, s.Reach)
		}
		if s.Issue == "" {
			return fmt.Errorf("step %q: verdict %q needs an Issue — the ruling is that a cloud ceiling is filed too, precisely because it is nobody's sprint work by default", s.ID, s.Reach)
		}
		if s.Why == "" {
			return fmt.Errorf("step %q: verdict %q needs a Why naming the missing API", s.ID, s.Reach)
		}
	case ConsoleOnly:
		if len(s.Argv) > 0 || len(s.WantArgv) > 0 {
			return fmt.Errorf("step %q: verdict %q must be empty of Argv/WantArgv", s.ID, s.Reach)
		}
		if s.Why == "" {
			return fmt.Errorf("step %q: verdict %q needs a Why — this is the verdict that turns a red table green, so it carries the burden of proof", s.ID, s.Reach)
		}
	case "":
		return fmt.Errorf("step %q states no verdict — every step must be one of %q, %q, %q or %q. "+
			"The zero value is invalid ON PURPOSE: an unfilled step used to read as 'pending' and was counted as neither pass nor fail",
			s.ID, CLIDriven, CLIGap, CloudManual, ConsoleOnly)
	default:
		return fmt.Errorf("step %q has unknown verdict %q", s.ID, s.Reach)
	}
	return nil
}

// DemoClouds are the clouds the demo bar is scored against.
var DemoClouds = []string{"aws", "gcp", "azure", "alibaba", "hetzner"}

// CLIDemoSteps is the demo, in the order it is performed. Read it top to bottom and you have the
// script; read the verdict column and you have the honest answer to "can this be done from the
// terminal?".
//
// The order matters beyond readability: a step that depends on an earlier one cannot be scored
// independently, so the run half executes them in sequence and stops at the first hard failure.
var CLIDemoSteps = []DemoStep{
	{
		ID:    "login",
		Title: "Authenticate a fresh machine",
		Argv:  []string{"login"},
		Reach: CLIDriven,
	},
	{
		ID:    "whoami",
		Title: "Confirm the identity and active org",
		Argv:  []string{"whoami"},
		Reach: CLIDriven,
	},
	{
		ID:    "org-switch",
		Title: "Select the org the demo runs in",
		Argv:  []string{"org", "switch"},
		Reach: CLIDriven,
	},
	{
		ID:    "connector",
		Title: "Attach a cloud account, keyless",
		Argv:  []string{"connector"},
		Reach: CLIDriven,
		Why:   "one subcommand per cloud (connector aws|gcp|azure|alibaba|hetzner); hetzner arrived last, in #2316",
	},
	{
		ID:    "project-create",
		Title: "Create the project",
		Argv:  []string{"project", "create"},
		Reach: CLIDriven,
	},
	{
		ID:    "project-env",
		Title: "Add an environment and place it",
		Argv:  []string{"project", "env", "add"},
		Reach: CLIDriven,
		Why:   "placement landed in #2313 — a two-tier project stops costing two clusters",
	},
	{
		ID:    "component-kinds",
		Title: "Discover what this cloud offers",
		Argv:  []string{"project", "component", "kinds"},
		Reach: CLIDriven,
	},
	{
		ID:    "component-add",
		Title: "Author the components",
		Argv:  []string{"project", "component", "add"},
		Reach: CLIDriven,
	},
	{
		ID:    "staged",
		Title: "Review what is about to change",
		Argv:  []string{"staged", "list"},
		Reach: CLIDriven,
	},
	{
		ID:    "plan",
		Title: "Plan — and watch the verify gate run between plan and apply",
		Argv:  []string{"project", "plan"},
		Reach: CLIDriven,
	},
	{
		ID:    "apply",
		Title: "Apply",
		Argv:  []string{"project", "apply"},
		Reach: CLIDriven,
	},
	{
		ID:    "jobs-logs",
		Title: "Follow the provision live",
		Argv:  []string{"jobs", "logs"},
		Reach: CLIDriven,
	},
	{
		ID:    "cluster-get",
		Title: "Read the finished cluster back",
		Argv:  []string{"cluster", "get"},
		Reach: CLIDriven,
	},
	{
		ID:    "receipt-verify",
		Title: "Show the signed evidence receipt and check its signature",
		Argv:  []string{"verify", "receipt"},
		Reach: CLIDriven,
		Why: "Closed by #2331. `alethia verify receipt --job <id>` pulls the receipt, checks its ed25519 " +
			"signature against a key the control plane VOUCHES for — the org's own recorded key or the " +
			"platform key, not merely the public key the receipt carries about itself — and exits non-zero " +
			"when it cannot, so a customer can gate their own pipeline on it. `alethia verify show` prints " +
			"the per-control report behind the verdict, not_evaluable controls and recorded waivers included",
	},
	{
		ID:    "drift",
		Title: "Show the drift posture",
		Argv:  []string{"drift", "show"},
		Reach: CLIDriven,
	},
	{
		ID:    "iac",
		Title: "Show the generated IaC",
		Argv:  []string{"iac", "show"},
		Reach: CLIDriven,
	},
	{
		ID:    "cost",
		Title: "Show what it costs",
		Argv:  []string{"cost", "show"},
		Reach: CLIDriven,
	},
	{
		ID:    "addons",
		Title: "List the marketplace add-ons that converged",
		Argv:  []string{"addon", "list"},
		Reach: CLIDriven,
	},
	{
		ID:    "promotion-approve",
		Title: "Approve a promotion between environments",
		Reach: ConsoleOnly,
		Why: "`alethia promotion` is list/get only, and the approve verb is deliberately not there: a promotion gate " +
			"whose whole value is that a named human saw and accepted a change must not be scriptable, or it stops " +
			"being a control. `alethia ops approve` exists for break-glass and is audited as such. This is the one " +
			"verdict in the table that is a design decision rather than a gap — if that ever stops being true, it " +
			"becomes a CLIGap, not a quietly-edited Why",
	},
	{
		ID:    "destroy",
		Title: "Tear the whole thing down",
		Argv:  []string{"project", "destroy"},
		Reach: CLIDriven,
	},

	// ── Per-cloud prerequisites. These are not part of the happy path; they are the steps a
	//    prospect would hit BEFORE the flow above can succeed on that cloud, and each one is a
	//    console visit that no API can replace. ──
	{
		ID:     "hetzner-s3-keys",
		Title:  "Mint Hetzner Object Storage credentials",
		Reach:  CloudManual,
		Clouds: []string{"hetzner"},
		Issue:  "#2332",
		Why: "the bucket kind on hetzner is real Object Storage behind the aminueza/minio provider, which " +
			"authenticates from HETZNER_S3_ACCESS_KEY / HETZNER_S3_SECRET_KEY. Hetzner ships NO API that mints " +
			"them — a human creates them in the cloud console. This is the purest CloudManual case in the product: " +
			"there is no call we are failing to make",
	},
	{
		ID:    "dns-delegation",
		Title: "Delegate a public DNS zone so certificates can validate",
		Reach: CloudManual,
		Issue: "#1773",
		Why: "DNS-validated certificates need the validation record to be resolvable on the PUBLIC internet, and " +
			"creating a hosted zone is not the same as being delegated one. Delegation is a registrar action, " +
			"outside every cloud's API. Consequence: the full bar proves the dns kind but NOT the cert path, on " +
			"any cloud — infra/templates/project/aws/modules/acm is switched off for exactly this reason",
	},
	{
		ID:     "gcp-budget-publisher",
		Title:  "Grant the GCP billing-budgets agent its Pub/Sub publisher binding",
		Reach:  CloudManual,
		Clouds: []string{"gcp"},
		Issue:  "#1871",
		Why: "billing-budgets@system.gserviceaccount.com needs a publisher binding that must be granted out of band " +
			"in the Cloud Console before the binding can be imported. Until then the budget's alerts are " +
			"undeliverable — the stack's own cost guard is the one resource that does not come up",
	},
	{
		ID:     "alibaba-cr-sweep",
		Title:  "Release the prepaid Container Registry EE instance",
		Reach:  CloudManual,
		Clouds: []string{"alibaba"},
		Issue:  "#2333",
		Why: "the registry kind forces alicloud_cr_ee_instance, which infra/templates/project/alibaba/modules/cr " +
			"creates with payment_type = Subscription. A prepaid instance is not released by tofu destroy the way " +
			"a pay-as-you-go one is, so every full bar leaves a non-cancellable monthly instance behind AND the " +
			"teardown still reports clean. Releasing it is a console action",
	},
}

// CLIDemoProof is the outcome of scoring the table for one cloud. The three non-driven lists are
// kept APART on purpose — see the file header. A caller that wants the headline number adds them
// up itself, and in doing so states that it meant to.
type CLIDemoProof struct {
	Cloud string
	// Driven are the step IDs that completed through `alethia`.
	Driven []string
	// Gaps are steps the CLI cannot reach but the product performs — our debt.
	Gaps []DemoStep
	// Manual are steps no cloud API can reach — a ceiling, and still a demo failure.
	Manual []DemoStep
	// Console are the deliberate human-in-the-loop steps. NOT a failure.
	Console []DemoStep
}

// Passed reports whether this cloud clears the demo bar: every applicable step driven from the
// CLI, with only deliberate console steps set aside. Gaps and ceilings BOTH fail, per the ruling.
func (p CLIDemoProof) Passed() bool { return len(p.Gaps) == 0 && len(p.Manual) == 0 }

// Verdict renders the one-line ledger verdict.
func (p CLIDemoProof) Verdict() string {
	if p.Passed() {
		return fmt.Sprintf("PASS — %d/%d steps driven from the CLI (%d deliberate console step(s))",
			len(p.Driven), len(p.Driven)+len(p.Console), len(p.Console))
	}
	return fmt.Sprintf("FAIL — %d step(s) the CLI cannot reach, %d the cloud offers no API for (%d driven)",
		len(p.Gaps), len(p.Manual), len(p.Driven))
}

// Summary renders the human-readable block for the proof bundle and the step summary. It names
// every non-driven step with its reason and issue, because a bare count is not actionable and a
// proof bundle nobody can act on is a screenshot.
func (p CLIDemoProof) Summary() string {
	var b strings.Builder
	fmt.Fprintf(&b, "CLI-only demo — %s\n%s\n\n", p.Cloud, p.Verdict())
	fmt.Fprintf(&b, "driven from the CLI (%d): %s\n", len(p.Driven), strings.Join(p.Driven, ", "))
	section := func(title string, steps []DemoStep) {
		if len(steps) == 0 {
			return
		}
		fmt.Fprintf(&b, "\n%s (%d):\n", title, len(steps))
		for _, s := range steps {
			fmt.Fprintf(&b, "  - %s [%s]", s.Title, s.ID)
			if s.Issue != "" {
				fmt.Fprintf(&b, " %s", s.Issue)
			}
			fmt.Fprintf(&b, "\n      %s\n", s.Why)
		}
	}
	section("FAIL — the CLI cannot reach these (our debt)", p.Gaps)
	section("FAIL — no cloud API exists (a ceiling, filed anyway)", p.Manual)
	section("set aside — deliberately human-in-the-loop", p.Console)
	return b.String()
}

// ScoreCLIDemo partitions the table for one cloud. It does NOT execute anything — the run half
// does that and only then trusts these verdicts. Keeping the partition pure is what lets ci.yml
// check the table's shape on every PR for free.
func ScoreCLIDemo(cloud string) (CLIDemoProof, error) {
	p := CLIDemoProof{Cloud: cloud}
	seen := map[string]bool{}
	for _, s := range CLIDemoSteps {
		if err := s.Validate(); err != nil {
			return CLIDemoProof{}, err
		}
		if seen[s.ID] {
			return CLIDemoProof{}, fmt.Errorf("duplicate step ID %q — IDs are the ledger's primary key", s.ID)
		}
		seen[s.ID] = true
		if !s.AppliesTo(cloud) {
			continue
		}
		switch s.Reach {
		case CLIDriven:
			p.Driven = append(p.Driven, s.ID)
		case CLIGap:
			p.Gaps = append(p.Gaps, s)
		case CloudManual:
			p.Manual = append(p.Manual, s)
		case ConsoleOnly:
			p.Console = append(p.Console, s)
		}
	}
	if len(p.Driven) == 0 {
		return CLIDemoProof{}, fmt.Errorf("cloud %q scored ZERO CLI-driven steps — a table that proves nothing for a cloud is an error, not a skip", cloud)
	}
	return p, nil
}

// CLIDemoEnabled reports whether the CLI-only demo scenario is switched on for this run.
func CLIDemoEnabled() bool { return t2Truthy(os.Getenv("ALETHIA_E2E_CLI_DEMO")) }

// CLIDemoBinary is the `alethia` binary under test. It defaults to whatever is on PATH so a
// maintainer can point the harness at a release artifact and prove the bar against the binary
// that actually ships — not against a `go run` of the working tree, which can pass while the
// released CLI is a version behind (v0.4.0 predates both `project ... placement` and
// `connector hetzner`).
func CLIDemoBinary() string {
	if b := strings.TrimSpace(os.Getenv("ALETHIA_E2E_CLI_BIN")); b != "" {
		return b
	}
	return "alethia"
}

// CLIDemoStepIDs returns every step ID, sorted — for stable ledger and issue-dedup output.
func CLIDemoStepIDs() []string {
	ids := make([]string, 0, len(CLIDemoSteps))
	for _, s := range CLIDemoSteps {
		ids = append(ids, s.ID)
	}
	sort.Strings(ids)
	return ids
}
