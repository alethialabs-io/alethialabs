// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strconv"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
)

// The four leaves the CLI-surface census still called "takes input with no form" (#4454), ANSWERED.
//
// Every form here is driven through authFormAnswer, which builds the REAL huh widgets the
// production code assembled and feeds them real key messages, rather than through the
// `runHuhForm = func(...) error { return nil }` seam. The difference is the whole point of this
// file: a nil stub leaves the bound variable at the value the form was SEEDED with, so every
// assertion it can make is an assertion about the seed. Each answered test below moves the cursor
// before pressing enter, so the value it asserts is one only the widget could have produced — and a
// form wired to the wrong list, or seeded at the wrong index, fails rather than passing on the seed.
//
// Every identifier here carries the tailForms prefix.

// tailFormsTTY puts the package's terminal seams into "a person is at this terminal", which is what
// canPromptForm and requireInteractiveForm both read before any of these forms may open.
func tailFormsTTY(t *testing.T) {
	t.Helper()
	prevIn, prevOut, prevNoInput := stdinIsTTY, stdoutIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	noInputMode = false
	t.Cleanup(func() {
		stdinIsTTY, stdoutIsTTY, noInputMode = prevIn, prevOut, prevNoInput
	})
}

// tailFormsHeadless is the other posture: prompts disabled, exactly as a pipeline sees it.
func tailFormsHeadless(t *testing.T) {
	t.Helper()
	prev := noInputMode
	noInputMode = true
	t.Cleanup(func() { noInputMode = prev })
}

// tailFormsScript is one runHuhForm call's keystrokes.
func tailFormsScript(keys ...tea.KeyMsg) *authFormScript { return &authFormScript{keys: keys} }

// tailFormsDown is n cursor-down presses followed by enter — the shortest script that proves an
// answer came from the widget rather than from the seed.
func tailFormsDown(n int) *authFormScript {
	var keys []tea.KeyMsg
	for i := 0; i < n; i++ {
		keys = append(keys, tea.KeyMsg{Type: tea.KeyDown})
	}
	return tailFormsScript(authFormKey(keys, tea.KeyEnter)...)
}

// ── alethia activity ──────────────────────────────────────────────────────────────────────────

// TestTailForms_ActivityOffersMoreRowsAfterAFullPage drives the "more activity?" select, which is
// put AFTER the table and only when the page came back full.
//
// For a limit of 50 the options are Done, then 100, 200 and 500, so one cursor-down lands on 100.
// Asserting 100 is what makes this test about the widget: a form that never opened answers 0.
func TestTailForms_ActivityOffersMoreRowsAfterAFullPage(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsTTY(t)
	scripts := authFormAnswer(t, tailFormsDown(1))

	got, err := offerMoreActivity(50, 50)
	if err != nil {
		t.Fatalf("offerMoreActivity: %v", err)
	}
	if !scripts[0].ran {
		t.Fatal("no form was opened, so the answer below did not come from it")
	}
	if got != 100 {
		t.Errorf("next limit = %d, want 100 — the first rung above 50 in %v", got, activityRowLadder)
	}
}

// TestTailForms_ActivityAsksNothingAfterAShortPage pins that a page shorter than the limit is the
// whole log, so no question is put.
func TestTailForms_ActivityAsksNothingAfterAShortPage(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsTTY(t)
	authFormNoForm(t)
	got, err := offerMoreActivity(50, 12)
	if err != nil || got != 0 {
		t.Errorf("offerMoreActivity(50, 12) = (%d, %v), want (0, nil)", got, err)
	}
}

// TestTailForms_ActivityHeadlessAsksNothing pins that a pipeline is never asked: the limit has a
// default, so a defaulted field is never a refusal and never a question.
func TestTailForms_ActivityHeadlessAsksNothing(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsHeadless(t)
	authFormNoForm(t)
	got, err := offerMoreActivity(50, 50)
	if err != nil || got != 0 {
		t.Errorf("offerMoreActivity headless = (%d, %v), want (0, nil)", got, err)
	}
}

