// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// The clouds family, held to the contract every command of the CLI is being moved to: the result
// on stdout and nothing else there, every failure on stderr with the exit code its class owns, and
// no hidden cloud named anywhere a person reads.
//
// The tests drive the real cobra tree against the fake control plane of cov_connectors_test.go, and
// read the process's two streams through pipes. A stream is read as the FILE the command writes
// to, because that is what a shell redirects.

// cloudsTestPrinter builds a Printer over two buffers, for a test that calls a run function
// directly.
func cloudsTestPrinter(format string) (*Printer, *bytes.Buffer, *bytes.Buffer) {
	var out, errOut bytes.Buffer
	return &Printer{Out: &out, Err: &errOut, Format: format, Mode: Mode{Color: true}}, &out, &errOut
}

// cloudsRun is one invocation of the tree with both streams captured.
type cloudsRun struct {
	stdout, stderr string
	exited         bool
	code           int
}

// cloudsInvoke runs the tree with the registry applied, and returns what it wrote and how it
// ended.
func cloudsInvoke(t *testing.T, run func(args ...string) error, args ...string) cloudsRun {
	t.Helper()
	applyCommandMeta()
	cloudsResetLateFlags()
	t.Cleanup(cloudsResetLateFlags)

	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prevOut, prevErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outW, errW
	drain := func(r *os.File) chan string {
		done := make(chan string, 1)
		go func() {
			b, _ := io.ReadAll(r)
			done <- string(b)
		}()
		return done
	}
	outDone, errDone := drain(outR), drain(errR)

	var result cloudsRun
	var runErr error
	result.exited, result.code, runErr = connInvoke(t, run, args...)

	os.Stdout, os.Stderr = prevOut, prevErr
	_ = outW.Close()
	_ = errW.Close()
	result.stdout, result.stderr = <-outDone, <-errDone
	if runErr != nil {
		t.Fatalf("%v: cobra refused the command line: %v", args, runErr)
	}
	return result
}

// cloudsResetLateFlags clears --dry-run and --help on every command of the family.
//
// Neither is covered by the suite's flag reset, which records the tree before the first test: the
// registry adds --dry-run when it is applied and cobra adds --help when a command first runs. A
// value left set by one invocation would turn the next one into a dry run, or into a help page.
func cloudsResetLateFlags() {
	for _, family := range []*cobra.Command{connectorCmd, providerCmd, cloudCmd} {
		for _, cmd := range append([]*cobra.Command{family}, family.Commands()...) {
			for _, name := range []string{"dry-run", "help"} {
				if flag := cmd.Flags().Lookup(name); flag != nil {
					_ = flag.Value.Set("false")
					flag.Changed = false
				}
			}
		}
	}
}

// cloudsOffer sets which hidden clouds the operator re-enabled for the rest of the test, and
// re-applies everything that reads the offered set, now and when the test ends.
func cloudsOffer(t *testing.T, hidden string) {
	t.Helper()
	t.Setenv(catalog.HiddenCloudsEnv, hidden)
	applyCommandMeta()
	applyCloudHelp()
}

// cloudsRestoreHelp puts the tree's help back to the default offered set when the test ends. It is
// registered before the first cloudsOffer, so it runs after the environment is restored.
func cloudsRestoreHelp(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		applyCommandMeta()
		applyCloudHelp()
	})
}

// hiddenCloudNames returns every spelling of every cloud the catalog hides: the slug, the short
// name and the full name. A short name of fewer than four letters is left out, because it is not
// a word a search can find without finding everything else.
func hiddenCloudNames(t *testing.T) []string {
	t.Helper()
	c := catalog.MustLoad()
	var names []string
	for _, cloud := range c.Live.Providers {
		if cloud.Availability != catalog.AvailabilityHidden {
			continue
		}
		names = append(names, cloud.Slug)
		if len(cloud.ShortName) >= 4 {
			names = append(names, cloud.ShortName)
		}
		if meta, ok := c.Provider(cloud.Slug); ok {
			names = append(names, meta.Name)
		}
	}
	if !cloudsContainsFold(names, "alibaba") || len(names) < 3 {
		t.Fatalf("the catalog hides %v: the search below would run against too little to mean anything", names)
	}
	return names
}

// cloudsContainsFold reports whether any item equals want, ignoring case.
func cloudsContainsFold(items []string, want string) bool {
	for _, item := range items {
		if strings.EqualFold(item, want) {
			return true
		}
	}
	return false
}

// helpTexts returns every text a person can read about one command: what `--help` prints, and the
// fields it is built from, so a string cobra happens not to print today is still read.
func helpTexts(t *testing.T, cmd *cobra.Command) []string {
	t.Helper()
	texts := []string{helpOf(t, cmd), cmd.Use, cmd.Short, cmd.Long, cmd.Example}
	cmd.Flags().VisitAll(func(f *pflag.Flag) { texts = append(texts, f.Usage) })
	return texts
}

// listedCommands returns root and every command below it that help lists.
func listedCommands(root *cobra.Command) []*cobra.Command {
	out := []*cobra.Command{root}
	for _, child := range root.Commands() {
		if child.Hidden {
			continue
		}
		out = append(out, listedCommands(child)...)
	}
	return out
}

