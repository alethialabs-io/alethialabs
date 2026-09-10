// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// THE VOCABULARY IS FETCHED, NOT TYPED (#4332).
//
// Two literals used to live here — `componentKinds` and `singletonKinds` — described as a "cache"
// of the server registry. They had already drifted: the published document carries 14 kinds and the
// literal carried 13, so `alethia project component kinds`, the command whose entire job is to name
// the kinds, omitted `helm_registries`, and the interactive picker could not offer it. The only way
// to author one was to know the string.
//
// They are DELETED rather than kept as a fallback, which was the open decision on #4332. A fallback
// that quietly served a stale list is the same defect as the drift, one level down: it would answer
// confidently and wrongly, and nothing would say which list had been used. `GET /api/cli/schema/components`
// (#3671) is the one source, `apply` and `plan` already validate against it, and this makes the third
// depth agree with the other two.
//
// WHAT REPLACES THEM, and why it is not simply "fetch everywhere":
//
//   - An INTERACTIVE path needs the document. A picker cannot offer options it does not know, and
//     cardinality is what decides whether a name is required — guessing it authors the wrong thing.
//     So those paths fail with the fetch error rather than degrading.
//   - A HEADLESS path treats it as ADVISORY, exactly as the deleted literal was. The CLI's checks
//     may only ever refuse what the server would certainly refuse (CLAUDE.md §5), so a fetch that
//     fails there prints one line to stderr and lets the server decide. That is a visible
//     degradation, not a silent stale answer.

// componentVocabulary is the published component registry, resolved once per command run.
//
// A value type over a possibly-nil document: `known` and `isSingleton` answer false for an
// unresolved vocabulary, which is the same answer the deleted literal gave for a kind it had never
// heard of — so every "the server decides" branch below keeps its meaning with no new nil checks.
type componentVocabulary struct {
	doc *api.ComponentSchemaDocument
}

// componentSchemaClient is the slice of the API this group needs. Narrow and file-local, the same
// shape as `applyClient` — it keeps the shared `apiClient` interface out of this change and lets the
// compiler name the one call the component group makes.
type componentSchemaClient interface {
	GetComponentSchema() (*api.ComponentSchemaDocument, error)
}

// fetchComponentVocabulary resolves the registry. The error is returned rather than swallowed; each
// caller decides whether its path can proceed without it.
func fetchComponentVocabulary(c componentSchemaClient) (componentVocabulary, error) {
	doc, err := c.GetComponentSchema()
	if err != nil {
		return componentVocabulary{}, err
	}
	return componentVocabulary{doc: doc}, nil
}

// advisoryComponentVocabulary resolves the registry for a headless path, where it is a hint and not
// a gate. A failure is REPORTED on stderr and the empty vocabulary returned, so the run continues
// with the server as the only authority. Never silent: the deleted literal's whole problem was that
// nothing said which list had answered.
func advisoryComponentVocabulary(c componentSchemaClient) componentVocabulary {
	v, err := fetchComponentVocabulary(c)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not read the component registry (%v) — kind and cardinality checks are skipped and the server decides\n", err)
	}
	return v
}

// kinds is every published kind, in the document's registry order.
func (v componentVocabulary) kinds() []string {
	if v.doc == nil {
		return nil
	}
	out := make([]string, 0, len(v.doc.Kinds))
	for _, k := range v.doc.Kinds {
		out = append(out, k.Kind)
	}
	return out
}

// known reports whether the published registry holds this kind. False for an unresolved vocabulary —
// an unknown kind is not a wrong one, and the server is what refuses.
func (v componentVocabulary) known(kind string) bool {
	_, ok := v.doc.Kind(kind)
	return ok
}

// isSingleton reports whether the kind is one per (project, environment) and takes no name. False
// for an unknown or unresolved kind, so a name is neither required nor stripped on a guess.
func (v componentVocabulary) isSingleton(kind string) bool {
	k, ok := v.doc.Kind(kind)
	return ok && k.Singleton
}

