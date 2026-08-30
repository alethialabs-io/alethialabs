// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/compat"
)

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
//
// The workload JSON below is the SHAPE kubectl returns, not an invention: the container images and
// the version label were read out of `helm template argo-cd argo/argo-cd --version <pin>` for the
// shipped chart. Two of them are the reason this check reads images the way it does —
// argocd-redis runs the redis image and argocd-dex-server lists dex's image FIRST — and a fixture
// that omitted them would let the naive implementation pass.

// workload renders one list item with the given kind, name, version label and container images.
func workload(kind, name, versionLabel string, images ...string) string {
	containers := make([]string, 0, len(images))
	for _, img := range images {
		containers = append(containers, fmt.Sprintf(`{"image":%q}`, img))
	}
	labels := `"app.kubernetes.io/part-of":"argocd"`
	if versionLabel != "" {
		labels += fmt.Sprintf(`,"app.kubernetes.io/version":%q`, versionLabel)
	}
	return fmt.Sprintf(
		`{"kind":%q,"metadata":{"name":%q,"labels":{%s}},"spec":{"template":{"spec":{"containers":[%s]}}}}`,
		kind, name, labels, strings.Join(containers, ","))
}

// list wraps items in the multi-type List document kubectl returns for `sts,deploy`.
func list(items ...string) string {
	return `{"apiVersion":"v1","kind":"List","items":[` + strings.Join(items, ",") + `]}`
}

// ourInstall is the seven workloads the pinned chart renders, with the images it renders.
func ourInstall(app string) string {
	return list(
		workload("StatefulSet", "argo-cd-argocd-application-controller", app, "quay.io/argoproj/argocd:"+app),
		workload("Deployment", "argo-cd-argocd-server", app, "quay.io/argoproj/argocd:"+app),
		workload("Deployment", "argo-cd-argocd-repo-server", app, "quay.io/argoproj/argocd:"+app, "quay.io/argoproj/argocd:"+app),
		workload("Deployment", "argo-cd-argocd-applicationset-controller", app, "quay.io/argoproj/argocd:"+app),
		workload("Deployment", "argo-cd-argocd-notifications-controller", app, "quay.io/argoproj/argocd:"+app),
		// dex lists ITS image first — the trap that would otherwise read v2.45.1 as ArgoCD's version.
		workload("Deployment", "argo-cd-argocd-dex-server", app, "ghcr.io/dexidp/dex:v2.45.1", "quay.io/argoproj/argocd:"+app),
		// redis runs no argocd container at all — only the label answers for it.
		workload("Deployment", "argo-cd-argocd-redis", app, "ecr-public.aws.com/docker/library/redis:8.2.3-alpine"),
	)
}

// ── the pure classifier ─────────────────────────────────────────────────────────────────────