// TestTailForms_ActivityMorePropagatesADismissal pins that abandoning the question stops the loop
// with the error rather than reading it as an answer.
func TestTailForms_ActivityMorePropagatesADismissal(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsTTY(t)
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return errBoom }
	t.Cleanup(func() { runHuhForm = prev })

	if got, err := offerMoreActivity(50, 50); err == nil || got != 0 {
		t.Errorf("a dismissed question = (%d, %v), want (0, an error)", got, err)
	}
}

// TestTailForms_ActivityRowsAboveTheLimit is the arithmetic behind the offer: only rungs larger than
// what was just read, ascending, and nothing at all past the top rung.
func TestTailForms_ActivityRowsAboveTheLimit(t *testing.T) {
	for limit, want := range map[int][]int{
		1:    {25, 50, 100, 200, 500},
		50:   {100, 200, 500},
		60:   {100, 200, 500},
		500:  {},
		5000: {},
	} {
		got := activityRowsAbove(limit)
		if strings.Join(intStrings(got), ",") != strings.Join(intStrings(want), ",") {
			t.Errorf("activityRowsAbove(%d) = %v, want %v", limit, got, want)
		}
	}
	// Past the top rung there is nothing to offer, so no question is put even after a full page.
	tailFormsTTY(t)
	authFormNoForm(t)
	if got, err := offerMoreActivity(500, 500); err != nil || got != 0 {
		t.Errorf("offerMoreActivity(500, 500) = (%d, %v), want (0, nil)", got, err)
	}
}

// intStrings renders ints for a comparison message.
func intStrings(ns []int) []string {
	out := make([]string, len(ns))
	for i, n := range ns {
		out[i] = strconv.Itoa(n)
	}
	return out
}

// ── alethia repo list ─────────────────────────────────────────────────────────────────────────

// TestTailForms_RepoProviderComesFromTheOfferedList drives the provider select.
//
// Seeded with the flag's default, which is gitProviders[0], so one cursor-down is gitProviders[1].
// Asserting that value rather than a literal keeps this test honest if the list ever grows a
// provider at the front.
func TestTailForms_RepoProviderComesFromTheOfferedList(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsTTY(t)
	scripts := authFormAnswer(t, tailFormsDown(1))

	got, err := promptRepoProvider(repoListCmd, gitProviders[0])
	if err != nil {
		t.Fatalf("promptRepoProvider: %v", err)
	}
	if !scripts[0].ran {
		t.Fatal("no form was opened, so the answer below came from the seed")
	}
	if got != gitProviders[1] {
		t.Errorf("provider = %q, want %q — one below the seeded %q",
			got, gitProviders[1], gitProviders[0])
	}
}

// TestTailForms_RepoProviderOffersAnUnknownCurrentValue pins the append.
//
// gitProviders is an OFFER and not a validation set, so `--provider forgejo` is a thing a person can
// already have in a shell history. Seeding the select with a value the options do not carry would
// open the picker on `github` and turn enter into a silent switch of provider.
func TestTailForms_RepoProviderOffersAnUnknownCurrentValue(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsTTY(t)
	scripts := authFormAnswer(t, tailFormsDown(0))

	got, err := promptRepoProvider(repoListCmd, "forgejo")
	if err != nil {
		t.Fatalf("promptRepoProvider: %v", err)
	}
	if !scripts[0].ran {
		t.Fatal("no form was opened")
	}
	if got != "forgejo" {
		t.Errorf("provider = %q, want the seeded forgejo — the picker cannot offer it", got)
	}
}

// TestTailForms_RepoProviderIsNotAskedWhenNamed pins the flag half.
func TestTailForms_RepoProviderIsNotAskedWhenNamed(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsTTY(t)
	authFormNoForm(t)
	if err := repoListCmd.Flags().Set("provider", "gitlab"); err != nil {
		t.Fatalf("set --provider: %v", err)
	}
	got, err := promptRepoProvider(repoListCmd, "gitlab")
	if err != nil {
		t.Fatalf("promptRepoProvider: %v", err)
	}
	if got != "gitlab" {
		t.Errorf("provider = %q, want the flag's gitlab", got)
	}
}

