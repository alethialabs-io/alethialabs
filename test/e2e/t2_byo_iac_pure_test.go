// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the PURE half of the BYO-IaC continuous-proof leg (#1765). No cloud, no Postgres,
// no build tag — these run in every `go test ./...`, which is the only tier that ever executes on
// a PR (the leg itself is main-gated).
//
// The bar here is the bar the leg exists to hold: each test pins a way the leg could report green
// having proven nothing.
package e2e

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestIsFullCommitSHA(t *testing.T) {
	good := "1e51a8f0c2b34d5e6f708192a3b4c5d6e7f80912"
	if !isFullCommitSHA(good) {
		t.Fatalf("isFullCommitSHA(%q) = false, want true", good)
	}
	for name, bad := range map[string]string{
		"empty":       "",
		"abbreviated": "1e51a8f",
		"too long":    good + "0",
		"uppercase":   strings.ToUpper(good),
		"non-hex":     strings.Repeat("g", 40),
		"a ref name":  "refs/heads/main",
	} {
		if isFullCommitSHA(bad) {
			t.Errorf("%s: isFullCommitSHA(%q) = true, want false — an unpinned or abbreviated id must never reach the runner", name, bad)
		}
	}
}

func TestParseLsRemoteSHA(t *testing.T) {
	sha := "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee"
	got, err := parseLsRemoteSHA(sha+"\trefs/heads/main\n", "main")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != sha {
		t.Fatalf("got %q, want %q", got, sha)
	}

	// An empty answer must be an error, never an empty pin.
	if _, err := parseLsRemoteSHA("", "main"); err == nil {
		t.Error("an ls-remote that resolved nothing must error — an empty commit would be sent to the runner as the pin")
	}

	// Ambiguity is the interesting case: `main` matching BOTH a branch and a tag must NOT silently
	// take the first line, because which one git lists first is not something the harness controls.
	other := "1111111122222222333333334444444455555555"
	if _, err := parseLsRemoteSHA(sha+"\trefs/heads/main\n"+other+"\trefs/tags/main\n", "main"); err == nil {
		t.Error("a ref matching both a branch and a tag must error rather than pinning whichever git printed first")
	}

	// A peeled annotated tag alongside its tag object is NOT ambiguity — the peeled entry is the
	// commit, and that is the one to pin.
	peeled, err := parseLsRemoteSHA(other+"\trefs/tags/v1\n"+sha+"\trefs/tags/v1^{}\n", "v1")
	if err != nil {
		t.Fatalf("peeled tag: unexpected error: %v", err)
	}
	if peeled != sha {
		t.Fatalf("peeled tag: got %q, want the peeled commit %q", peeled, sha)
	}
}

func TestByoIacSourceValidate(t *testing.T) {
	ok := byoIacSource{
		RepoURL:   "https://github.com/alethialabs-io/alethia-examples",
		Ref:       "main",
		Path:      "iac/drift/aws",
		CommitSHA: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee",
	}
	if err := ok.validate(); err != nil {
		t.Fatalf("a well-formed source must validate: %v", err)
	}

	bad := map[string]byoIacSource{
		"no repo":      {Ref: "main", Path: "p", CommitSHA: ok.CommitSHA},
		"file:// repo": {RepoURL: "file:///tmp/repo", Ref: "main", Path: "p", CommitSHA: ok.CommitSHA},
		"http:// repo": {RepoURL: "http://example.com/r", Ref: "main", Path: "p", CommitSHA: ok.CommitSHA},
		"no path":      {RepoURL: ok.RepoURL, Ref: "main", CommitSHA: ok.CommitSHA},
		"unpinned":     {RepoURL: ok.RepoURL, Ref: "main", Path: "p"},
		"short sha":    {RepoURL: ok.RepoURL, Ref: "main", Path: "p", CommitSHA: "aaaaaaa"},
	}
	for name, s := range bad {
		if err := s.validate(); err == nil {
			t.Errorf("%s: validate() = nil, want an error", name)
		}
	}
}