// first is the kind a picker starts on. Empty for an unresolved vocabulary, which the interactive
// callers have already refused before reaching here.
func (v componentVocabulary) first() string {
	if v.doc == nil || len(v.doc.Kinds) == 0 {
		return ""
	}
	return v.doc.Kinds[0].Kind
}

var projectComponentCmd = &cobra.Command{
	Use:     "component",
	Aliases: []string{"components", "comp"},
	Short:   "Manage a project's component resources",
	Long: `Components are the building blocks of a project's infrastructure: the network and
cluster, plus databases, caches, queues, topics, nosql tables, container registries, secrets,
storage buckets, DNS, and observability. One uniform group authors them all. The project is
named with --project (its name or id).`,
}

// --- kinds ---

var projectComponentKindsCmd = &cobra.Command{
	Use:   "kinds",
	Short: "List the supported component kinds",
	Run: func(cmd *cobra.Command, args []string) {
		// This command's whole job is to name what the SERVER accepts, so it needs a token and a
		// round-trip. It used to answer offline from a literal, which is how it came to omit a kind.
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runComponentKinds(api.NewClient(token), os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list kinds: %v", err)
		}
	},
}

var kindListColumns = []string{"Kind", "Cardinality"}

// kindRows projects the published registry into plain table rows, in its own order.
func kindRows(v componentVocabulary) [][]string {
	kinds := v.kinds()
	rows := make([][]string, len(kinds))
	for i, k := range kinds {
		cardinality := "multi"
		if v.isSingleton(k) {
			cardinality = "singleton"
		}
		rows[i] = []string{k, cardinality}
	}
	return rows
}

// runComponentKinds renders the kinds the server publishes.
//
// A fetch failure is returned, never degraded: an offline answer here is a GUESS about the server's
// vocabulary, and one that was wrong is why this unit exists.
func runComponentKinds(c componentSchemaClient, out io.Writer, format string) error {
	v, err := fetchComponentVocabulary(c)
	if err != nil {
		return err
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: kindListColumns,
		Rows:    kindRows(v),
	}, v.kinds())
}

// --- list ---

var componentListKind string

// currentComponentEnv reads the component group's persistent --env. Persistent so `list`, `add` and
// `remove` name an environment the same way; before this, `--env` existed on `list` alone and was
// documented "(reserved)" while the server dropped it, and the write paths had no way to say which
// environment they meant at all.
//
// Empty is meaningful and differs per verb, which the server decides: a write with no --env targets
// the project's DEFAULT environment (so existing single-environment scripts keep working), while a
// list with no --env shows EVERY environment rather than silently narrowing to one.
func currentComponentEnv(cmd *cobra.Command) string {
	env, err := cmd.Flags().GetString("env")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(env)
}

var projectComponentListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a project's components",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var comps []api.Component
			runSpinner("Fetching components...", func() {
				comps, err = client.ListComponents(project, componentListKind, currentComponentEnv(cmd))
			})
			if err != nil {
				failf("Failed to list components: %v", err)
			}
			if len(comps) == 0 {
				ui.Muted("No components found.")
				return
			}
			_ = ui.ShowTable(componentListColumns, componentRows(comps, ui.FormatTable), "components")
			return
		}
		if err := runComponentList(client, os.Stdout, outputFormat(cmd), project, componentListKind, currentComponentEnv(cmd)); err != nil {
			failf("Failed to list components: %v", err)
		}
	},
}

var componentListColumns = []string{"Kind", "Name", "Status", "Identity"}