func TestClassifyLiveArgoWorkloads(t *testing.T) {
	for _, tc := range []struct {
		name            string
		stdout          string
		stderr          string
		runErr          error
		wantAnswered    bool
		wantWorkloads   int
		wantVersions    []string
		wantUnversioned []string
		wantReason      string // substring
	}{
		{
			name:         "fresh cluster answers with an empty list",
			stdout:       list(),
			wantAnswered: true,
		},
		{
			// An empty list is an ANSWER. Reading it as "could not ask" would make every fresh
			// cluster warn, and reading a failed ask as this would skip the check that matters.
			name:         "missing namespace also answers with an empty list",
			stdout:       `{"apiVersion":"v1","kind":"List","items":[],"metadata":{"resourceVersion":""}}`,
			wantAnswered: true,
		},
		{
			name:          "our own install reports one version across seven workloads",
			stdout:        ourInstall("v3.3.9"),
			wantAnswered:  true,
			wantWorkloads: 7,
			wantVersions:  []string{"v3.3.9"},
		},
		{
			name:          "an install below the floor reports the version it is running",
			stdout:        ourInstall("v3.1.8"),
			wantAnswered:  true,
			wantWorkloads: 7,
			wantVersions:  []string{"v3.1.8"},
		},
		{
			name: "a registry port is not a tag",
			stdout: list(workload("StatefulSet", "argocd-application-controller", "",
				"registry.internal:5000/argocd:v3.3.9")),
			wantAnswered:  true,
			wantWorkloads: 1,
			wantVersions:  []string{"v3.3.9"},
		},
		{
			name: "a registry port with no tag yields no version",
			stdout: list(workload("StatefulSet", "argocd-application-controller", "",
				"registry.internal:5000/argocd")),
			wantAnswered:    true,
			wantWorkloads:   1,
			wantUnversioned: []string{"argocd-application-controller"},
		},
		{
			name: "a digest-only image falls back to the version label",
			stdout: list(workload("StatefulSet", "argocd-application-controller", "v3.3.9",
				"quay.io/argoproj/argocd@sha256:deadbeef")),
			wantAnswered:  true,
			wantWorkloads: 1,
			wantVersions:  []string{"v3.3.9"},
		},
		{
			// The one that must not invent a version: no tag, no label, nothing to say.
			name: "a digest-only image with no label yields no version",
			stdout: list(workload("StatefulSet", "argocd-application-controller", "",
				"quay.io/argoproj/argocd@sha256:deadbeef")),
			wantAnswered:    true,
			wantWorkloads:   1,
			wantUnversioned: []string{"argocd-application-controller"},
		},
		{
			name: "a tag plus a digest keeps the tag",
			stdout: list(workload("StatefulSet", "argocd-application-controller", "",
				"quay.io/argoproj/argocd:v3.3.9@sha256:deadbeef")),
			wantAnswered:  true,
			wantWorkloads: 1,
			wantVersions:  []string{"v3.3.9"},
		},
		{
			name: "a mid-upgrade cluster reports both versions",
			stdout: list(
				workload("StatefulSet", "argocd-application-controller", "", "quay.io/argoproj/argocd:v3.3.9"),
				workload("Deployment", "argocd-server", "", "quay.io/argoproj/argocd:v3.4.0"),
			),
			wantAnswered:  true,
			wantWorkloads: 2,
			wantVersions:  []string{"v3.3.9", "v3.4.0"},
		},
		{
			// Non-argocd images must never be read as ArgoCD's version. dex v2.45.1 is BELOW the
			// shipped floor, so a naive first-container read would refuse a healthy cluster.
			name: "dex and redis images are never read as ArgoCD's version",
			stdout: list(
				workload("Deployment", "argo-cd-argocd-dex-server", "v3.3.9", "ghcr.io/dexidp/dex:v2.45.1", "quay.io/argoproj/argocd:v3.3.9"),
				workload("Deployment", "argo-cd-argocd-redis", "v3.3.9", "ecr-public.aws.com/docker/library/redis:8.2.3-alpine"),
			),
			wantAnswered:  true,
			wantWorkloads: 2,
			wantVersions:  []string{"v3.3.9"},
		},
		{
			// kubectl writes deprecation and exec-credential notices to stderr on calls that
			// SUCCEED. Folding them into stdout would turn a healthy answer into garbage.
			name:          "a kubectl warning on stderr does not spoil a valid list",
			stdout:        ourInstall("v3.3.9"),
			stderr:        "Warning: v1 Deployment is deprecated\nW0830 unable to resolve exec credential plugin cache\n",
			wantAnswered:  true,
			wantWorkloads: 7,
			wantVersions:  []string{"v3.3.9"},
		},
		{
			name:       "RBAC Forbidden is not an absent ArgoCD",
			stderr:     `Error from server (Forbidden): deployments.apps is forbidden: User "system:serviceaccount:ci:runner" cannot list resource "deployments" in API group "apps" in the namespace "argocd"`,
			runErr:     errors.New("exit status 1"),
			wantReason: "Forbidden",
		},
		{
			name:       "a dial timeout is not an absent ArgoCD",
			stderr:     "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout",
			runErr:     errors.New("exit status 1"),
			wantReason: "i/o timeout",
		},
		{
			name:       "a failure with no diagnostic still says something",
			runErr:     errors.New("exec: \"kubectl\": executable file not found in $PATH"),
			wantReason: "executable file not found",
		},
		{
			name:       "garbage stdout with exit 0 is not an answer",
			stdout:     "totally not json\n",
			wantReason: "not JSON",
		},
		{
			name:       "empty stdout with exit 0 is not an answer",
			stdout:     "",
			wantReason: "not JSON",
		},
		{
			// Valid JSON that is not a list would otherwise unmarshal to zero items and read as a
			// fresh cluster — the single worst collapse this classifier can make.
			name:       "valid JSON that is not a list is not an answer",
			stdout:     `{}`,
			wantReason: "not a Kubernetes list",
		},
		{
			name:          "a single-type list kind is still a list",
			stdout:        `{"kind":"DeploymentList","items":[` + workload("Deployment", "argocd-server", "v3.3.9") + `]}`,
			wantAnswered:  true,
			wantWorkloads: 1,
			wantVersions:  []string{"v3.3.9"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyLiveArgoWorkloads([]byte(tc.stdout), []byte(tc.stderr), tc.runErr)
			if got.Answered != tc.wantAnswered {
				t.Fatalf("Answered = %v, want %v (reason %q)", got.Answered, tc.wantAnswered, got.Reason)
			}
			if !tc.wantAnswered {
				if tc.wantReason != "" && !strings.Contains(got.Reason, tc.wantReason) {
					t.Fatalf("Reason = %q, want it to contain %q", got.Reason, tc.wantReason)
				}
				// An unanswered probe must carry NOTHING that could be mistaken for a reading.
				if len(got.Workloads) != 0 || len(got.Versions) != 0 || len(got.Unversioned) != 0 {
					t.Fatalf("an unanswered probe must observe nothing, got %+v", got)
				}
				return
			}
			if len(got.Workloads) != tc.wantWorkloads {
				t.Errorf("workloads = %d (%v), want %d", len(got.Workloads), got.Workloads, tc.wantWorkloads)
			}
			if strings.Join(got.Versions, ",") != strings.Join(tc.wantVersions, ",") {
				t.Errorf("versions = %v, want %v", got.Versions, tc.wantVersions)
			}
			if strings.Join(got.Unversioned, ",") != strings.Join(tc.wantUnversioned, ",") {
				t.Errorf("unversioned = %v, want %v", got.Unversioned, tc.wantUnversioned)
			}
			if got.Reason != "" {
				t.Errorf("an answered probe must carry no failure reason, got %q", got.Reason)
			}
		})
	}
}