// TestCloudsFamily_HelpNamesOnlyOfferedClouds is the tree walk: with nothing re-enabled, no help
// text of the family and no line of the root's help carries any spelling of a hidden cloud; with
// the cloud re-enabled, it is back.
func TestCloudsFamily_HelpNamesOnlyOfferedClouds(t *testing.T) {
	cloudsRestoreHelp(t)
	hidden := hiddenCloudNames(t)

	cloudsOffer(t, "")
	var commands []*cobra.Command
	for _, family := range []*cobra.Command{connectorCmd, providerCmd, cloudCmd} {
		commands = append(commands, listedCommands(family)...)
	}
	if len(commands) < 12 {
		t.Fatalf("the walk reached %d commands of the family, want at least 12", len(commands))
	}
	// The root is read for its own help, which is where every family's one-line description is
	// printed.
	commands = append(commands, rootCmd)

	var offenders []string
	for _, cmd := range commands {
		for _, text := range helpTexts(t, cmd) {
			for _, name := range hidden {
				if strings.Contains(strings.ToLower(text), strings.ToLower(name)) {
					offenders = append(offenders, cmd.CommandPath()+": "+name)
				}
			}
		}
	}
	sort.Strings(offenders)
	if len(offenders) > 0 {
		t.Errorf("help names a cloud that is not offered:\n%s", strings.Join(offenders, "\n"))
	}
	if got := helpOf(t, connectorCmd); !strings.Contains(got, "AWS, GCP, Azure and Hetzner") {
		t.Errorf("`connector --help` does not name the four offered clouds:\n%s", got)
	}

	cloudsOffer(t, "alibaba")
	help := helpOf(t, connectorCmd)
	for _, want := range []string{"AWS, GCP, Azure, Alibaba and Hetzner", "\n  alibaba ", "Alibaba RAM role"} {
		if !strings.Contains(help, want) {
			t.Errorf("`connector --help` with the cloud re-enabled is missing %q:\n%s", want, help)
		}
	}
	if got := helpOf(t, connectorAlibabaCmd); !strings.Contains(got, "Connect an Alibaba Cloud account") {
		t.Errorf("the re-enabled connector has no help:\n%s", got)
	}
	for _, cmd := range []*cobra.Command{connectorRemoveCmd, providerStatusCmd, providerVerifyCmd, cloudInventoryCmd} {
		if !strings.Contains(cmd.Long, "aws, gcp, azure, alibaba, hetzner") {
			t.Errorf("%q does not list the re-enabled cloud among the ones it takes:\n%s", cmd.CommandPath(), cmd.Long)
		}
	}
}

// TestCloudsFamily_EveryCommandSaysWhatItIsFor pins the help bar for the family: a one-line Short,
// a Long, and at least one example.
func TestCloudsFamily_EveryCommandSaysWhatItIsFor(t *testing.T) {
	cloudsRestoreHelp(t)
	cloudsOffer(t, "alibaba")

	for _, family := range []*cobra.Command{connectorCmd, providerCmd, cloudCmd} {
		for _, cmd := range listedCommands(family) {
			path := cmd.CommandPath()
			if cmd.Short == "" || strings.Contains(cmd.Short, "\n") {
				t.Errorf("%q: Short is %q, want one line", path, cmd.Short)
			}
			if len(cmd.Long) < len(cmd.Short) {
				t.Errorf("%q has no Long that says more than its Short", path)
			}
			if cmd.Runnable() && cmd.Example == "" {
				t.Errorf("%q is runnable and has no example", path)
			}
		}
	}
}

// TestCloudsFamily_CompletionFollowsTheOfferedSet pins the second place a command name is listed:
// what the shell offers after `alethia connector `.
func TestCloudsFamily_CompletionFollowsTheOfferedSet(t *testing.T) {
	cloudsRestoreHelp(t)
	run := connEnv(t, connFakeAPI{})
	// cobra adds its completion-request command to the root the first time one is asked for, and
	// leaves it there. It is taken out again so the tree the other tests read is the shipped one.
	t.Cleanup(func() {
		for _, cmd := range rootCmd.Commands() {
			if cmd.Name() == cobra.ShellCompRequestCmd {
				rootCmd.RemoveCommand(cmd)
			}
		}
	})

	cloudsOffer(t, "")
	got := cloudsInvoke(t, run, cobra.ShellCompRequestCmd, "connector", "")
	for _, offered := range []string{"aws", "gcp", "azure", "hetzner", "list", "remove"} {
		if !strings.Contains("\n"+got.stdout, "\n"+offered+"\t") {
			t.Errorf("completion does not offer %q:\n%s", offered, got.stdout)
		}
	}
	for _, name := range hiddenCloudNames(t) {
		if strings.Contains(strings.ToLower(got.stdout), strings.ToLower(name)) {
			t.Errorf("completion offers a cloud that is not offered (%s):\n%s", name, got.stdout)
		}
	}

	cloudsOffer(t, "alibaba")
	got = cloudsInvoke(t, run, cobra.ShellCompRequestCmd, "connector", "")
	if !strings.Contains("\n"+got.stdout, "\nalibaba\t") {
		t.Errorf("completion does not offer the re-enabled cloud:\n%s", got.stdout)
	}
}

// notOfferedSentence is the refusal, word for word as the control plane writes it.
const notOfferedSentence = "Alibaba Cloud is not available in this release."