// componentRows projects components into plain table rows; an inherited (nil) identity
// renders as the dash glyph.
func componentRows(comps []api.Component, outFmt string) [][]string {
	rows := make([][]string, len(comps))
	for i, c := range comps {
		identity := ui.Cell(outFmt, "", ui.SymbolDash)
		if c.CloudIdentityID != nil && *c.CloudIdentityID != "" {
			identity = *c.CloudIdentityID
		}
		status := c.Status
		if status == "" {
			status = ui.Cell(outFmt, "", ui.SymbolDash)
		}
		rows[i] = []string{c.Kind, c.Name, status, identity}
	}
	return rows
}

// runComponentList fetches and renders a project's components (non-interactive path).
func runComponentList(c apiClient, out io.Writer, format, project, kind, env string) error {
	comps, err := c.ListComponents(project, kind, env)
	if err != nil {
		return err
	}
	if len(comps) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No components found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: componentListColumns,
		Rows:    componentRows(comps, format),
	}, comps)
}

// --- add ---

var (
	componentAddKind string
	componentAddName string
	componentAddSet  []string
)

var projectComponentAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Add a component to a project",
	Long: `Add a component of --kind to a project. Set its fields with repeatable --set
key=value pairs (validated server-side against the component's schema). Singletons
(network, cluster, dns, observability, repositories) ignore --name; multi kinds require it.

Values are parsed as JSON when possible, else taken literally:
  --set port=5432            (number)
  --set iam_auth=true        (boolean)
  --set instance_types='["t3.medium"]'  (array)
  --set engine=postgres      (string)`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		kind, name, sets := componentAddKind, componentAddName, componentAddSet
		env := currentComponentEnv(cmd)

		// The interactive path this command never had. The tutorial calls it three times
		// with hand-typed `--set k=v` pairs and a hand-typed --env, and there was no
		// terminal path at all — flag-or-nothing for the one command that authors a
		// project's actual infrastructure.
		asked := false
		client := api.NewClient(token)
		if promptsEnabled() && (kind == "" || len(sets) == 0) {
			// INTERACTIVE: the document is REQUIRED. A picker cannot offer kinds it does not know,
			// and cardinality is what decides whether the second form asks for a name — a guess
			// there authors the wrong shape. So a fetch failure fails the command with its cause.
			v, vErr := fetchComponentVocabulary(client)
			if vErr != nil {
				failf("Could not read the component registry: %v", vErr)
			}
			answers, err := promptComponentAdd(client, v, project, componentAddSpec{
				Kind: kind, Name: name, Env: env, Sets: sets,
			})
			if err != nil {
				fail(err)
			}
			kind, name, env, sets = answers.Kind, answers.Name, answers.Env, answers.Sets
			asked = true
		}

		fields, err := parseSetValues(sets)
		if err != nil {
			fail(err)
		}
		if err := runComponentAdd(api.NewClient(token), os.Stdout, project, kind, name, env, fields); err != nil {
			failf("Failed to add component: %v", err)
		}
		printReplay(os.Stdout, outputFormat(cmd), asked, componentAddReplayArgs(project, componentAddSpec{
			Kind: kind, Name: name, Env: env, Sets: sets,
		})...)
	},
}

// componentAddSpec is one `component add` as the flags and the form both express it. The two
// are the same four fields in the same order, which is what lets componentAddReplayArgs turn
// an answered form back into the command that would repeat it.
type componentAddSpec struct {
	Kind string
	Name string
	Env  string
	Sets []string
}