func TestArgoTagFromImage(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{"quay.io/argoproj/argocd:v3.3.9", "v3.3.9"},
		{"registry.internal:5000/argocd:v3.3.9", "v3.3.9"},
		{"registry.internal:5000/argocd", ""},
		{"quay.io/argoproj/argocd@sha256:abc", ""},
		{"quay.io/argoproj/argocd:v3.3.9@sha256:abc", "v3.3.9"},
		{"quay.io/argoproj/argocd", ""},
		{"", ""},
		{"   ", ""},
		// Not ArgoCD — must yield nothing, whatever the tag says.
		{"ecr-public.aws.com/docker/library/redis:8.2.3-alpine", ""},
		{"ghcr.io/dexidp/dex:v2.45.1", ""},
		{"redis:8.2.3", ""},
		// A private mirror that renamed the image still names it.
		{"mirror.corp/platform/argo-cd-server:v3.4.1", "v3.4.1"},
		{"mirror.corp/ARGOCD:v3.4.1", "v3.4.1"},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			if got := argoTagFromImage(tc.raw); got != tc.want {
				t.Fatalf("argoTagFromImage(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// ── the pure decider ────────────────────────────────────────────────────────────────────────

// testWindow is a synthetic declared window, so the table pins the RULE rather than today's data.
var testWindow = compat.SupportedWindow{AppVersionMin: "v3.3.0"}

func TestDecideArgoVersionPreflight(t *testing.T) {
	for _, tc := range []struct {
		name        string
		obs         LiveArgoObservation
		win         compat.SupportedWindow
		declared    bool
		pinned      string
		wantVerdict ArgoPreflightVerdict
		wantProceed bool
		wantSaid    []string
		wantNotSaid []string
	}{
		{
			name: "fresh cluster proceeds and names what it will install",
			obs:  LiveArgoObservation{Answered: true},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightAbsent, wantProceed: true,
			wantSaid: []string{"no existing ArgoCD found", "v3.3.9", "v3.3.0+"},
		},
		{
			name: "an install inside the window proceeds",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"v3.3.9"}},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightInRange, wantProceed: true,
			wantSaid:    []string{"v3.3.9", "v3.3.0+"},
			wantNotSaid: []string{"DOWNGRADE"},
		},
		{
			name: "a pin below what is running says so LOUDLY",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"v3.5.0"}},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightInRange, wantProceed: true,
			wantSaid: []string{"DOWNGRADE", "v3.5.0", "v3.3.9"},
		},
		{
			name: "an equal pin is not a downgrade",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"v3.3.9"}},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightInRange, wantProceed: true,
			wantNotSaid: []string{"DOWNGRADE"},
		},
		{
			name: "a mid-upgrade cluster names the whole set",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"a", "b"}, Versions: []string{"v3.3.9", "v3.4.0"}},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightInRange, wantProceed: true,
			wantSaid: []string{"v3.3.9", "v3.4.0", "mid-upgrade"},
		},
		{
			name: "a version below the floor REFUSES",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"v3.1.8"}},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightOutOfRange, wantProceed: false,
			wantSaid: []string{"refusing to install ArgoCD", "v3.1.8", "v3.3.0+", SkipVersionPreflightEnv},
		},
		{
			name: "a mid-upgrade cluster with one bad version REFUSES on the bad one",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"a", "b"}, Versions: []string{"v3.1.8", "v3.3.9"}},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightOutOfRange, wantProceed: false,
			wantSaid: []string{"v3.1.8"},
		},
		{
			name: "a present but unreadable ArgoCD REFUSES and names the hatch",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"argocd-server"}, Unversioned: []string{"argocd-server"}},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightUnversioned, wantProceed: false,
			wantSaid: []string{"refusing to install ArgoCD", "argocd-server", "v3.3.0+", SkipVersionPreflightEnv},
		},
		{
			name: "a version string that is not a version REFUSES as unversioned",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"latest"}},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightUnversioned, wantProceed: false,
			wantSaid: []string{"latest", "v3.3.0+", SkipVersionPreflightEnv},
		},
		{
			name: "RBAC Forbidden WARNS and PROCEEDS",
			obs:  LiveArgoObservation{Reason: `Error from server (Forbidden): deployments.apps is forbidden`},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightUnreadable, wantProceed: true,
			wantSaid:    []string{"did not answer", "NOT checked", "Forbidden", "v3.3.0+"},
			wantNotSaid: []string{"refusing"},
		},
		{
			name: "a dial timeout WARNS and PROCEEDS",
			obs:  LiveArgoObservation{Reason: "Unable to connect to the server: i/o timeout"},
			win:  testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightUnreadable, wantProceed: true,
			wantSaid: []string{"i/o timeout", "NOT checked"},
		},
		{
			name: "an undeclared window WARNS and PROCEEDS",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"v2.11.0"}},
			win:  compat.SupportedWindow{}, declared: false, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightNoWindow, wantProceed: true,
			wantSaid:    []string{"NO supported window", "v2.11.0"},
			wantNotSaid: []string{"refusing"},
		},
		{
			name: "an undeclared window never renders as an open one",
			obs:  LiveArgoObservation{Answered: true},
			win:  compat.SupportedWindow{}, declared: false, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightAbsent, wantProceed: true,
			wantSaid:    []string{"(none declared)"},
			wantNotSaid: []string{"window any"},
		},
		{
			name: "an unrecorded chart pin says the version is unknown rather than guessing",
			obs:  LiveArgoObservation{Answered: true},
			win:  testWindow, declared: true, pinned: "",
			wantVerdict: ArgoPreflightAbsent, wantProceed: true,
			wantSaid: []string{"does not record"},
		},
		{
			name: "a partially readable cluster judges on what it read and says how much it did not",
			obs: LiveArgoObservation{Answered: true, Workloads: []string{"a", "b"},
				Versions: []string{"v3.3.9"}, Unversioned: []string{"b"}},
			win: testWindow, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightInRange, wantProceed: true,
			wantSaid: []string{"reported no version", "b"},
		},
		{
			name: "a ceiling refuses above it too",
			obs:  LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"v4.0.0"}},
			win:  compat.SupportedWindow{AppVersionMin: "v3.3.0", AppVersionMax: "v3.9.9"}, declared: true, pinned: "v3.3.9",
			wantVerdict: ArgoPreflightOutOfRange, wantProceed: false,
			wantSaid: []string{"v4.0.0", "v3.3.0–v3.9.9"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := decideArgoVersionPreflight(tc.obs, tc.win, tc.declared, tc.pinned)
			if got.Verdict != tc.wantVerdict {
				t.Fatalf("verdict = %s, want %s (message: %s)", got.Verdict, tc.wantVerdict, got.Message)
			}
			if got.Proceed != tc.wantProceed {
				t.Fatalf("proceed = %v, want %v (message: %s)", got.Proceed, tc.wantProceed, got.Message)
			}
			if strings.TrimSpace(got.Message) == "" {
				t.Fatal("every verdict must carry a sentence the operator can act on")
			}
			for _, want := range tc.wantSaid {
				if !strings.Contains(got.Message, want) {
					t.Errorf("message must contain %q, got: %s", want, got.Message)
				}
			}
			for _, unwanted := range tc.wantNotSaid {
				if strings.Contains(got.Message, unwanted) {
					t.Errorf("message must NOT contain %q, got: %s", unwanted, got.Message)
				}
			}
		})
	}
}