// TestCloudsFamily_AHiddenCloudIsRefusedBeforeAnyRequest pins the refusal: one sentence on stderr,
// exit 8, nothing on stdout and nothing sent — for the command itself, its dry run and its help.
func TestCloudsFamily_AHiddenCloudIsRefusedBeforeAnyRequest(t *testing.T) {
	cloudsRestoreHelp(t)
	cloudsOffer(t, "")

	for name, args := range map[string][]string{
		"run":     {"connector", "alibaba", "--no-input", "--role-arn", "acs:ram::123456789012:role/AlethiaProvisioner"},
		"dry-run": {"connector", "alibaba", "--no-input", "--role-arn", "acs:ram::123456789012:role/AlethiaProvisioner", "--dry-run"},
		"help":    {"connector", "alibaba", "--help"},
	} {
		t.Run(name, func(t *testing.T) {
			rec := &connRecorder{}
			run := connEnv(t, connFakeAPI{rec: rec})
			got := cloudsInvoke(t, run, args...)
			if !got.exited || got.code != clierr.ExitUsage {
				t.Fatalf("exited=%v code=%d, want exit %d", got.exited, got.code, clierr.ExitUsage)
			}
			if !strings.Contains(got.stderr, notOfferedSentence) {
				t.Errorf("stderr does not carry the sentence:\n%s", got.stderr)
			}
			if got.stdout != "" {
				t.Errorf("a refusal wrote on stdout: %q", got.stdout)
			}
			if len(rec.paths) != 0 {
				t.Errorf("a refused command sent %v", rec.paths)
			}
		})
	}

	t.Run("json", func(t *testing.T) {
		run := connEnv(t, connFakeAPI{})
		got := cloudsInvoke(t, run, "connector", "alibaba", "--no-input", "--output", "json")
		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
				Exit    int    `json:"exit_code"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(lastLine(got.stderr)), &envelope); err != nil {
			t.Fatalf("stderr does not end in an error object: %v\n%s", err, got.stderr)
		}
		if envelope.Error.Code != clierr.CodeValidationFailed || envelope.Error.Message != notOfferedSentence ||
			envelope.Error.Exit != clierr.ExitUsage {
			t.Errorf("envelope = %+v", envelope)
		}
		if got.code != clierr.ExitUsage || got.stdout != "" {
			t.Errorf("code=%d stdout=%q", got.code, got.stdout)
		}
	})
}

// lastLine returns the last non-empty line of s.
func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

// TestCloudsFamily_AReEnabledCloudConnects pins the other half of the switch: with the operator's
// override the same command line runs, and the control plane is asked.
func TestCloudsFamily_AReEnabledCloudConnects(t *testing.T) {
	cloudsRestoreHelp(t)
	cloudsOffer(t, "alibaba")
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{rec: rec})

	got := cloudsInvoke(t, run, "connector", "alibaba", "--no-input", "--output", "json",
		"--role-arn", "acs:ram::123456789012:role/AlethiaProvisioner")
	if got.exited {
		t.Fatalf("exit %d:\n%s", got.code, got.stderr)
	}
	if !rec.saw("/providers/alibaba/init") || !rec.saw("/providers/alibaba/connect") {
		t.Errorf("the re-enabled connector sent %v", rec.paths)
	}
	result := decodeMutation(t, got.stdout)
	if result.Action != "created" || result.Object["provider"] != "alibaba" {
		t.Errorf("result = %+v", result)
	}
}

// TestCloudsFamily_AHiddenCloudWithNoAccountIsRefusedByTheReadCommands pins what a hidden cloud's
// name gets from the commands that only read or remove: the same sentence, never a pointer to a
// command the help does not list.
func TestCloudsFamily_AHiddenCloudWithNoAccountIsRefusedByTheReadCommands(t *testing.T) {
	cloudsRestoreHelp(t)
	cloudsOffer(t, "")

	for _, args := range [][]string{
		{"cloud", "inventory", "alibaba"},
		{"connector", "remove", "alibaba", "--yes"},
		{"connector", "remove", "alibaba", "--dry-run"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			run := connEnv(t, connFakeAPI{})
			got := cloudsInvoke(t, run, append(args, "--no-input")...)
			if !got.exited || got.code != clierr.ExitUsage {
				t.Fatalf("exited=%v code=%d, want exit %d\n%s", got.exited, got.code, clierr.ExitUsage, got.stderr)
			}
			if !strings.Contains(got.stderr, notOfferedSentence) || strings.Contains(got.stderr, "alethia connector alibaba") {
				t.Errorf("stderr = %q", got.stderr)
			}
			if got.stdout != "" {
				t.Errorf("a refusal wrote on stdout: %q", got.stdout)
			}
		})
	}
}

// TestCloudsFamily_AnAccountOnAHiddenCloudStaysReachable pins that hiding a cloud takes nothing
// away from an account already connected on it: it is listed, read and removed by its cloud's
// name, as the control plane keeps answering for it.
func TestCloudsFamily_AnAccountOnAHiddenCloudStaysReachable(t *testing.T) {
	cloudsRestoreHelp(t)
	cloudsOffer(t, "")
	identities := []map[string]interface{}{
		{"id": "ci-ali", "provider": "alibaba", "label": "legacy", "created_at": "2026-01-01T00:00:00Z"},
	}

	var asked string
	run := connEnv(t, connFakeAPI{identities: identities, inventoryFor: func(id string) { asked = id }})
	if got := cloudsInvoke(t, run, "cloud", "inventory", "alibaba", "--no-input", "--output", "json"); got.exited {
		t.Fatalf("cloud inventory: exit %d\n%s", got.code, got.stderr)
	}
	if asked != "ci-ali" {
		t.Errorf("inventory was asked for %q, want the connected account", asked)
	}

	rec := &connRecorder{}
	run = connEnv(t, connFakeAPI{identities: identities, rec: rec})
	got := cloudsInvoke(t, run, "connector", "remove", "alibaba", "--yes", "--no-input", "--output", "json")
	if got.exited {
		t.Fatalf("connector remove: exit %d\n%s", got.code, got.stderr)
	}
	if !rec.saw("/providers/alibaba/disconnect") {
		t.Errorf("remove sent %v", rec.paths)
	}

	// The fake control plane answers every status as connected, so this is the connected arm.
	run = connEnv(t, connFakeAPI{identities: identities})
	if got := cloudsInvoke(t, run, "provider", "status", "alibaba", "--no-input", "--output", "json"); got.exited {
		t.Fatalf("provider status: exit %d\n%s", got.code, got.stderr)
	}
}

// TestCloudsFamily_ADisconnectedHiddenCloudIsRefusedByProvider pins the provider commands' answer
// for a hidden cloud nothing is connected on.
func TestCloudsFamily_ADisconnectedHiddenCloudIsRefusedByProvider(t *testing.T) {
	t.Setenv(catalog.HiddenCloudsEnv, "")
	c := &fakeClient{providerStat: &api.ProviderStatus{Connected: false}}
	for name, run := range map[string]func(*Printer) error{
		"status": func(p *Printer) error { return runProviderStatus(c, p, "alibaba") },
		"verify": func(p *Printer) error { return runProviderVerify(c, p, "alibaba") },
	} {
		t.Run(name, func(t *testing.T) {
			p, out, _ := cloudsTestPrinter("table")
			err := run(p)
			if err == nil || err.Error() != notOfferedSentence {
				t.Fatalf("err = %v, want the refusal", err)
			}
			if clierr.From(err).Exit != clierr.ExitUsage || out.Len() != 0 {
				t.Errorf("exit=%d stdout=%q", clierr.From(err).Exit, out.String())
			}
		})
	}

	// A cloud the catalog lists with no full name is refused in the control plane's fallback words.
	if got := cloudNotOfferedError("civo").Error(); got != "This cloud is not available in this release." {
		t.Errorf("a cloud with no full name is refused with %q", got)
	}
}

// mutation is a mutation result as a script reads it.
type mutation struct {
	ID     string                 `json:"id"`
	Kind   string                 `json:"kind"`
	Action string                 `json:"action"`
	Job    *json.RawMessage       `json:"job"`
	DryRun bool                   `json:"dry_run"`
	Object map[string]interface{} `json:"object"`
}

// decodeMutation parses stdout as exactly one mutation result with every key present.
func decodeMutation(t *testing.T, stdout string) mutation {
	t.Helper()
	var keys map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stdout), &keys); err != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%q", err, stdout)
	}
	for _, key := range []string{"id", "kind", "action", "job", "dry_run", "object"} {
		if _, ok := keys[key]; !ok {
			t.Errorf("the result has no %q key: %s", key, stdout)
		}
	}
	var m mutation
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if m.Kind != kindCloudIdentity {
		t.Errorf("kind = %q, want %q", m.Kind, kindCloudIdentity)
	}
	return m
}

// cloudsHetznerToken is a token of the length Hetzner issues.
var cloudsHetznerToken = strings.Repeat("h", 64)

// cloudsConnectCases are the four offered connectors in their flag-only form: the command line a
// script uses.
func cloudsConnectCases() map[string][]string {
	return map[string][]string{
		"aws":     {"connector", "aws", "--role-arn", "arn:aws:iam::123456789012:role/AlethiaProvisionerRole"},
		"gcp":     {"connector", "gcp", "--project", "demo-proj", "--wif-config", "-"},
		"azure":   {"connector", "azure", "--subscription", "sub-1", "--tenant-id", "t-1", "--client-id", "c-1"},
		"hetzner": {"connector", "hetzner", "--token", cloudsHetznerToken},
	}
}

// TestCloudsFamily_HetznerReadsItsTokenFromAPipe pins the form a script uses for the one
// connector that takes a secret: the token arrives on stdin and never on the command line.
func TestCloudsFamily_HetznerReadsItsTokenFromAPipe(t *testing.T) {
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{rec: rec})
	cloudsStdin(t, cloudsHetznerToken+"\n")
	got := cloudsInvoke(t, run, "connector", "hetzner", "--token-stdin", "--no-input", "--output", "json")
	if got.exited {
		t.Fatalf("exit %d:\n%s", got.code, got.stderr)
	}
	if result := decodeMutation(t, got.stdout); result.Object["provider"] != "hetzner" || result.Action != "created" {
		t.Errorf("result = %+v", result)
	}
	if strings.Contains(got.stdout+got.stderr, cloudsHetznerToken) {
		t.Error("the token was written back on a stream")
	}

	// A token that cannot be right is refused before the pending identity is opened.
	rec = &connRecorder{}
	run = connEnv(t, connFakeAPI{rec: rec})
	cloudsStdin(t, "short\n")
	got = cloudsInvoke(t, run, "connector", "hetzner", "--token-stdin", "--no-input")
	if !got.exited || got.code != clierr.ExitUsage || len(rec.paths) != 0 {
		t.Errorf("exited=%v code=%d sent=%v, want exit %d and nothing sent", got.exited, got.code, rec.paths, clierr.ExitUsage)
	}
}

// cloudsStdin replaces the process's stdin with the given text for the rest of the test.
func cloudsStdin(t *testing.T, text string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	if _, err := w.WriteString(text); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = w.Close()
	prev := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = prev
		_ = r.Close()
	})
}

// TestCloudsFamily_ConnectReturnsOneMutationResult pins the JSON form of every connector: stdout
// is exactly the result object, and the narration is on stderr.
func TestCloudsFamily_ConnectReturnsOneMutationResult(t *testing.T) {
	for provider, args := range cloudsConnectCases() {
		t.Run(provider, func(t *testing.T) {
			rec := &connRecorder{}
			run := connEnv(t, connFakeAPI{rec: rec})
			cloudsStdin(t, `{"type":"external_account"}`)
			got := cloudsInvoke(t, run, append(args, "--no-input", "--output", "json")...)
			if got.exited {
				t.Fatalf("exit %d:\n%s", got.code, got.stderr)
			}
			result := decodeMutation(t, got.stdout)
			if result.ID != "cid-1" || result.Action != "created" || result.DryRun || result.Job != nil {
				t.Errorf("result = %+v", result)
			}
			if result.Object["provider"] != provider || result.Object["status"] != "connected" || result.Object["verified"] != true {
				t.Errorf("object = %v", result.Object)
			}
			if _, ok := result.Object["missing_permissions"].([]interface{}); !ok {
				t.Errorf("missing_permissions is not a list: %v", result.Object)
			}
			if !strings.Contains(got.stderr, "Connection test") {
				t.Errorf("the stages are not narrated on stderr:\n%s", got.stderr)
			}
			if !rec.saw("/providers/" + provider + "/connect") {
				t.Errorf("sent %v", rec.paths)
			}
		})
	}
}

// TestCloudsFamily_ConnectSaysSoOnStdoutForAPerson pins the table form: the one success sentence
// is the result, and everything else is on stderr.
func TestCloudsFamily_ConnectSaysSoOnStdoutForAPerson(t *testing.T) {
	run := connEnv(t, connFakeAPI{connect: map[string]interface{}{
		"identity_id": "cid-1", "verified": true, "status": "degraded",
		"missing_permissions": []string{"ec2:CreateVpc"},
	}})
	got := cloudsInvoke(t, run, "connector", "aws", "--no-input",
		"--role-arn", "arn:aws:iam::123456789012:role/AlethiaProvisionerRole")
	if got.exited {
		t.Fatalf("exit %d:\n%s", got.code, got.stderr)
	}
	if strings.TrimSpace(got.stdout) != "✓ AWS account connected (role arn:aws:iam::123456789012:role/AlethiaProvisionerRole)" {
		t.Errorf("stdout = %q", got.stdout)
	}
	if !strings.Contains(got.stderr, "missing some provisioning permissions: ec2:CreateVpc") {
		t.Errorf("the warning is not on stderr:\n%s", got.stderr)
	}
}

// TestCloudsFamily_ConnectDryRunSendsNothing pins the client dry run of every connector: the
// plan is the result, and neither the control plane nor a cloud CLI is touched.
func TestCloudsFamily_ConnectDryRunSendsNothing(t *testing.T) {
	for provider, args := range cloudsConnectCases() {
		t.Run(provider, func(t *testing.T) {
			rec := &connRecorder{}
			run := connEnv(t, connFakeAPI{rec: rec})
			connNoCloudCLIs(t)
			got := cloudsInvoke(t, run, append(args, "--no-input", "--output", "json", "--dry-run")...)
			if got.exited {
				t.Fatalf("exit %d:\n%s", got.code, got.stderr)
			}
			result := decodeMutation(t, got.stdout)
			if !result.DryRun || result.ID != "" || result.Action != "created" || result.Object["provider"] != provider {
				t.Errorf("result = %+v", result)
			}
			requests, _ := result.Object["requests"].([]interface{})
			if len(requests) != 2 {
				t.Errorf("the plan names %v, want the two requests a real run makes", requests)
			}
			if len(rec.paths) != 0 {
				t.Errorf("a dry run sent %v", rec.paths)
			}
		})
	}

	t.Run("a person is told in a sentence", func(t *testing.T) {
		run := connEnv(t, connFakeAPI{})
		got := cloudsInvoke(t, run, "connector", "aws", "--no-input", "--dry-run",
			"--role-arn", "arn:aws:iam::123456789012:role/AlethiaProvisionerRole")
		if got.exited || !strings.Contains(got.stdout, "Dry run: would connect AWS with the role-arn setup") {
			t.Errorf("exited=%v stdout=%q", got.exited, got.stdout)
		}
	})
}

// TestCloudsFamily_ConnectRefusalsAreTyped pins the exit code and the stream of each way a
// connector refuses a command line. Every one is decided before anything is sent.
func TestCloudsFamily_ConnectRefusalsAreTyped(t *testing.T) {
	cases := []struct {
		name string
		args []string
		exit int
		want string
	}{
		{"two modes", []string{"connector", "aws", "--manual", "--script"}, clierr.ExitUsage, "cannot be combined"},
		{"a paste with no terminal", []string{"connector", "aws", "--manual"}, clierr.ExitInputRequired, "--role-arn"},
		{"no aws CLI", []string{"connector", "aws"}, clierr.ExitConflict, "aws CLI not found on PATH"},
		{"no aws CLI for the script", []string{"connector", "aws", "--script"}, clierr.ExitConflict, "AWS CloudShell"},
		{"no project", []string{"connector", "gcp"}, clierr.ExitInputRequired, "--project"},
		{"a gcp paste with no terminal", []string{"connector", "gcp", "--project", "p", "--manual"}, clierr.ExitInputRequired, "--wif-config"},
		{"no gcloud", []string{"connector", "gcp", "--project", "p"}, clierr.ExitConflict, "gcloud CLI not found on PATH"},
		{"no subscription", []string{"connector", "azure"}, clierr.ExitInputRequired, "--subscription"},
		{"half an identity", []string{"connector", "azure", "--subscription", "s", "--tenant-id", "t"}, clierr.ExitUsage, "--client-id"},
		{"an azure paste with no terminal", []string{"connector", "azure", "--subscription", "s", "--manual"}, clierr.ExitInputRequired, "--tenant-id and --client-id"},
		{"no az CLI", []string{"connector", "azure", "--subscription", "s"}, clierr.ExitConflict, "az CLI not found on PATH"},
		{"no token", []string{"connector", "hetzner"}, clierr.ExitInputRequired, "--token-stdin"},
		{"a short token", []string{"connector", "hetzner", "--token", "abc"}, clierr.ExitUsage, "does not look like"},
		{"half a storage pair", []string{"connector", "hetzner", "--token", cloudsHetznerToken, "--s3-access-key", "AK"}, clierr.ExitUsage, "--s3-secret-key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := &connRecorder{}
			run := connEnv(t, connFakeAPI{rec: rec})
			connNoCloudCLIs(t)
			got := cloudsInvoke(t, run, append(tc.args, "--no-input")...)
			if !got.exited || got.code != tc.exit {
				t.Fatalf("exited=%v code=%d, want exit %d\n%s", got.exited, got.code, tc.exit, got.stderr)
			}
			if !strings.Contains(got.stderr, tc.want) {
				t.Errorf("stderr does not name %q:\n%s", tc.want, got.stderr)
			}
			if got.stdout != "" {
				t.Errorf("a refusal wrote on stdout: %q", got.stdout)
			}
			if len(rec.paths) != 0 {
				t.Errorf("a refused command line sent %v", rec.paths)
			}
		})
	}
}

// TestCloudsFamily_AFailedConnectionTestExits13 pins the class of a probe the control plane ran
// and failed, and that the reason it gave is in the error.
func TestCloudsFamily_AFailedConnectionTestExits13(t *testing.T) {
	run := connEnv(t, connFakeAPI{connect: map[string]interface{}{
		"identity_id": "cid-1", "verified": false, "status": "disconnected", "error": "assume role denied",
	}})
	got := cloudsInvoke(t, run, "connector", "aws", "--no-input",
		"--role-arn", "arn:aws:iam::123456789012:role/AlethiaProvisionerRole")
	if !got.exited || got.code != clierr.ExitOperationFailed {
		t.Fatalf("exited=%v code=%d, want exit %d", got.exited, got.code, clierr.ExitOperationFailed)
	}
	if !strings.Contains(got.stderr, "connection test failed (disconnected): assume role denied") || got.stdout != "" {
		t.Errorf("stderr=%q stdout=%q", got.stderr, got.stdout)
	}
}

// TestCloudsFamily_ListIsTheRecords pins `connector list`: the records under json, and for a
// person with nothing connected a hint on stderr that names only offered clouds.
func TestCloudsFamily_ListIsTheRecords(t *testing.T) {
	cloudsRestoreHelp(t)
	cloudsOffer(t, "")

	run := connEnv(t, connFakeAPI{})
	got := cloudsInvoke(t, run, "connector", "list", "--no-input", "--output", "json")
	var records []map[string]string
	if err := json.Unmarshal([]byte(got.stdout), &records); err != nil {
		t.Fatalf("stdout is not a list of records: %v\n%q", err, got.stdout)
	}
	if len(records) != 1 || records[0]["id"] != "ci1" || records[0]["provider"] != "aws" {
		t.Errorf("records = %v", records)
	}

	run = connEnv(t, connFakeAPI{noIdentities: true})
	got = cloudsInvoke(t, run, "connector", "list", "--no-input", "--output", "json")
	if strings.TrimSpace(got.stdout) != "[]" {
		t.Errorf("no accounts under json is %q, want an empty list", got.stdout)
	}

	run = connEnv(t, connFakeAPI{noIdentities: true})
	got = cloudsInvoke(t, run, "connector", "list", "--no-input")
	if got.stdout != "" || !strings.Contains(got.stderr, "alethia connector aws|gcp|azure|hetzner`") {
		t.Errorf("stdout=%q stderr=%q", got.stdout, got.stderr)
	}

	run = connEnv(t, connFakeAPI{identitiesStatus: http.StatusServiceUnavailable})
	got = cloudsInvoke(t, run, "connector", "list", "--no-input", "--output", "json")
	if !got.exited || got.code != clierr.ExitUnavailable || got.stdout != "" {
		t.Errorf("exited=%v code=%d stdout=%q, want exit %d and nothing on stdout",
			got.exited, got.code, got.stdout, clierr.ExitUnavailable)
	}
}

// TestCloudsFamily_RemoveReturnsOneMutationResult pins `connector remove` in each of its endings.
func TestCloudsFamily_RemoveReturnsOneMutationResult(t *testing.T) {
	t.Run("removed", func(t *testing.T) {
		rec := &connRecorder{}
		run := connEnv(t, connFakeAPI{rec: rec})
		got := cloudsInvoke(t, run, "connector", "remove", "aws", "--yes", "--no-input", "--output", "json")
		result := decodeMutation(t, got.stdout)
		if result.ID != "ci1" || result.Action != "deleted" || result.DryRun || result.Object["label"] != "prod-account" {
			t.Errorf("result = %+v", result)
		}
		if !rec.saw("/providers/aws/disconnect") {
			t.Errorf("sent %v", rec.paths)
		}
	})

	t.Run("by id", func(t *testing.T) {
		run := connEnv(t, connFakeAPI{})
		got := cloudsInvoke(t, run, "connector", "remove", "ci1", "--yes", "--no-input", "--output", "json")
		if result := decodeMutation(t, got.stdout); result.ID != "ci1" || result.Action != "deleted" {
			t.Errorf("result = %+v", result)
		}
	})

	t.Run("dry run", func(t *testing.T) {
		rec := &connRecorder{}
		run := connEnv(t, connFakeAPI{rec: rec})
		got := cloudsInvoke(t, run, "connector", "remove", "aws", "--dry-run", "--no-input", "--output", "json")
		if result := decodeMutation(t, got.stdout); !result.DryRun || result.ID != "ci1" || result.Action != "deleted" {
			t.Errorf("result = %+v", result)
		}
		if rec.saw("/disconnect") {
			t.Errorf("a dry run disconnected: %v", rec.paths)
		}

		got = cloudsInvoke(t, run, "connector", "remove", "aws", "--dry-run", "--no-input")
		if !strings.Contains(got.stdout, "Dry run: would disconnect prod-account") {
			t.Errorf("stdout = %q", got.stdout)
		}
	})

	t.Run("nothing connected", func(t *testing.T) {
		run := connEnv(t, connFakeAPI{noIdentities: true})
		got := cloudsInvoke(t, run, "connector", "remove", "--no-input", "--output", "json")
		if result := decodeMutation(t, got.stdout); result.Action != "unchanged" || result.ID != "" {
			t.Errorf("result = %+v", result)
		}
		got = cloudsInvoke(t, run, "connector", "remove", "--no-input")
		if got.stdout != "" || !strings.Contains(got.stderr, "No cloud accounts connected.") {
			t.Errorf("stdout=%q stderr=%q", got.stdout, got.stderr)
		}
	})

	two := []map[string]interface{}{
		{"id": "ci1", "provider": "aws", "label": "prod", "created_at": "2026-01-01T00:00:00Z"},
		{"id": "ci2", "provider": "aws", "label": "staging", "created_at": "2026-01-02T00:00:00Z"},
	}
	for _, tc := range []struct {
		name string
		cfg  connFakeAPI
		args []string
		exit int
		want string
	}{
		{"no confirmation", connFakeAPI{}, []string{"connector", "remove", "aws"}, clierr.ExitInputRequired, "--yes"},
		{"nothing named", connFakeAPI{}, []string{"connector", "remove"}, clierr.ExitInputRequired, "pass a provider (aws, gcp, azure, hetzner)"},
		{"not connected", connFakeAPI{}, []string{"connector", "remove", "gcp", "--yes"}, clierr.ExitNotFound, "no connected gcp account found"},
		{"not an account", connFakeAPI{}, []string{"connector", "remove", "nope", "--yes"}, clierr.ExitNotFound, "no connected account matches"},
		{"two accounts on one cloud", connFakeAPI{identities: two}, []string{"connector", "remove", "aws", "--yes"}, clierr.ExitUsage, "ci1, ci2"},
		{"refused by the control plane", connFakeAPI{disconnectStatus: http.StatusForbidden}, []string{"connector", "remove", "aws", "--yes"}, clierr.ExitForbidden, "failed to disconnect prod-account"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := &connRecorder{}
			tc.cfg.rec = rec
			run := connEnv(t, tc.cfg)
			got := cloudsInvoke(t, run, append(tc.args, "--no-input", "--output", "json")...)
			if !got.exited || got.code != tc.exit {
				t.Fatalf("exited=%v code=%d, want exit %d\n%s", got.exited, got.code, tc.exit, got.stderr)
			}
			if !strings.Contains(got.stderr, tc.want) || got.stdout != "" {
				t.Errorf("stderr=%q stdout=%q", got.stderr, got.stdout)
			}
			if tc.exit != clierr.ExitForbidden && rec.saw("/disconnect") {
				t.Errorf("a refused remove disconnected: %v", rec.paths)
			}
		})
	}
}