// componentKindOptions builds the kind picker, annotating each with its cardinality so the
// answer to "does this one need a name" is on screen at the moment it is asked. A seed that
// the cached list does not hold is offered verbatim, as its last option.
//
// Built from the PUBLISHED registry since #4332 — `GET /api/cli/schema/components` (#3671), read
// through `GetComponentSchema`. It used to be built from a hand-typed cache that had already
// drifted, so `helm_registries` was offered by no picker at all. The seed branch below is what kept
// that kind reachable and is kept for the case it was written for: a kind newer than the document
// this run fetched.
//
// The seed option is what makes that last sentence TRUE on a terminal. huh binds a Select to
// its first option when the bound value matches no option's value — it writes options[0].Value
// back through the pointer — so `--kind helm_registries` fed into a picker of cached kinds
// alone came back as `network`, and the run authored a different component entirely.
func componentKindOptions(v componentVocabulary, seed string) []huh.Option[string] {
	kinds := v.kinds()
	if seed != "" && !v.known(seed) {
		kinds = append(append([]string{}, kinds...), seed)
	}
	opts := make([]huh.Option[string], len(kinds))
	for i, k := range kinds {
		label := k + " (multi — needs a name)"
		switch {
		case v.isSingleton(k):
			label = k + " (singleton — one per environment)"
		case !v.known(k):
			label = k + " (passed with --kind — the server decides)"
		}
		opts[i] = huh.NewOption(label, k)
	}
	return opts
}

// promptComponentAdd asks for the kind, the name, the environment and the field assignments,
// seeded from whatever flags were already passed.
//
// The environment is a PICKER over the project's real environments rather than a text box.
// `--env` is a lookup key — authoring a component into the wrong tier is silent, and the next
// thing that reads it is a deploy — so offering the names that exist beats accepting a typo
// that the server resolves to the default environment.
func promptComponentAdd(c apiClient, v componentVocabulary, project string, seed componentAddSpec) (componentAddSpec, error) {
	if err := requireInteractiveForm(); err != nil {
		return seed, err
	}
	out := seed
	if out.Kind == "" {
		out.Kind = v.first()
	}

	groups := []*huh.Group{huh.NewGroup(
		huh.NewSelect[string]().
			Title("Component kind").
			Description("What to author into this project").
			Options(componentKindOptions(v, out.Kind)...).
			Value(&out.Kind),
	)}
	if err := runHuhForm(groups...); err != nil {
		return seed, err
	}
	out.Kind = strings.TrimSpace(out.Kind)

	// Asked in a SECOND form on purpose: whether a name is needed depends on the kind, and
	// huh decides which fields to show when a form is built. One form would have to decide
	// that from the seed rather than the answer.
	second := []huh.Field{}
	if !v.isSingleton(out.Kind) {
		second = append(second, huh.NewInput().
			Title("Component name").
			Description("Required for a multi kind, e.g. main, sessions").
			Value(&out.Name))
	}
	// Best-effort: a failed list falls back to a free-text box, because refusing to author a
	// component because the environment LIST could not be read would be a worse answer than
	// accepting a name the server will resolve anyway.
	if envs, listErr := c.ListEnvironments(project); listErr == nil && len(envs) > 0 {
		out.Env = componentEnvSeedValue(envs, out.Env)
		second = append(second, huh.NewSelect[string]().
			Title("Environment").
			Description("Which tier this component belongs to").
			Options(componentEnvOptions(envs, out.Env)...).
			Value(&out.Env))
	} else {
		second = append(second, huh.NewInput().
			Title("Environment").
			Description("Name, stage or id — blank for the project's default environment").
			Value(&out.Env))
	}
	if err := runHuhForm(huh.NewGroup(second...)); err != nil {
		return seed, err
	}
	out.Name = strings.TrimSpace(out.Name)
	out.Env = strings.TrimSpace(out.Env)
	if v.isSingleton(out.Kind) {
		// A singleton upserts the project's single row and the server ignores the name, so
		// carrying a seeded one through would put it in the replay line as though it did
		// something.
		out.Name = ""
	}
	// Only a kind the cache KNOWS is multi is refused here. An unknown kind's cardinality is
	// the server registry's answer, not this list's, so a blank name is sent and the server
	// decides rather than the CLI refusing a component it has merely not heard of.
	if v.known(out.Kind) && !v.isSingleton(out.Kind) && out.Name == "" {
		return out, fmt.Errorf("%s is a multi kind and needs a name", out.Kind)
	}

	sets, err := promptSetValues(out.Sets)
	if err != nil {
		return out, err
	}
	out.Sets = sets
	return out, nil
}