// TestArgoPreflightRefusalsNameBothVersionAndWindow pins the honesty bar a refusal has to clear:
// it names WHAT IS RUNNING and WHAT WE SUPPORT, and both come from a read (the cluster, the
// matrix) rather than from a literal in the source.
func TestArgoPreflightRefusalsNameBothVersionAndWindow(t *testing.T) {
	win, declared := compat.MustLoad().SupportedWindow("argocd")
	if !declared {
		t.Fatal("the matrix declares no ArgoCD window, so this test proved nothing")
	}
	label := compat.SemverLabel(win.AppVersionMin, win.AppVersionMax)

	obs := classifyLiveArgoWorkloads([]byte(ourInstall("v3.1.8")), nil, nil)
	got := decideArgoVersionPreflight(obs, win, declared, pinnedArgoAppVersion())
	if got.Verdict != ArgoPreflightOutOfRange || got.Proceed {
		t.Fatalf("the shipped window must refuse the version #2717 measured as broken, got %s/%v", got.Verdict, got.Proceed)
	}
	for _, want := range []string{"v3.1.8", label, SkipVersionPreflightEnv} {
		if !strings.Contains(got.Message, want) {
			t.Errorf("refusal must name %q, got: %s", want, got.Message)
		}
	}
	// And the shipped pin itself must pass the shipped window — a check that refused our own
	// install would be discovered by a customer, not by us.
	inRange := decideArgoVersionPreflight(
		classifyLiveArgoWorkloads([]byte(ourInstall(pinnedArgoAppVersion())), nil, nil), win, declared, pinnedArgoAppVersion())
	if inRange.Verdict != ArgoPreflightInRange || !inRange.Proceed {
		t.Fatalf("the shipped pin must be inside the shipped window, got %s/%v: %s", inRange.Verdict, inRange.Proceed, inRange.Message)
	}
	if strings.Contains(inRange.Message, "DOWNGRADE") {
		t.Fatalf("installing the pin over the pin is not a downgrade: %s", inRange.Message)
	}
}