// TestByoIacSnapshotCarriesIacSource pins the snapshot keys against the JSON tags
// types.ProjectIacSourceConfig decodes. The harness writes this snapshot with raw SQL, so nothing
// else in the build would notice a rename on either side.
func TestByoIacSnapshotCarriesIacSource(t *testing.T) {
	src := byoIacSource{RepoURL: "https://x/y", Ref: "main", Path: "iac/drift/gcp", CommitSHA: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee"}
	snap := buildByoIacSnapshot("proj", "e2e1", "gcp", "europe-west4", src)

	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var decoded struct {
		Provider  string `json:"provider"`
		IacSource *struct {
			RepoURL   string `json:"repo_url"`
			Ref       string `json:"ref"`
			Path      string `json:"path"`
			CommitSHA string `json:"commit_sha"`
		} `json:"iac_source"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if decoded.IacSource == nil {
		t.Fatal("the snapshot carries no iac_source — the runner would take the TEMPLATE path and provision an Alethia cluster instead of the customer's module")
	}
	if decoded.IacSource.CommitSHA != src.CommitSHA || decoded.IacSource.Path != src.Path {
		t.Fatalf("iac_source did not round-trip: %+v", *decoded.IacSource)
	}
	if decoded.Provider != "gcp" {
		t.Fatalf("provider = %q, want gcp", decoded.Provider)
	}
	// A BYO snapshot must carry no add-ons: they are post-apply Helm gated on a cluster this leg
	// deliberately never creates, so including them would only misdescribe the run.
	if _, present := snap["addons"]; present {
		t.Error("the BYO snapshot carries `addons`, but a customer module emits no cluster_name so the add-on tail never runs")
	}
}

func TestAssertNoClusterNameOutput(t *testing.T) {
	clean := tfstateOutputs{}
	if err := json.Unmarshal([]byte(`{"drift_target":{"value":"x"},"alethia_context":{"value":"p/e"}}`), &clean); err != nil {
		t.Fatal(err)
	}
	if err := assertNoClusterNameOutput(clean); err != nil {
		t.Fatalf("a probe module's outputs must pass: %v", err)
	}

	// Every alias cloud.ExtractClusterName recognises must be caught: any one of them turns this
	// cheap probe into a full cluster provision, at real cost and real runtime.
	for _, name := range []string{"cluster_name", "eks_cluster_name", "gke_cluster_name", "aks_cluster_name", "ack_cluster_name", "talos_cluster_name"} {
		var o tfstateOutputs
		if err := json.Unmarshal([]byte(`{"`+name+`":{"value":"c"}}`), &o); err != nil {
			t.Fatal(err)
		}
		if err := assertNoClusterNameOutput(o); err == nil {
			t.Errorf("output %q was accepted — it is exactly the signal that makes the runner continue into the cluster tail", name)
		}
	}
}

func TestParseTfstateOutputs(t *testing.T) {
	if _, err := parseTfstateOutputs(nil); err == nil {
		t.Error("an empty state document must error — a leg that shrugged at unreadable state asserts nothing")
	}
	if _, err := parseTfstateOutputs([]byte("{not json")); err == nil {
		t.Error("an unparseable state document must error")
	}
	o, err := parseTfstateOutputs([]byte(`{"outputs":{"drift_target":{"value":"/alethia/x"},"n":{"value":7}}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, err := o.outputString("drift_target")
	if err != nil || got != "/alethia/x" {
		t.Fatalf("outputString(drift_target) = %q, %v", got, err)
	}
	if _, err := o.outputString("missing"); err == nil {
		t.Error("a missing output must error")
	}
	if _, err := o.outputString("n"); err == nil {
		t.Error("a non-string output must error rather than being coerced")
	}
}

// TestByoIacMutationArgvEveryCloud is the cloud-parity guard: every provider with a drift module
// must also have an out-of-band mutation, or the leg could apply a probe it can never drift.
func TestByoIacMutationArgvEveryCloud(t *testing.T) {
	opts := byoIacMutationOpts{Region: "eu-central-1", Account: "my-gcp-project"}
	for provider := range byoIacProbeResourceType {
		argv, err := byoIacMutationArgv(provider, "the-target", "drifted-42", opts)
		if err != nil {
			t.Errorf("%s has a probe resource but no out-of-band mutation: %v", provider, err)
			continue
		}
		if len(argv) < 3 {
			t.Errorf("%s: argv %v is too short to be a real command", provider, argv)
		}
		joined := strings.Join(argv, " ")
		if !strings.Contains(joined, "the-target") {
			t.Errorf("%s: argv %v never names the drift target", provider, argv)
		}
		if !strings.Contains(joined, "drifted-42") {
			t.Errorf("%s: argv %v never carries the new value", provider, argv)
		}
		// The whole point is that the change does NOT go through tofu.
		if argv[0] == "tofu" || argv[0] == "terraform" {
			t.Errorf("%s: the mutation runs %q — an in-tofu change is an ordinary change and proves nothing about out-of-band drift", provider, argv[0])
		}
	}
}

func TestByoIacMutationArgvPerCloudFlags(t *testing.T) {
	opts := byoIacMutationOpts{Region: "eu-central-1", Account: "proj-123"}

	cases := map[string][]string{
		"aws":     {"aws", "ssm", "put-parameter", "--name", "/a/b", "--type", "String", "--value", "drifted-1", "--overwrite"},
		"azure":   {"az", "group", "update", "--name", "/a/b", "--force-string", "--set", "tags.drift_marker=drifted-1"},
		"gcp":     {"gcloud", "storage", "buckets", "update", "gs:///a/b", "--update-labels=drift_marker=drifted-1", "--project", "proj-123"},
		"alibaba": {"aliyun", "oss", "bucket-tagging", "--method", "put", "--region", "eu-central-1", "oss:///a/b", "drift_marker#drifted-1"},
		"hetzner": {"hcloud", "placement-group", "add-label", "--overwrite", "/a/b", "drift_marker=drifted-1"},
	}
	for provider, want := range cases {
		got, err := byoIacMutationArgv(provider, "/a/b", "drifted-1", opts)
		if err != nil {
			t.Errorf("%s: %v", provider, err)
			continue
		}
		if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
			t.Errorf("%s argv:\n got %v\nwant %v", provider, got, want)
		}
	}

	// gcloud does not read GOOGLE_PROJECT (a Terraform variable), so when the harness cannot
	// resolve a project id the flag is omitted and gcloud falls back to its own config — rather
	// than being passed an empty --project, which is an error.
	got, err := byoIacMutationArgv("gcp", "k", "v", byoIacMutationOpts{})
	if err != nil {
		t.Fatalf("gcp without an account: %v", err)
	}
	if strings.Contains(strings.Join(got, " "), "--project") {
		t.Errorf("gcp argv %v passes --project with no value", got)
	}

	// `aliyun oss` builds its endpoint from the region and hard-errors without one, so a missing
	// region must fail HERE, before the leg has applied anything.
	if _, err := byoIacMutationArgv("alibaba", "b", "v", byoIacMutationOpts{}); err == nil {
		t.Error("alibaba without a region must error — the CLI cannot resolve an OSS endpoint")
	}
}

func TestByoIacMutationArgvRefusesVacuousInput(t *testing.T) {
	opts := byoIacMutationOpts{Region: "r", Account: "a"}
	if _, err := byoIacMutationArgv("aws", "", "v", opts); err == nil {
		t.Error("an empty drift target must error — there would be nothing to mutate")
	}
	if _, err := byoIacMutationArgv("aws", "t", "", opts); err == nil {
		t.Error("an empty new value must error")
	}
	// The single most important refusal: "mutating" to the value the module already has changes
	// nothing, so the follow-up posture would honestly report in_sync and the leg would read that
	// as a detector failure — or, worse, a reviewer would relax the assertion.
	if _, err := byoIacMutationArgv("aws", "t", byoIacBaselineMarker, opts); err == nil {
		t.Error("mutating to the module's own baseline must error — the live value would not change")
	}
	if _, err := byoIacMutationArgv("digitalocean", "t", "v", opts); err == nil {
		t.Error("an unwired provider must error rather than returning a no-op the leg would treat as a successful induction")
	}
}

func TestByoIacDriftedProbe(t *testing.T) {
	if !byoIacDriftedProbe("aws", []string{"aws_iam_role", "aws_ssm_parameter"}) {
		t.Error("the probe resource among the drifted types must be recognised")
	}
	if byoIacDriftedProbe("aws", []string{"aws_iam_role"}) {
		t.Error("drift on an unrelated resource must NOT be credited as the induced change")
	}
	if byoIacDriftedProbe("aws", nil) {
		t.Error("an empty drift set must not count as the probe having drifted")
	}
	if byoIacDriftedProbe("nope", []string{"aws_ssm_parameter"}) {
		t.Error("an unwired provider must never match")
	}
}

// byoIacPassingSummary is a summary in which every link of the custody chain held.
func byoIacPassingSummary() ByoIacSummary {
	return ByoIacSummary{
		Enabled:                   true,
		Provider:                  "aws",
		Repo:                      byoIacDefaultRepo,
		Ref:                       "main",
		Path:                      "iac/drift/aws",
		PinnedSHA:                 "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee",
		GateBlockedNonAllowlisted: true,
		CloneAtPinnedLogged:       true,
		GatePassedLogged:          true,
		DeployStatus:              "SUCCESS",
		ReceiptPlanSHA:            strings.Repeat("a", 64),
		StateOnProxy:              true,
		StateResources:            1,
		NoClusterNameOutput:       true,
		AlethiaContextEcho:        "proj/e2e1",
		DriftTarget:               "/alethia/byo-iac-drift/proj/e2e1",
		BaselineInSync:            true,
		MutationApplied:           true,
		DriftedCount:              1,
		DriftedTypes:              []string{"aws_ssm_parameter"},
		DriftedIsProbe:            true,
		HealStatus:                "SUCCESS",
		HealedInSync:              true,
		DestroyStatus:             "SUCCESS",
		StateCleared:              true,
	}
}

// TestByoIacVerdictPass enumerates every single-link failure. The leg's claim is the whole chain,
// so there is no partial credit — each mutation below must flip the verdict to false.
func TestByoIacVerdictPass(t *testing.T) {
	if !byoIacVerdictPass(byoIacPassingSummary()) {
		t.Fatal("a fully-proven run must pass the verdict")
	}

	breaks := map[string]func(*ByoIacSummary){
		"disabled":                  func(s *ByoIacSummary) { s.Enabled = false },
		"unpinned commit":           func(s *ByoIacSummary) { s.PinnedSHA = "main" },
		"gate let the bad one in":   func(s *ByoIacSummary) { s.GateBlockedNonAllowlisted = false },
		"pin never logged":          func(s *ByoIacSummary) { s.CloneAtPinnedLogged = false },
		"gate pass never logged":    func(s *ByoIacSummary) { s.GatePassedLogged = false },
		"deploy failed":             func(s *ByoIacSummary) { s.DeployStatus = "FAILED" },
		"no receipt":                func(s *ByoIacSummary) { s.ReceiptPlanSHA = "" },
		"state not on the proxy":    func(s *ByoIacSummary) { s.StateOnProxy = false },
		"state manages nothing":     func(s *ByoIacSummary) { s.StateResources = 0 },
		"module emits cluster_name": func(s *ByoIacSummary) { s.NoClusterNameOutput = false },
		"tfvars never arrived":      func(s *ByoIacSummary) { s.AlethiaContextEcho = "" },
		"no drift target":           func(s *ByoIacSummary) { s.DriftTarget = "" },
		"baseline already drifted":  func(s *ByoIacSummary) { s.BaselineInSync = false },
		"mutation never ran":        func(s *ByoIacSummary) { s.MutationApplied = false },
		"posture did not flip":      func(s *ByoIacSummary) { s.DriftedCount = 0 },
		"drift on something else":   func(s *ByoIacSummary) { s.DriftedIsProbe = false },
		"heal failed":               func(s *ByoIacSummary) { s.HealStatus = "FAILED" },
		"never healed":              func(s *ByoIacSummary) { s.HealedInSync = false },
		"destroy failed":            func(s *ByoIacSummary) { s.DestroyStatus = "FAILED" },
		"state left behind":         func(s *ByoIacSummary) { s.StateCleared = false },
	}
	for name, brk := range breaks {
		s := byoIacPassingSummary()
		brk(&s)
		if byoIacVerdictPass(s) {
			t.Errorf("%s: the verdict still passes — this link of the custody chain is not actually gated", name)
		}
	}
}

func TestByoIacSummaryVerdictRendering(t *testing.T) {
	if got := byoIacSummaryVerdict(ByoIacSummary{}); !strings.Contains(got, "skipped") {
		t.Errorf("a disabled leg must render as skipped, got %q", got)
	}
	pass := byoIacSummaryVerdict(byoIacPassingSummary())
	if !strings.HasPrefix(pass, "✅") {
		t.Errorf("a proven run must render ✅, got %q", pass)
	}
	broken := byoIacPassingSummary()
	broken.DriftedCount = 0
	if got := byoIacSummaryVerdict(broken); !strings.HasPrefix(got, "❌") {
		t.Errorf("a run whose posture never flipped must render ❌, got %q", got)
	}
}

func TestWriteByoIacSummary(t *testing.T) {
	path := t.TempDir() + "/byo.json"
	want := byoIacPassingSummary()
	if err := writeByoIacSummary(path, want); err != nil {
		t.Fatalf("write: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	var got ByoIacSummary
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("the summary is not valid JSON — the proof capture reads it: %v", err)
	}
	if got.PinnedSHA != want.PinnedSHA || got.DriftedCount != want.DriftedCount {
		t.Fatalf("summary did not round-trip: %+v", got)
	}
}

// TestByoIacDefaultsResolvePerProvider pins the derived per-cloud default path. Getting this wrong
// points every cloud at one module and the leg silently proves one cloud five times.
func TestByoIacDefaultsResolvePerProvider(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		if got, want := byoIacPath(provider), "iac/drift/"+provider; got != want {
			t.Errorf("byoIacPath(%q) = %q, want %q", provider, got, want)
		}
		if got := byoIacRepo(provider); got != byoIacDefaultRepo {
			t.Errorf("byoIacRepo(%q) = %q, want the public default", provider, got)
		}
		if got := byoIacBlockedPath(provider); got == byoIacPath(provider) {
			t.Errorf("%s: the blocked fixture path equals the real module path — the negative case would prove nothing", provider)
		}
	}

	// The per-provider override idiom must win over the base variable.
	t.Setenv(envByoIacPath, "custom/base")
	t.Setenv(envByoIacPath+"_AWS", "custom/aws")
	if got := byoIacPath("aws"); got != "custom/aws" {
		t.Errorf("per-provider override lost: got %q", got)
	}
	if got := byoIacPath("gcp"); got != "custom/base" {
		t.Errorf("base override lost: got %q", got)
	}
}

// TestByoIacProbeResourceTypeCoversEveryT2Provider is the cloud-parity ratchet: the leg must be
// wired for every provider the T2 harness itself supports, or a cloud silently has no BYO proof
// while the board reports the feature shipped.
func TestByoIacProbeResourceTypeCoversEveryT2Provider(t *testing.T) {
	for _, provider := range strings.Split(t2SupportedProviders(), ", ") {
		provider = strings.TrimSpace(provider)
		if provider == "" {
			continue
		}
		if _, ok := byoIacProbeResourceType[provider]; !ok {
			t.Errorf("provider %q is supported by the T2 harness but has no BYO-IaC drift probe — either add iac/drift/%s upstream and wire it here, or the BYO claim does not hold on that cloud", provider, provider)
		}
	}
}

// githubContentsURL is what makes the fixture preflight possible without a clone, so its parsing is
// worth pinning: a URL built wrongly would 404 for the WRONG reason and report a present module as
// missing — a preflight that fails a run nothing is wrong with is worse than no preflight.
func TestGithubContentsURL(t *testing.T) {
	got, ok := githubContentsURL("https://github.com/alethialabs-io/alethia-examples", "abc123", "iac/drift/hetzner")
	if !ok {
		t.Fatal("a plain github https repo was not recognised")
	}
	const want = "https://api.github.com/repos/alethialabs-io/alethia-examples/contents/iac/drift/hetzner?ref=abc123"
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}

	// A trailing `.git` is how a remote is written half the time, and it must not end up inside the
	// slug — `…/enterprise-demo.git/contents/…` 404s for a reason that has nothing to do with the
	// module being absent.
	if got, _ := githubContentsURL("https://github.com/alethialabs-io/alethia-examples.git", "s", "p"); !strings.Contains(got, "/repos/alethialabs-io/alethia-examples/contents/") {
		t.Errorf(".git suffix leaked into the slug: %s", got)
	}
	// A leading slash on the path would double up and 404 the same way.
	if got, _ := githubContentsURL("https://github.com/o/r", "s", "/iac/blocked"); !strings.Contains(got, "/contents/iac/blocked?") {
		t.Errorf("leading slash was not trimmed: %s", got)
	}

	// NOT github. The preflight must decline rather than invent an API shape — an unrecognised host
	// is "cannot check", which the caller logs and proceeds past, not "the module is missing".
	for _, repo := range []string{
		"https://gitlab.com/o/r",
		"git@github.com:o/r.git",
		"https://github.com/only-one-segment",
		"https://github.com/",
	} {
		if _, ok := githubContentsURL(repo, "s", "p"); ok {
			t.Errorf("%q was treated as a github contents target", repo)
		}
	}
}

// The decode that made the byo-iac drift leg unpassable on every cloud.
//
// `byoIacPosture` carried no JSON tags. `encoding/json` matches a tag first and otherwise falls
// back to a CASE-INSENSITIVE match on the field NAME — which never matches an underscored key. So
// `drifted` and `details` decoded correctly while `in_sync` silently left InSync at false, and the
// baseline assertion ("not in-sync right after a clean apply") failed every single time.
//
// The giveaway was in the output all along: drift.Analyze sets `InSync = Drifted == 0`, so
// `in_sync=false drifted=0` is a posture it cannot produce.
func TestByoIacPostureDecodesInSync(t *testing.T) {
	t.Run("in_sync survives the decode", func(t *testing.T) {
		var p byoIacPosture
		if err := json.Unmarshal([]byte(`{"in_sync":true,"drifted":0,"details":[]}`), &p); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !p.InSync {
			t.Error("in_sync decoded as false — the underscored key did not reach InSync, which is the bug this pins")
		}
		if p.Drifted != 0 {
			t.Errorf("drifted = %d, want 0", p.Drifted)
		}
	})

	t.Run("a drifted posture decodes its details", func(t *testing.T) {
		var p byoIacPosture
		raw := `{"in_sync":false,"drifted":1,"details":[{"address":"google_storage_bucket.drift_probe","type":"google_storage_bucket","kind":"modified"}]}`
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if p.InSync {
			t.Error("in_sync=false must decode as false")
		}
		if p.Drifted != 1 || len(p.Details) != 1 {
			t.Fatalf("drifted=%d details=%d, want 1 and 1", p.Drifted, len(p.Details))
		}
		// The drift assertion is "it drifted on OUR resource", so the type has to survive.
		if got := p.types(); len(got) != 1 || got[0] != "google_storage_bucket" {
			t.Errorf("types() = %v, want [google_storage_bucket]", got)
		}
	})

	t.Run("in_sync=false with drifted=0 is the shape the bug produced", func(t *testing.T) {
		// Not asserting behaviour — documenting the fingerprint, so anyone who sees it again knows
		// to suspect a decode rather than the cloud. drift.Analyze cannot emit it.
		var p byoIacPosture
		if err := json.Unmarshal([]byte(`{"drifted":0,"details":[]}`), &p); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if p.InSync {
			t.Error("an ABSENT in_sync must decode false, so the fingerprint stays recognisable")
		}
	})
}

// TestByoIacPostureDetail is the guard on the field this leg used to throw away.
//
// drift.Analyze has always emitted `attributes` (the paths that actually differed). byoIacPosture
// did not decode it, so every drift verdict named a resource TYPE and nothing else — and
// gcp/maxconfig run 33107356336 died on "the environment did NOT heal … [google_storage_bucket]",
// which cannot separate "the label did not revert" from "something else on the bucket will not
// converge". Those go to different fixes.
func TestByoIacPostureDetail(t *testing.T) {
	var p byoIacPosture
	if err := json.Unmarshal([]byte(`{
	  "in_sync": false, "drifted": 1,
	  "details": [{"address":"google_storage_bucket.drift_probe","type":"google_storage_bucket",
	               "kind":"update","attributes":["labels.drift_marker","effective_labels"]}]
	}`), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := p.detail()
	for _, want := range []string{
		"google_storage_bucket.drift_probe", // the ADDRESS, not just the type
		"(update)",
		"labels.drift_marker",
		"effective_labels",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("detail() must carry %q, got %s", want, got)
		}
	}

	// "the analyzer reported no attribute paths" must not render like "we forgot to ask" — that
	// ambiguity is the whole reason this field was invisible for so long.
	var bare byoIacPosture
	if err := json.Unmarshal([]byte(`{"in_sync":false,"drifted":1,
	  "details":[{"address":"a.b","type":"t","kind":"update"}]}`), &bare); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(bare.detail(), "<none reported>") {
		t.Errorf("an empty attribute list must say so explicitly, got %s", bare.detail())
	}

	if got := (byoIacPosture{}).detail(); got != "[]" {
		t.Errorf("an empty posture renders %q, want []", got)
	}
}