// TestTailForms_RepoProviderHeadlessKeepsTheDefault pins the complete-contract rule.
func TestTailForms_RepoProviderHeadlessKeepsTheDefault(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsHeadless(t)
	authFormNoForm(t)
	got, err := promptRepoProvider(repoListCmd, gitProviders[0])
	if err != nil {
		t.Fatalf("promptRepoProvider: %v", err)
	}
	if got != gitProviders[0] {
		t.Errorf("provider = %q, want the default %q", got, gitProviders[0])
	}
}

// TestTailForms_RepoProviderPropagatesADismissal pins the abandoned picker.
func TestTailForms_RepoProviderPropagatesADismissal(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsTTY(t)
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return errBoom }
	t.Cleanup(func() { runHuhForm = prev })

	if _, err := promptRepoProvider(repoListCmd, gitProviders[0]); err == nil {
		t.Fatal("a dismissed picker must not read as an answer")
	}
}

// ── alethia classification show ───────────────────────────────────────────────────────────────

// tailFormsKindDims is a taxonomy whose dimensions name two kinds, one of them twice, plus a
// dimension that targets every kind and therefore names none.
func tailFormsKindDims() []api.ClassificationDimension {
	return []api.ClassificationDimension{
		{Key: "environment", Label: "Environment", AppliesTo: []string{"project_environment"}},
		{Key: "tier", Label: "Tier", AppliesTo: []string{"cluster", "project_environment"}},
		{Key: "owner", Label: "Owner", AppliesTo: nil},
	}
}

// TestTailForms_ClassificationShowAsksForBothTokens drives the two forms `show` opens.
//
// The kinds are sorted, so the select opens on `cluster` and one cursor-down is
// `project_environment` — a value that exists only in the taxonomy this test handed the client, so
// it cannot have come from a default. The id is typed, which no seed could produce either.
func TestTailForms_ClassificationShowAsksForBothTokens(t *testing.T) {
	tailFormsTTY(t)
	scripts := authFormAnswer(t,
		tailFormsDown(1),
		tailFormsScript(authFormKey(authFormType("8f3c1a2b"), tea.KeyEnter)...),
	)

	kind, id, err := resolveClassificationTarget(&fakeClient{classDims: tailFormsKindDims()}, nil)
	if err != nil {
		t.Fatalf("resolveClassificationTarget: %v", err)
	}
	for i, s := range scripts {
		if !s.ran {
			t.Fatalf("form #%d never opened", i+1)
		}
	}
	if kind != "project_environment" {
		t.Errorf("kind = %q, want project_environment — the second of the sorted kinds", kind)
	}
	if id != "8f3c1a2b" {
		t.Errorf("id = %q, want the typed 8f3c1a2b", id)
	}
}

// TestTailForms_ClassificationShowAsksOnlyForWhatIsMissing pins that a named kind is not re-asked.
func TestTailForms_ClassificationShowAsksOnlyForWhatIsMissing(t *testing.T) {
	tailFormsTTY(t)
	scripts := authFormAnswer(t, tailFormsScript(authFormKey(authFormType("abc"), tea.KeyEnter)...))

	kind, id, err := resolveClassificationTarget(
		&fakeClient{classDims: tailFormsKindDims()}, []string{"cluster"})
	if err != nil {
		t.Fatalf("resolveClassificationTarget: %v", err)
	}
	if !scripts[0].ran {
		t.Fatal("the id was never asked for")
	}
	if kind != "cluster" || id != "abc" {
		t.Errorf("got (%q, %q), want (cluster, abc)", kind, id)
	}
}