// TestArgoPreflightAntiCollapse is the exhaustive guard against the two ways this check can be
// WRONG in the direction that costs a customer a deploy.
//
// It sweeps every observation shape against every window state and asserts two invariants that no
// individual table row can establish, because they are statements about the WHOLE space:
//
//	(1) an observation whose probe did not answer may NEVER produce a refusal. "I could not ask"
//	    is not "what you are running is broken", and collapsing the two refuses exactly the SRE
//	    who locked their cluster down properly.
//	(2) an unreadable or absent observation may never be REPORTED as a confirmed in-window check.
//	    A run that says "inside the supported window" when nothing was compared is the false PASS
//	    the whole compat engine exists to refuse.
func TestArgoPreflightAntiCollapse(t *testing.T) {
	unanswered := []LiveArgoObservation{
		{Reason: "Error from server (Forbidden)"},
		{Reason: "Unable to connect to the server: i/o timeout"},
		{Reason: "kubectl exited 0 but its output was not JSON"},
		{Reason: "kubectl exited 0 but answered with kind \"Status\""},
		{Reason: ""}, // even a probe that failed to say why
		// Deliberately malformed: fields set that a real classifier would never set alongside
		// Answered=false. The decider must still refuse to read them.
		{Reason: "boom", Workloads: []string{"argocd-server"}, Versions: []string{"v2.11.0"}},
		{Reason: "boom", Workloads: []string{"argocd-server"}, Unversioned: []string{"argocd-server"}},
	}
	answeredNothingChecked := []LiveArgoObservation{
		{Answered: true}, // absent
		{Answered: true, Workloads: nil, Versions: nil}, // absent, spelled the other way
	}
	windows := []struct {
		win      compat.SupportedWindow
		declared bool
	}{
		{compat.SupportedWindow{AppVersionMin: "v3.3.0"}, true},
		{compat.SupportedWindow{AppVersionMin: "v3.3.0", AppVersionMax: "v3.9.9"}, true},
		{compat.SupportedWindow{AppVersionMax: "v3.9.9"}, true},
		{compat.SupportedWindow{}, false},
		{compat.SupportedWindow{AppVersionMin: "not-a-version"}, true},
	}
	pins := []string{"v3.3.9", "", "not-a-version"}

	checked := 0
	for _, obs := range unanswered {
		for _, w := range windows {
			for _, pin := range pins {
				checked++
				got := decideArgoVersionPreflight(obs, w.win, w.declared, pin)
				if got.Verdict != ArgoPreflightUnreadable {
					t.Errorf("an unanswered probe must be UNREADABLE, got %s for obs %+v / window %+v",
						got.Verdict, obs, w.win)
				}
				if !got.Proceed {
					t.Errorf("an unanswered probe must PROCEED, got a refusal for obs %+v: %s", obs, got.Message)
				}
				if strings.Contains(got.Message, "inside Alethia's supported window") {
					t.Errorf("an unanswered probe must never claim a confirmed check: %s", got.Message)
				}
			}
		}
	}
	for _, obs := range answeredNothingChecked {
		for _, w := range windows {
			for _, pin := range pins {
				checked++
				got := decideArgoVersionPreflight(obs, w.win, w.declared, pin)
				if got.Verdict == ArgoPreflightInRange {
					t.Errorf("nothing was compared, so nothing may be reported IN_RANGE: %+v → %s", obs, got.Message)
				}
				if strings.Contains(got.Message, "inside Alethia's supported window") {
					t.Errorf("an absent ArgoCD must never claim a confirmed check: %s", got.Message)
				}
			}
		}
	}
	// "Found no violation" and "swept nothing" print the same result otherwise.
	want := (len(unanswered) + len(answeredNothingChecked)) * len(windows) * len(pins)
	if checked != want || checked == 0 {
		t.Fatalf("the sweep covered %d combinations, expected %d — its silence is not a pass", checked, want)
	}
}