// componentEnvOptions offers the project's real environments, default first in the list the
// server returned, preceded by the empty value that means "the project's default environment".
//
// A seed none of those values expresses is appended verbatim, and that is load-bearing: huh
// binds a Select to its FIRST option when the bound value matches no option's value, and this
// picker's first option is the DEFAULT environment. `--env production` (a stage) or
// `--env <env-id>` — both of which the flag documents — would otherwise be discarded without a
// word and the component authored into the default tier, which is the exact silent
// mis-targeting the picker exists to prevent.
func componentEnvOptions(envs []api.Environment, seed string) []huh.Option[string] {
	opts := make([]huh.Option[string], 0, len(envs)+2)
	opts = append(opts, huh.NewOption("(the project's default environment)", ""))
	for _, e := range envs {
		label := fmt.Sprintf("%s (%s)", e.Name, e.Stage)
		if e.IsDefault {
			label += ui.DefaultBadge()
		}
		opts = append(opts, huh.NewOption(label, e.Name))
	}
	if seed != "" {
		known := false
		for _, o := range opts {
			if o.Value == seed {
				known = true
				break
			}
		}
		if !known {
			opts = append(opts, huh.NewOption(seed+" (as passed to --env)", seed))
		}
	}
	return opts
}

// componentEnvSeedValue maps whatever --env carried — an environment's id, name or stage, all
// three of which the flag documents — onto the picker option that names the same environment.
// A seed it cannot place comes back unchanged, for componentEnvOptions to offer verbatim.
//
// A stage is matched only when ONE environment carries it: two environments can share a stage,
// and picking either of them would be this function inventing the answer the server resolves.
func componentEnvSeedValue(envs []api.Environment, seed string) string {
	if seed == "" {
		return ""
	}
	for _, e := range envs {
		if e.Name == seed {
			return e.Name
		}
	}
	for _, e := range envs {
		if e.ID == seed {
			return e.Name
		}
	}
	match, matches := "", 0
	for _, e := range envs {
		if e.Stage == seed {
			match, matches = e.Name, matches+1
		}
	}
	if matches == 1 {
		return match
	}
	return seed
}

// promptSetValues asks for `key=value` assignments one at a time, appending to whatever was
// already passed with --set, and returns them in --set syntax so the SAME parser handles the
// answered and the typed forms.
//
// Generic key/value rather than a form built per kind, deliberately. The fields a kind accepts
// are published by the server (#3671, GET /api/cli/schema/components) precisely so the CLI
// stops holding a second opinion of them; a hand-written field list here would be that second
// opinion, and it would drift the way componentKinds already has. The typed form arrives when
// a Go client for that document does.
func promptSetValues(seed []string) ([]string, error) {
	out := append([]string{}, seed...)
	for {
		title := "Set a field?"
		if len(out) > 0 {
			title = "Set another field?"
		}
		more, err := askYesNo(title, setsSoFar(out))
		if err != nil {
			return nil, err
		}
		if !more {
			return out, nil
		}
		key, value, err := askKeyValue()
		if err != nil {
			return nil, err
		}
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, fmt.Errorf("a field needs a name")
		}
		out = append(out, key+"="+value)
	}
}

// askKeyValue is the one-field question as a seam, so promptSetValues' loop is testable. See
// the question seams in project.go.
var askKeyValue = func() (string, string, error) {
	var key, value string
	if err := runHuhForm(huh.NewGroup(
		huh.NewInput().Title("Field").Description("e.g. engine, port, instance_types").Value(&key),
		huh.NewInput().Title("Value").Description(`JSON when it parses, else literal text — 5432, true, ["t3.medium"], postgres`).Value(&value),
	)); err != nil {
		return "", "", err
	}
	return key, value, nil
}