// TestTailForms_ClassificationShowTypesAKindWhenTheTaxonomyNamesNone pins the fallback.
//
// A taxonomy whose dimensions all target every kind names no kinds to choose from. An empty select
// is a box a reader cannot answer, so the question becomes the typed line the positional carried.
func TestTailForms_ClassificationShowTypesAKindWhenTheTaxonomyNamesNone(t *testing.T) {
	tailFormsTTY(t)
	scripts := authFormAnswer(t,
		tailFormsScript(authFormKey(authFormType("runner"), tea.KeyEnter)...),
		tailFormsScript(authFormKey(authFormType("r1"), tea.KeyEnter)...),
	)

	dims := []api.ClassificationDimension{{Key: "owner", Label: "Owner", AppliesTo: nil}}
	kind, id, err := resolveClassificationTarget(&fakeClient{classDims: dims}, nil)
	if err != nil {
		t.Fatalf("resolveClassificationTarget: %v", err)
	}
	if !scripts[0].ran || !scripts[1].ran {
		t.Fatal("both questions must be asked when neither token was given")
	}
	if kind != "runner" || id != "r1" {
		t.Errorf("got (%q, %q), want (runner, r1)", kind, id)
	}
}

// TestTailForms_ClassificationShowNeedsNoFormWhenBothAreGiven pins the scripted path, including
// that it costs no round trip: the fake refuses every call.
func TestTailForms_ClassificationShowNeedsNoFormWhenBothAreGiven(t *testing.T) {
	tailFormsTTY(t)
	authFormNoForm(t)
	kind, id, err := resolveClassificationTarget(
		&fakeClient{err: errBoom}, []string{" project_environment ", " p1 "})
	if err != nil {
		t.Fatalf("resolveClassificationTarget: %v", err)
	}
	if kind != "project_environment" || id != "p1" {
		t.Errorf("got (%q, %q), want the trimmed arguments", kind, id)
	}
}

// TestTailForms_ClassificationShowHeadlessNamesWhatToPass is the refusal.
//
// Both tokens are required and neither has a default, so a scripted caller IS refused — and the
// refusal has to name the two tokens, because "interactive input required" tells the reader they
// are stuck without telling them how to become unstuck.
func TestTailForms_ClassificationShowHeadlessNamesWhatToPass(t *testing.T) {
	tailFormsHeadless(t)
	authFormNoForm(t)
	_, _, err := resolveClassificationTarget(&fakeClient{classDims: tailFormsKindDims()}, nil)
	if err == nil {
		t.Fatal("a headless `classification show` with no arguments must be refused")
	}
	for _, want := range []string{"resource kind", "resource id", "[kind]", "[id]", "dimensions"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not mention %q:\n      %v", want, err)
		}
	}
}

// TestTailForms_ClassificationShowHeadlessNamesOnlyTheMissingToken pins that the refusal describes
// this invocation and not the command in general.
func TestTailForms_ClassificationShowHeadlessNamesOnlyTheMissingToken(t *testing.T) {
	tailFormsHeadless(t)
	_, _, err := resolveClassificationTarget(&fakeClient{}, []string{"cluster"})
	if err == nil {
		t.Fatal("a headless `classification show <kind>` must be refused")
	}
	if strings.Contains(err.Error(), "resource kind and") {
		t.Errorf("the kind WAS given; the refusal should name the id alone:\n      %v", err)
	}
	if !strings.Contains(err.Error(), "resource id") {
		t.Errorf("the refusal does not name the missing id:\n      %v", err)
	}
}

// TestTailForms_ClassificationShowSurfacesATaxonomyFailure pins that a control-plane error is not
// swallowed into an empty picker.
func TestTailForms_ClassificationShowSurfacesATaxonomyFailure(t *testing.T) {
	tailFormsTTY(t)
	authFormNoForm(t)
	if _, _, err := resolveClassificationTarget(&fakeClient{err: errBoom}, nil); err == nil {
		t.Fatal("a failed taxonomy fetch must not read as a taxonomy that names no kinds")
	}
}