// TestArgoPreflightVerdictsAreExhaustive fails if a state is added without a decision path, so the
// six-state table in the brief cannot quietly become a five-state implementation.
func TestArgoPreflightVerdictsAreExhaustive(t *testing.T) {
	win := compat.SupportedWindow{AppVersionMin: "v3.3.0"}
	reached := map[ArgoPreflightVerdict]bool{}
	for _, c := range []struct {
		obs      LiveArgoObservation
		declared bool
	}{
		{LiveArgoObservation{Answered: true}, true},
		{LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"v3.3.9"}}, true},
		{LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"v3.1.8"}}, true},
		{LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Unversioned: []string{"a"}}, true},
		{LiveArgoObservation{Reason: "nope"}, true},
		{LiveArgoObservation{Answered: true, Workloads: []string{"a"}, Versions: []string{"v3.3.9"}}, false},
	} {
		w := win
		if !c.declared {
			w = compat.SupportedWindow{}
		}
		reached[decideArgoVersionPreflight(c.obs, w, c.declared, "v3.3.9").Verdict] = true
	}
	for _, v := range []ArgoPreflightVerdict{
		ArgoPreflightAbsent, ArgoPreflightInRange, ArgoPreflightOutOfRange,
		ArgoPreflightUnversioned, ArgoPreflightUnreadable, ArgoPreflightNoWindow,
	} {
		if !reached[v] {
			t.Errorf("no input reaches the %s verdict — the state is dead code", v)
		}
	}
	if len(reached) != 6 {
		t.Fatalf("reached %d verdicts, want 6: %v", len(reached), reached)
	}
}