// setsSoFar renders the assignments collected so far for the loop's prompt, so the answer to
// "have I already set engine" does not require scrolling back.
func setsSoFar(sets []string) string {
	if len(sets) == 0 {
		return "Nothing set yet — the server validates each field against the kind's schema"
	}
	return "So far: " + strings.Join(sets, "  ")
}

// componentAddReplayArgs renders the `project component add` that would repeat this result.
func componentAddReplayArgs(project string, spec componentAddSpec) []string {
	args := []string{"alethia", "project", "component", "add", "--project", project, "--kind", spec.Kind}
	if spec.Name != "" {
		args = append(args, "--name", spec.Name)
	}
	if spec.Env != "" {
		args = append(args, "--env", spec.Env)
	}
	for _, s := range spec.Sets {
		args = append(args, "--set", s)
	}
	return args
}

// parseSetValues parses repeatable `key=value` flags into a field map, coercing each value
// to its JSON type when it parses (number/bool/array/object/null), else keeping the literal.
func parseSetValues(sets []string) (map[string]interface{}, error) {
	out := map[string]interface{}{}
	for _, s := range sets {
		key, val, ok := strings.Cut(s, "=")
		if !ok || key == "" {
			return nil, fmt.Errorf("invalid --set %q (want key=value)", s)
		}
		out[key] = coerceSetValue(val)
	}
	return out, nil
}

// coerceSetValue returns the JSON-typed value of raw (string/number/bool/array/object/null),
// or the literal text when raw is not JSON at all.
//
// `case string` is load-bearing and was the one type missing. Quoting is the ONLY way to give a
// string field a value that also parses as a number — `--set cluster_version=1.35` coerces to the
// number 1.35 and the server refuses it ("expected string, received number"), so the documented
// answer is `--set 'cluster_version="1.35"'`. Without this arm that quoted form decoded to a Go
// string, failed the switch, and fell through to `return raw` — storing SIX characters, quote
// marks and all. Both halves of the documented workaround were then wrong: unquoted was refused,
// quoted was silently corrupted, and the corruption only surfaced much later as a compatibility
// gate reporting the Kubernetes version "unset or unparseable".
//
// Non-JSON text is unaffected: `--set engine=postgres` fails json.Unmarshal and returns raw.
func coerceSetValue(raw string) interface{} {
	var v interface{}
	if err := json.Unmarshal([]byte(raw), &v); err == nil {
		switch v.(type) {
		case string, float64, bool, []interface{}, map[string]interface{}, nil:
			return v
		}
	}
	return raw
}

// runComponentAdd creates the component and confirms it. An empty env means the project's default
// environment, resolved server-side.
func runComponentAdd(c apiClient, out io.Writer, project, kind, name, env string, fields map[string]interface{}) error {
	if kind == "" {
		return fmt.Errorf("--kind is required (see `alethia project component kinds`)")
	}
	comp, err := c.AddComponent(project, kind, name, env, fields)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Added %s component %s (%s)%s", comp.Kind, comp.Name, comp.ID, envSuffix(env))))
	return nil
}

// envSuffix renders " in <env>" for a confirmation line, or nothing when no environment was named.
// The environment belongs in the confirmation because it is the thing a caller most needs to see they
// got right: authoring the same kind into the wrong tier is silent, and the next thing that reads it
// is a deploy.
func envSuffix(env string) string {
	if env == "" {
		return ""
	}
	return " in " + env
}

// --- remove ---

var (
	componentRemoveKind string
	componentRemoveName string
)

// componentRemoveYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var componentRemoveYes bool