// TestCloudsFamily_ProviderAndCloudReadsAreDocuments pins the JSON form of the three read and
// verify commands, and the refusals each makes before any request.
func TestCloudsFamily_ProviderAndCloudReadsAreDocuments(t *testing.T) {
	run := connEnv(t, connFakeAPI{})

	got := cloudsInvoke(t, run, "provider", "status", "aws", "--no-input", "--output", "json")
	var status map[string]interface{}
	if err := json.Unmarshal([]byte(got.stdout), &status); err != nil || status["connected"] != true {
		t.Errorf("provider status: %v %q", err, got.stdout)
	}

	got = cloudsInvoke(t, run, "provider", "verify", "aws", "--no-input", "--output", "json")
	if result := decodeMutation(t, got.stdout); result.ID != "ci1" || result.Action != "updated" || result.Object["verified"] != true {
		t.Errorf("provider verify: %+v", result)
	}
	got = cloudsInvoke(t, run, "provider", "verify", "aws", "--no-input")
	if !strings.Contains(got.stdout, "verified") || !strings.Contains(got.stdout, "ci1") {
		t.Errorf("provider verify for a person: %q", got.stdout)
	}

	got = cloudsInvoke(t, run, "cloud", "inventory", "aws", "--no-input", "--output", "json")
	var inventory map[string]interface{}
	if err := json.Unmarshal([]byte(got.stdout), &inventory); err != nil {
		t.Errorf("cloud inventory: %v %q", err, got.stdout)
	}
	if _, ok := inventory["networks"]; !ok {
		t.Errorf("cloud inventory has no networks key: %q", got.stdout)
	}

	for _, tc := range []struct {
		name string
		args []string
		exit int
		want string
	}{
		{"status of something that is not a cloud", []string{"provider", "status", "nope"}, clierr.ExitUsage, "is not a cloud: pass one of aws, gcp, azure, hetzner"},
		{"status with nothing named", []string{"provider", "status"}, clierr.ExitInputRequired, "no provider given"},
		{"verify with nothing named", []string{"provider", "verify"}, clierr.ExitInputRequired, "no provider given"},
		{"inventory with nothing named", []string{"cloud", "inventory"}, clierr.ExitInputRequired, "no cloud account given"},
		{"inventory of a cloud with no account", []string{"cloud", "inventory", "gcp"}, clierr.ExitNotFound, "alethia connector gcp"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := cloudsInvoke(t, run, append(tc.args, "--no-input", "--output", "json")...)
			if !got.exited || got.code != tc.exit {
				t.Fatalf("exited=%v code=%d, want exit %d\n%s", got.exited, got.code, tc.exit, got.stderr)
			}
			if !strings.Contains(got.stderr, tc.want) || got.stdout != "" {
				t.Errorf("stderr=%q stdout=%q", got.stderr, got.stdout)
			}
		})
	}
}