// ── the exec seam ───────────────────────────────────────────────────────────────────────────

func TestProbeLiveArgoWorkloadsIssuesTheRightQuestion(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get statefulsets.apps,deployments.apps", Stdout: ourInstall("v3.3.9")})
	obs := probeLiveArgoWorkloads(t.Context())
	if !obs.Answered {
		t.Fatalf("the stub answered, so the probe must be answered: %q", obs.Reason)
	}
	if strings.Join(obs.Versions, ",") != "v3.3.9" {
		t.Fatalf("versions = %v", obs.Versions)
	}
	for _, want := range []string{
		"-n argocd",
		"get statefulsets.apps,deployments.apps",
		"-l " + argoPartOfSelector,
		"-o json",
		"--request-timeout=",
	} {
		if !stub.calledWith(want) {
			t.Errorf("the probe must issue %q; calls were %v", want, stub.calls())
		}
	}
	// jsonpath is the thing this must NOT do: it cannot tell "nothing matched" from "the
	// expression was wrong".
	if stub.calledWith("jsonpath") {
		t.Errorf("the probe must ask with -o json, not a jsonpath: %v", stub.calls())
	}
}

func TestProbeLiveArgoWorkloadsOnAFailingKubectl(t *testing.T) {
	newKubectlStub(t, 1, stubRule{
		Match:  "get statefulsets.apps,deployments.apps",
		Stdout: "",
		Exit:   1,
	})
	obs := probeLiveArgoWorkloads(t.Context())
	if obs.Answered {
		t.Fatal("a non-zero kubectl must not be read as an answer")
	}
	if obs.Reason == "" {
		t.Fatal("a failed probe must say why")
	}
}

func TestPreflightLiveArgoVersionOnAFreshCluster(t *testing.T) {
	newKubectlStub(t, 0, stubRule{Match: "get statefulsets.apps,deployments.apps", Stdout: list()})
	var out bytes.Buffer
	if err := PreflightLiveArgoVersion(t.Context(), &out); err != nil {
		t.Fatalf("a fresh cluster must proceed, got: %v", err)
	}
	if !strings.Contains(out.String(), "no existing ArgoCD found") {
		t.Fatalf("a fresh cluster must say so: %s", out.String())
	}
}