var projectComponentRemoveCmd = &cobra.Command{
	Use:   "remove",
	Short: "Remove a component from a project",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		env := currentComponentEnv(cmd)
		kind, name := componentRemoveKind, componentRemoveName
		// ADVISORY, and fetched UNCONDITIONALLY on this verb — which is the opposite of what
		// `apply` does, deliberately.
		//
		// `apply` gates the fetch on the manifest declaring components, because the document is
		// ~1100 lines and it has nothing to check otherwise. Here the registry is consulted on
		// EVERY path, not only the picker: `removalDescription` asks `isSingleton` to decide whether
		// to name the component, and a confirmation that says "network main" for a kind that has no
		// name describes something that does not exist. One small GET to make a DESTRUCTIVE
		// prompt accurate is the right trade.
		//
		// Advisory rather than required, because a read failure must not block a removal the caller
		// has fully specified — the server refuses a nameless multi kind on its own. It warns on
		// stderr and continues; the one path that cannot continue is the picker, which refuses
		// below.
		v := advisoryComponentVocabulary(client)
		if kind == "" && promptsEnabled() {
			// Asked BEFORE the confirmation, never after: the confirmation's whole job is to
			// name what is about to go, and a prompt that asked "remove this component?" and
			// only then asked which one would be a confirmation of nothing.
			if v.doc == nil {
				failf("Could not read the component registry, so there is nothing to offer — pass --kind (see `alethia project component kinds`)")
			}
			picked, err := promptComponentKind(v)
			if err != nil {
				fail(err)
			}
			kind = picked
		}
		if kind == "" {
			failf("--kind is required (see `alethia project component kinds`)")
		}
		// A multi kind is deleted BY NAME — the server refuses a nameless one with
		// "<kind> components are removed by name (pass --name)" — so the name is asked for
		// here. Without it the interactive path dead-ended for the 8 multi kinds: it confirmed
		// a destructive prompt naming a whole KIND and then failed on the request.
		//
		// Only a kind the PUBLISHED registry says is multi is held to this. An unknown kind — or a
		// registry this run could not read — leaves the cardinality to the server, which is the
		// same answer the deleted literal gave for a kind it had not heard of.
		if name == "" && v.known(kind) && !v.isSingleton(kind) {
			if promptsEnabled() {
				if name, err = promptComponentName(client, project, kind, env); err != nil {
					fail(err)
				}
			}
			if name == "" {
				failf("%s is a multi kind and needs a name — pass --name (see `alethia project component list --kind %s`)", kind, kind)
			}
		}
		if !confirmDestructive(componentRemoveYes, "Remove this component?", removalDescription(v, kind, name, env)) {
			return
		}
		if err := runComponentRemove(client, v, os.Stdout, project, kind, name, env); err != nil {
			failf("Failed to remove component: %v", err)
		}
	},
}

// promptComponentKind asks which kind to act on. Only reached with no --kind, so there is no
// seed to keep on the list.
func promptComponentKind(v componentVocabulary) (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	kind := v.first()
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Component kind").
			Description("Which kind to remove").
			Options(componentKindOptions(v, "")...).
			Value(&kind),
	)); err != nil {
		return "", err
	}
	return strings.TrimSpace(kind), nil
}

// promptComponentName asks WHICH component of a multi kind to remove, as a picker over the
// ones that exist so the confirmation that follows has a real object to name.
//
// The list is best-effort and falls back to a free-text box: a failed READ is not a reason a
// delete cannot be typed. The listing is the kind's components in the named environment — with
// no --env it spans every environment, matching what `component list` shows, while the delete
// itself is scoped to the default environment, which is what the confirmation says.
func promptComponentName(c apiClient, project, kind, env string) (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	var name string
	if opts := componentNameOptions(c, project, kind, env); len(opts) > 0 {
		name = opts[0].Value
		if err := runHuhForm(huh.NewGroup(
			huh.NewSelect[string]().
				Title("Which " + kind + " component").
				Description("The one to remove" + envSuffix(env)).
				Options(opts...).
				Value(&name),
		)); err != nil {
			return "", err
		}
		return strings.TrimSpace(name), nil
	}
	if err := runHuhForm(huh.NewGroup(
		huh.NewInput().
			Title("Component name").
			Description("Which " + kind + " component to remove").
			Value(&name),
	)); err != nil {
		return "", err
	}
	return strings.TrimSpace(name), nil
}