// TestTailForms_ClassificationKindsAreSortedDeduplicatedAndNeverBlank pins the offer itself.
func TestTailForms_ClassificationKindsAreSortedDeduplicatedAndNeverBlank(t *testing.T) {
	dims := append(tailFormsKindDims(),
		api.ClassificationDimension{Key: "blank", AppliesTo: []string{"  ", "cluster"}})
	got := classificationKinds(dims)
	want := []string{"cluster", "project_environment"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("kinds = %v, want %v", got, want)
	}
	if len(classificationKinds(nil)) != 0 {
		t.Errorf("an empty taxonomy names no kinds, got %v", classificationKinds(nil))
	}
}

// ── alethia open --project ────────────────────────────────────────────────────────────────────

// tailFormsConfigs is an org with two named projects and one with no name at all.
func tailFormsConfigs() []types.ConfigurationSummary {
	return []types.ConfigurationSummary{
		{ID: "p1", ProjectName: "boutique", EnvironmentStage: "production"},
		{ID: "p2", ProjectName: "My Shop", EnvironmentStage: "staging"},
		{ID: "p3", ProjectName: ""},
	}
}

// TestTailForms_OpenProjectResolvesAReferenceWithoutAsking pins the three hits that need no form.
func TestTailForms_OpenProjectResolvesAReferenceWithoutAsking(t *testing.T) {
	tailFormsTTY(t)
	authFormNoForm(t)
	for _, tc := range []struct{ ref, want string }{
		{"boutique", "boutique"},
		{"BOUTIQUE", "boutique"},
		{"My Shop", "My Shop"},
		{"p2", "My Shop"},
	} {
		got, err := openProjectName(&fakeClient{configs: tailFormsConfigs()}, tc.ref)
		if err != nil {
			t.Fatalf("openProjectName(%q): %v", tc.ref, err)
		}
		if got != tc.want {
			t.Errorf("openProjectName(%q) = %q, want %q", tc.ref, got, tc.want)
		}
	}
}

// TestTailForms_OpenProjectPicksWhenTheReferenceMisses drives the picker.
//
// One cursor-down is the SECOND named project, so the answer is a value the seed cannot produce —
// and `p3`, which has no name, must not be one of the options, or the count would be off by one and
// the link would be built from an empty segment.
func TestTailForms_OpenProjectPicksWhenTheReferenceMisses(t *testing.T) {
	tailFormsTTY(t)
	scripts := authFormAnswer(t, tailFormsDown(1))

	got, err := openProjectName(&fakeClient{configs: tailFormsConfigs()}, "botique")
	if err != nil {
		t.Fatalf("openProjectName: %v", err)
	}
	if !scripts[0].ran {
		t.Fatal("no picker was opened for a reference this org does not have")
	}
	if got != "My Shop" {
		t.Errorf("picked %q, want My Shop — the second NAMED project", got)
	}
}

// TestTailForms_OpenProjectHeadlessNamesTheRealProjects is the refusal that replaced a 404.
//
// Before #4454 a mistyped name was returned unchanged and slugified into a console URL, so the only
// difference between success and failure was a page nobody reads. The refusal has to carry the
// names, because they are what the reader needs in order to fix the command.
func TestTailForms_OpenProjectHeadlessNamesTheRealProjects(t *testing.T) {
	tailFormsHeadless(t)
	authFormNoForm(t)
	_, err := openProjectName(&fakeClient{configs: tailFormsConfigs()}, "botique")
	if err == nil {
		t.Fatal("a reference this org does not have must not build a link")
	}
	for _, want := range []string{"botique", "boutique", "My Shop"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not mention %q:\n      %v", want, err)
		}
	}
}

// TestTailForms_OpenProjectRefusesRatherThanShowingAnEmptyPicker pins the degenerate org.
func TestTailForms_OpenProjectRefusesRatherThanShowingAnEmptyPicker(t *testing.T) {
	tailFormsTTY(t)
	authFormNoForm(t)
	configs := []types.ConfigurationSummary{{ID: "p3", ProjectName: ""}}
	if _, err := openProjectName(&fakeClient{configs: configs}, "anything"); err == nil {
		t.Fatal("an org with no named project must be refused, not asked")
	}
}