// TestCloudsFamily_AnAgentIsNarratedInPlainLines pins the stage report an agent reads: the stage's
// name on a line of its own, and no stepper glyphs.
func TestCloudsFamily_AnAgentIsNarratedInPlainLines(t *testing.T) {
	p, _, errOut := cloudsTestPrinter("json")
	p.Mode.Agent = true
	printStep(p, []string{"Initialize", "Create IAM role", "Connection test"}, 1)
	if errOut.String() != "Create IAM role\n" {
		t.Errorf("an agent is told %q", errOut.String())
	}
}

// TestCloudsFamily_APromptLeftWithCtrlCIsAnInterrupt pins the class of an abandoned prompt.
func TestCloudsFamily_APromptLeftWithCtrlCIsAnInterrupt(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connStubForm(t, huh.ErrUserAborted)
	got := cloudsInvoke(t, run, "connector", "aws", "--manual")
	if !got.exited || got.code != clierr.ExitInterrupted {
		t.Fatalf("exited=%v code=%d, want exit %d\n%s", got.exited, got.code, clierr.ExitInterrupted, got.stderr)
	}
}

// cloudsFailingWriter accepts a number of writes and fails every one after them.
type cloudsFailingWriter struct{ left int }

// Write counts down and then fails.
func (w *cloudsFailingWriter) Write(b []byte) (int, error) {
	if w.left <= 0 {
		return 0, io.ErrClosedPipe
	}
	w.left--
	return len(b), nil
}