// componentNameOptions offers the named components of one kind, deduplicated by name: the same
// component name exists in every environment that holds one, and two identical options would
// ask the reader to choose between them. An empty slice means "ask for the name instead".
func componentNameOptions(c apiClient, project, kind, env string) []huh.Option[string] {
	comps, err := c.ListComponents(project, kind, env)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	opts := make([]huh.Option[string], 0, len(comps))
	for _, comp := range comps {
		if comp.Name == "" || seen[comp.Name] {
			continue
		}
		seen[comp.Name] = true
		label := comp.Name
		if comp.Status != "" {
			label = fmt.Sprintf("%s (%s)", comp.Name, comp.Status)
		}
		opts = append(opts, huh.NewOption(label, comp.Name))
	}
	return opts
}

// removalDescription names WHAT is about to be removed and from WHICH tier, rather than
// describing removal in general.
//
// A confirmation that does not name its object cannot be read as anything but "yes". The
// tier is the load-bearing half: `remove` deletes from one environment, a sibling tier keeps
// its copy, and the default environment is what an omitted --env means — so the prompt says
// which one rather than leaving the reader to remember the rule.
func removalDescription(v componentVocabulary, kind, name, env string) string {
	what := kind
	if name != "" && !v.isSingleton(kind) {
		what = kind + " " + name
	}
	where := "the project's default environment"
	if env != "" {
		where = env
	}
	return fmt.Sprintf(
		"Deletes the %s configuration in %s. Other environments keep theirs; provisioned resources go on the next apply/destroy.",
		what, where)
}

// runComponentRemove deletes the component and confirms it. Singleton kinds ignore the name. An empty
// env means the project's default environment; the delete is scoped to that ONE environment either
// way, so a sibling tier's row is never collateral.
func runComponentRemove(c apiClient, v componentVocabulary, out io.Writer, project, kind, name, env string) error {
	if v.isSingleton(kind) {
		name = ""
	}
	if err := c.RemoveComponent(project, kind, name, env); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Component removed"+envSuffix(env)))
	return nil
}

func init() {
	addYesFlag(projectComponentRemoveCmd, &componentRemoveYes)
	projectComponentCmd.PersistentFlags().String("project", "", "Project name or id")
	// PERSISTENT, so add/remove can name an environment too. It used to exist on `list` alone,
	// labelled "(reserved)", and the server discarded it — so the CLI could only ever author into
	// the default environment, which made a two-tier project (dev and staging pointing at different
	// overlays) impossible to build from the terminal.
	projectComponentCmd.PersistentFlags().String("env", "", "Environment id, name or stage — writes default to the project's default environment, `list` defaults to all")

	projectComponentListCmd.Flags().StringVar(&componentListKind, "kind", "", "Filter by component kind")

	projectComponentAddCmd.Flags().StringVar(&componentAddKind, "kind", "", "Component kind (required)")
	projectComponentAddCmd.Flags().StringVar(&componentAddName, "name", "", "Component name (multi kinds)")
	projectComponentAddCmd.Flags().StringArrayVar(&componentAddSet, "set", nil, "Field assignment key=value (repeatable)")

	projectComponentRemoveCmd.Flags().StringVar(&componentRemoveKind, "kind", "", "Component kind (required)")
	projectComponentRemoveCmd.Flags().StringVar(&componentRemoveName, "name", "", "Component name (multi kinds)")

	projectComponentCmd.AddCommand(projectComponentKindsCmd)
	projectComponentCmd.AddCommand(projectComponentListCmd)
	projectComponentCmd.AddCommand(projectComponentAddCmd)
	projectComponentCmd.AddCommand(projectComponentRemoveCmd)
	projectCmd.AddCommand(projectComponentCmd)
}