func TestPreflightLiveArgoVersionRefusesABrokenLiveArgo(t *testing.T) {
	newKubectlStub(t, 0, stubRule{Match: "get statefulsets.apps,deployments.apps", Stdout: ourInstall("v3.1.8")})
	var out bytes.Buffer
	err := PreflightLiveArgoVersion(t.Context(), &out)
	if err == nil {
		t.Fatal("an ArgoCD below the measured floor must be refused")
	}
	// UNWRAPPED: a refusal that arrives dressed as "failed to install ArgoCD" gets read as a
	// broken chart and sends the operator to the wrong place.
	if !strings.HasPrefix(err.Error(), "refusing to install ArgoCD") {
		t.Fatalf("the refusal must arrive unwrapped and say it is a refusal, got: %v", err)
	}
	if !strings.Contains(err.Error(), "v3.1.8") {
		t.Fatalf("the refusal must name what it found: %v", err)
	}
}

func TestPreflightLiveArgoVersionSkipHatchSaysWhatWentUnverified(t *testing.T) {
	stub := newKubectlStub(t, 1) // any probe would FAIL, proving none was issued
	t.Setenv(SkipVersionPreflightEnv, "1")
	var out bytes.Buffer
	if err := PreflightLiveArgoVersion(t.Context(), &out); err != nil {
		t.Fatalf("the escape hatch must never refuse, got: %v", err)
	}
	if len(stub.calls()) != 0 {
		t.Fatalf("the escape hatch must issue no probe, got %v", stub.calls())
	}
	got := out.String()
	win, declared := compat.MustLoad().SupportedWindow("argocd")
	for _, want := range []string{"SKIPPED", "NOT VERIFIED", SkipVersionPreflightEnv, compat.SemverLabel(win.AppVersionMin, win.AppVersionMax)} {
		if !strings.Contains(got, want) {
			t.Errorf("the skip notice must contain %q, got: %s", want, got)
		}
	}
	if !declared {
		t.Fatal("the matrix declares no window, so this assertion proved nothing")
	}
}

// ── the version-literal guard ───────────────────────────────────────────────────────────────

// argoPreflightVersionLiteral matches a semantic version with or without the `v`. Three
// components, so a bare major.minor does not trip it.
var argoPreflightVersionLiteral = regexp.MustCompile(`\bv?\d+\.\d+\.\d+\b`)

// TestArgoPreflightEmitsNoHardcodedVersion mirrors test/e2e/argo_report_version_pure_test.go.
//
// The defect it prevents is the repo's own recurring class: a message that renders a stale fact
// and survives every check, because a string literal compiles, lints, passes gofmt and reads
// plausibly. Here it would be worse than a wrong report — a refusal naming a window that is not
// the window would block a deploy on a number nobody can trace. So the version can no longer be
// typed in this file at all: every version it prints is read from the cluster or from the matrix.
//
// Comments are deliberately out of scope: they are provenance, they cost a reader nothing when
// the pin moves, and stripping them would delete the record of where the mechanism came from.
func TestArgoPreflightEmitsNoHardcodedVersion(t *testing.T) {
	const name = "version_preflight.go"
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, name, nil, 0)
	if err != nil {
		// A guard that cannot read its subject has found NOTHING, not "nothing wrong".
		t.Fatalf("could not parse %s, so this guard proved nothing: %v", name, err)
	}
	literals := 0
	ast.Inspect(file, func(n ast.Node) bool {
		lit, ok := n.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return true
		}
		literals++
		value, uerr := strconv.Unquote(lit.Value)
		if uerr != nil {
			value = lit.Value
		}
		if m := argoPreflightVersionLiteral.FindString(value); m != "" {
			t.Errorf(`%s: the string literal %q hardcodes the version %q.
This check may only name a version it READ — from the cluster (classifyLiveArgoWorkloads) or from
the compatibility matrix (SupportedWindow / pinnedArgoAppVersion). A literal here survives a window
change and then refuses, or admits, on a number the matrix never said. Put provenance in a COMMENT.`,
				fset.Position(lit.Pos()), value, m)
		}
		return true
	})
	if literals == 0 {
		t.Fatalf("%s yielded ZERO string literals — the scan did not work, so its silence is not a pass", name)
	}
}