// TestCloudsFamily_AFailedWriteOfTheInventoryIsAnError pins that a table the command could not
// write is reported, whichever of the two tables it was.
func TestCloudsFamily_AFailedWriteOfTheInventoryIsAnError(t *testing.T) {
	name := "main"
	c := &fakeClient{cloudInv: &api.CloudInventory{
		Networks: []api.CloudNetwork{{NativeID: "vpc-1", Name: &name, Provider: "aws"}},
		Subnets:  []api.CloudSubnet{{NativeID: "subnet-1"}},
		Regions:  []string{"eu-west-1"},
	}}
	failures := 0
	for allowed := 0; allowed < 12; allowed++ {
		p, _, _ := cloudsTestPrinter("table")
		p.Out = &cloudsFailingWriter{left: allowed}
		if err := runCloudInventory(c, p, "id-1"); err != nil {
			failures++
		}
	}
	// The headings are written unchecked, as a person's reading aid; the two tables are not.
	if failures < 2 {
		t.Errorf("%d of 12 truncated writes were reported, want the failure of either table to be", failures)
	}
}

// TestCloudsFamily_VerifyListsWhatADegradedConnectionIsMissing pins the person's form of a probe
// that passed with permissions missing: the card names them, and the warning is on stderr.
func TestCloudsFamily_VerifyListsWhatADegradedConnectionIsMissing(t *testing.T) {
	c := &fakeClient{
		providerStat: &api.ProviderStatus{Connected: true, IdentityID: "id-1"},
		verifyResult: &api.ConnectIdentityResponse{
			IdentityID: "id-1", Verified: true, Status: "degraded",
			MissingPermissions: []string{"ec2:CreateVpc", "eks:CreateCluster"},
		},
	}
	p, out, errOut := cloudsTestPrinter("table")
	if err := runProviderVerify(c, p, "aws"); err != nil {
		t.Fatalf("runProviderVerify: %v", err)
	}
	if !strings.Contains(out.String(), "ec2:CreateVpc, eks:CreateCluster") {
		t.Errorf("the card does not list the missing permissions:\n%s", out.String())
	}
	if !strings.Contains(errOut.String(), "missing some provisioning permissions") {
		t.Errorf("the warning is not on stderr: %q", errOut.String())
	}
}

// TestCloudsFamily_APickerOverNothingSaysHowToConnect pins the answer when a person names no
// account and none is connected: not found, with the connectors that are offered.
func TestCloudsFamily_APickerOverNothingSaysHowToConnect(t *testing.T) {
	t.Setenv(catalog.HiddenCloudsEnv, "")
	hygCliConfirmInteractive(t)
	_, err := resolveCloudIdentityRef(&connFakeLister{identities: []api.CloudIdentity{}}, "")
	got := clierr.From(err)
	if got == nil || got.Exit != clierr.ExitNotFound || !strings.Contains(got.Hint, "alethia connector aws|gcp|azure|hetzner") {
		t.Errorf("err = %+v", got)
	}
}