// TestTailForms_OpenProjectRefusesANamelessMatch pins the id that resolves to a row the console
// link cannot be built from.
func TestTailForms_OpenProjectRefusesANamelessMatch(t *testing.T) {
	tailFormsTTY(t)
	authFormNoForm(t)
	_, err := openProjectName(&fakeClient{configs: tailFormsConfigs()}, "p3")
	if err == nil || !strings.Contains(err.Error(), "no name") {
		t.Fatalf("want a refusal naming the missing project name, got %v", err)
	}
}

// TestTailForms_OpenProjectSurfacesAListFailure pins that an unreachable control plane is not read
// as "this org has no such project".
func TestTailForms_OpenProjectSurfacesAListFailure(t *testing.T) {
	tailFormsTTY(t)
	authFormNoForm(t)
	_, err := openProjectName(&fakeClient{err: errBoom}, "boutique")
	if err == nil || !strings.Contains(err.Error(), "resolve --project") {
		t.Fatalf("want the fetch failure named, got %v", err)
	}
}

// TestTailForms_OpenProjectPropagatesADismissal pins the abandoned picker.
func TestTailForms_OpenProjectPropagatesADismissal(t *testing.T) {
	tailFormsTTY(t)
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return errBoom }
	t.Cleanup(func() { runHuhForm = prev })

	if _, err := openProjectName(&fakeClient{configs: tailFormsConfigs()}, "botique"); err == nil {
		t.Fatal("a dismissed picker must not read as an answer")
	}
}

// ── the dismissal reaches the command ─────────────────────────────────────────────────────────

// TestTailForms_ADismissedFormStopsEachCommand drives the four Run bodies rather than the four
// resolvers, because the arm they add is the one a resolver test cannot reach: a form that was
// abandoned must STOP the command, not fall through to a fetch with a half-answered question.
//
// covListEnv forces a terminal and traps exitFunc, so `fail` surfaces as an exit code here instead
// of killing the test binary.
func TestTailForms_ADismissedFormStopsEachCommand(t *testing.T) {
	run := covListEnv(t, covListPopulated)

	prevOpen := openBrowser
	openBrowser = func(string) error {
		t.Error("a dismissed picker must not reach the browser")
		return nil
	}
	t.Cleanup(func() { openBrowser = prevOpen })

	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return errBoom }
	t.Cleanup(func() { runHuhForm = prev })

	// `activity` is not here: it asks nothing before printing, and its one question — more rows,
	// after a full page — is dismissed in TestTailForms_ActivityMorePropagatesADismissal.
	for _, args := range [][]string{
		{"repo", "list"},
		{"classification", "show"},
		// `open` asks only when the reference misses, so the dismissal needs a miss to reach.
		{"open", "--project", "botique"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 1 {
				t.Errorf("exit code = %d, want 1 — a dismissed form must stop the command", got)
			}
		})
	}
}

// TestTailForms_ClassificationShowPropagatesEachDismissal covers the three separate forms `show`
// can open, because each returns through its own arm and a shared assertion would leave two of
// them dark.
func TestTailForms_ClassificationShowPropagatesEachDismissal(t *testing.T) {
	for _, tc := range []struct {
		name string
		dims []api.ClassificationDimension
		args []string
	}{
		{"the kind select", tailFormsKindDims(), nil},
		{"the typed kind", []api.ClassificationDimension{{Key: "owner"}}, nil},
		{"the id input", tailFormsKindDims(), []string{"cluster"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tailFormsTTY(t)
			prev := runHuhForm
			runHuhForm = func(...*huh.Group) error { return errBoom }
			t.Cleanup(func() { runHuhForm = prev })

			if _, _, err := resolveClassificationTarget(&fakeClient{classDims: tc.dims}, tc.args); err == nil {
				t.Fatalf("%s: a dismissed form must not read as an answer", tc.name)
			}
		})
	}
}
