// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
)

// The behaviour behind the org group's resolvers: the picker itself, the labels a person reads in
// it, the multi-step `grants add` form, and every arm where a list could not be fetched.
//
// hyg_cli_orgform_test.go holds the GUARDS — the spec-versus-tree and spec-versus-docs mirrors. This
// file drives the code those guards describe.

// ── the picker ──────────────────────────────────────────────────────────────────────────────────

// TestOrgSelect_PickerReturnsTheChosenOption drives the real Select the production code builds and
// asserts what came back, in both directions: the first option on a bare Enter, and the second
// after a Down.
//
// The option VALUE is the index, so a picker that returned the wrong entry is a wrong ID and a wrong
// SUMMARY together — both are asserted, because the summary is what a destructive command shows the
// operator before it acts.
func TestOrgSelect_PickerReturnsTheChosenOption(t *testing.T) {
	orgFormInteractive(t)
	choices := orgFormChoices()

	for _, tc := range []struct {
		name string
		keys []tea.KeyMsg
		want int
	}{
		{"the highlighted option", authFormKey(nil, tea.KeyEnter), 0},
		{"one below", authFormKey(nil, tea.KeyDown, tea.KeyEnter), 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			script := &authFormScript{keys: tc.keys}
			authFormAnswer(t, script)
			ref, err := pickOrgChoice(teamPickSpec, choices)
			if err != nil {
				t.Fatalf("pickOrgChoice: %v", err)
			}
			if !script.ran {
				t.Fatal("no form was opened")
			}
			if ref.ID != choices[tc.want].ID {
				t.Errorf("id = %q, want %q", ref.ID, choices[tc.want].ID)
			}
			if ref.Summary != choices[tc.want].Label {
				t.Errorf("summary = %q, want %q", ref.Summary, choices[tc.want].Label)
			}
		})
	}
}

// TestOrgSelect_PickerReportsAnAbandonedForm pins the arm where the person walks away: the resolver
// must report it, never silently resolve to the first option.
func TestOrgSelect_PickerReportsAnAbandonedForm(t *testing.T) {
	orgFormInteractive(t)
	boom := errors.New("the terminal went away")
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return boom }
	t.Cleanup(func() { runHuhForm = prev })

	ref, err := pickOrgChoice(teamPickSpec, orgFormChoices())
	if !errors.Is(err, boom) {
		t.Errorf("err = %v, want the form's error", err)
	}
	if ref.ID != "" {
		t.Errorf("an abandoned picker resolved to %q; nothing was chosen", ref.ID)
	}
}

// TestOrgSelect_GrantsRemovePicksFromTheOrgsGrants is the end-to-end shape: no id, a terminal, and
// the CLI resolves a grant, announces it, confirms, and deletes THAT one.
func TestOrgSelect_GrantsRemovePicksFromTheOrgsGrants(t *testing.T) {
	s, run := orgFormEnv(t, orgFormDefaultPayloads())
	orgFormInteractive(t)
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})
	prev := confirm
	confirm = func(string, string) bool { return true }
	t.Cleanup(func() { confirm = prev })

	code, out := run("grants", "remove", "--output", "json")
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n       said: %q", code, strings.TrimSpace(out))
	}
	if !s.saw(http.MethodDelete, "/api/cli/grants/"+orgFormGrantID) {
		t.Errorf("the picked grant was not revoked; requests = %v", s.requests)
	}
}

// ── the labels ──────────────────────────────────────────────────────────────────────────────────

// TestOrgSelect_LabelsReadAsSentences pins what a person sees in a picker.
//
// These are the only description of an entity the operator gets before a destructive command acts,
// so an empty field must render the shared sentinel rather than a gap, and a count must agree with
// its noun. Every case names the exact string; an "is not empty" assertion would pass for a label
// that had lost its most identifying half.
func TestOrgSelect_LabelsReadAsSentences(t *testing.T) {
	sep := " " + ui.SymbolBullet + " "

	t.Run("member", func(t *testing.T) {
		got := memberLabel(api.Member{Name: "Ada Lovelace", Email: "ada@x.com", Role: "owner", Status: "active"})
		want := strings.Join([]string{"Ada Lovelace", "ada@x.com", "owner", "active"}, sep)
		if got != want {
			t.Errorf("label = %q, want %q", got, want)
		}
		nameless := memberLabel(api.Member{Email: "ada@x.com", Role: "viewer", Status: "pending"})
		if !strings.HasPrefix(nameless, ui.SymbolDash+sep) {
			t.Errorf("a member with no name must open with the shared sentinel, got %q", nameless)
		}
	})

	t.Run("team", func(t *testing.T) {
		if got, want := teamLabel(api.Team{Name: "web", MemberCount: 1}), "web"+sep+"1 member"; got != want {
			t.Errorf("label = %q, want %q — one member is not \"1 members\"", got, want)
		}
		if got, want := teamLabel(api.Team{Name: "web", MemberCount: 0}), "web"+sep+"0 members"; got != want {
			t.Errorf("label = %q, want %q", got, want)
		}
	})

	t.Run("role", func(t *testing.T) {
		custom := roleLabel(api.Role{Name: "deployers", PermissionKeys: []string{"a:b"}})
		if custom != "deployers"+sep+"1 permission" {
			t.Errorf("label = %q", custom)
		}
		builtin := roleLabel(api.Role{Name: "owner", IsBuiltin: true, PermissionKeys: []string{"a:b", "c:d"}})
		if !strings.HasPrefix(builtin, "owner"+sep+"2 permissions") {
			t.Errorf("label = %q", builtin)
		}
		if !strings.Contains(builtin, ui.SymbolDefault) {
			t.Errorf("a built-in template must carry the brand marker so it reads as unlike the rest: %q", builtin)
		}
	})

	t.Run("grant", func(t *testing.T) {
		perm := grantLabel(api.Grant{
			Effect: "deny", PermissionKey: "project:destroy", ResourceType: "project",
			ResourceID: "p-1", PrincipalType: "team", PrincipalID: "0123456789abcdef",
		})
		want := strings.Join([]string{"deny", "project:destroy", "project (p-1)", "team 01234567…"}, sep)
		if perm != want {
			t.Errorf("label = %q, want %q", perm, want)
		}
		role := grantLabel(api.Grant{Effect: "allow", Role: "deployers", ResourceType: "org", PrincipalType: "user"})
		if !strings.Contains(role, "deployers") || strings.Contains(role, "(") {
			t.Errorf("an org-wide role grant reads %q; it must name the role and carry no resource id", role)
		}
		// A grant carries exactly one binding, so neither is a wire the CLI should render as blank.
		bare := grantLabel(api.Grant{Effect: "allow", ResourceType: "org", PrincipalType: "user"})
		if !strings.Contains(bare, ui.SymbolDash) {
			t.Errorf("a grant binding nothing must show the sentinel, got %q", bare)
		}
	})

	t.Run("sso provider", func(t *testing.T) {
		got := ssoLabel(api.SsoProvider{ProviderType: "saml", Domain: "", Issuer: "https://idp"})
		want := strings.Join([]string{"saml", ui.SymbolDash, "https://idp"}, sep)
		if got != want {
			t.Errorf("label = %q, want %q", got, want)
		}
	})
}

// ── the candidate lists ─────────────────────────────────────────────────────────────────────────

// orgSelectFailingClient fails every list call, so the arms below are driven by a real refusal.
type orgSelectFailingClient struct{ err error }

func (c orgSelectFailingClient) ListMembers(string) ([]api.Member, error)     { return nil, c.err }
func (c orgSelectFailingClient) ListTeams(string) ([]api.Team, error)         { return nil, c.err }
func (c orgSelectFailingClient) ListRoles() ([]api.Role, error)               { return nil, c.err }
func (c orgSelectFailingClient) ListGrants() ([]api.Grant, error)             { return nil, c.err }
func (c orgSelectFailingClient) ListSsoProviders() ([]api.SsoProvider, error) { return nil, c.err }
func (c orgSelectFailingClient) GetRunners() ([]api.Runner, error)            { return nil, c.err }
func (c orgSelectFailingClient) GetCloudIdentities() ([]api.CloudIdentity, error) {
	return nil, c.err
}
func (c orgSelectFailingClient) GetConfigurations() ([]types.ConfigurationSummary, error) {
	return nil, c.err
}

// TestOrgSelect_EveryListerReportsItsFailure pins the arm this package has got wrong before: a list
// that could not be READ must never be reported as a list that is EMPTY.
//
// Every closure is driven, and each must wrap the cause — an error naming only "no teams" sends the
// operator to look for a team that may well exist.
func TestOrgSelect_EveryListerReportsItsFailure(t *testing.T) {
	boom := errors.New("the control plane refused the read")
	c := orgSelectFailingClient{err: boom}
	for name, list := range map[string]func() ([]orgChoice, error){
		"members":         memberChoices(c, "o1"),
		"teams":           teamChoices(c, "o1"),
		"deletable roles": deletableRoleChoices(c),
		"bindable roles":  bindableRoleChoices(c),
		"grants":          grantChoices(c),
		"sso providers":   ssoChoices(c),
		"principals/user": grantPrincipalChoices(c, "o1", "user"),
		"principals/team": grantPrincipalChoices(c, "o1", "team"),
		"projects":        projectScopeChoices(c),
		"runners":         runnerScopeChoices(c),
		"cloud accounts":  cloudIdentityScopeChoices(c),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := list()
			if !errors.Is(err, boom) {
				t.Fatalf("err = %v, want the cause wrapped", err)
			}
			if len(got) != 0 {
				t.Errorf("a failed list returned %d choice(s)", len(got))
			}
		})
	}
}

// TestOrgSelect_PrincipalListDependsOnTheKind pins that `--principal-type team` offers TEAMS.
//
// It is the one place the same flag changes which endpoint is read, and the ids are different
// shapes — a user id and a team id — so getting it wrong writes a grant for a principal that does
// not exist.
func TestOrgSelect_PrincipalListDependsOnTheKind(t *testing.T) {
	c := orgSelectFixedClient{
		members: []api.Member{{ID: orgFormMemberID, UserID: orgFormUserID, Email: "ada@x.com"}},
		teams:   []api.Team{{ID: orgFormTeamID, Name: "platform"}},
	}
	users, err := grantPrincipalChoices(c, "o1", "user")()
	if err != nil || len(users) != 1 || users[0].ID != orgFormUserID {
		t.Fatalf("user principals = %v, %v; want the USER id", users, err)
	}
	teams, err := grantPrincipalChoices(c, "o1", "TEAM")()
	if err != nil || len(teams) != 1 || teams[0].ID != orgFormTeamID {
		t.Fatalf("team principals = %v, %v; the kind is matched case-insensitively", teams, err)
	}
}

// orgSelectFixedClient answers the list calls with fixed data.
type orgSelectFixedClient struct {
	members    []api.Member
	teams      []api.Team
	roles      []api.Role
	projects   []types.ConfigurationSummary
	runners    []api.Runner
	identities []api.CloudIdentity
}

func (c orgSelectFixedClient) ListMembers(string) ([]api.Member, error) { return c.members, nil }
func (c orgSelectFixedClient) ListTeams(string) ([]api.Team, error)     { return c.teams, nil }
func (c orgSelectFixedClient) ListRoles() ([]api.Role, error)           { return c.roles, nil }
func (c orgSelectFixedClient) GetRunners() ([]api.Runner, error)        { return c.runners, nil }
func (c orgSelectFixedClient) GetCloudIdentities() ([]api.CloudIdentity, error) {
	return c.identities, nil
}
func (c orgSelectFixedClient) GetConfigurations() ([]types.ConfigurationSummary, error) {
	return c.projects, nil
}

// ── the grants form ─────────────────────────────────────────────────────────────────────────────

// The scoped resources the grants form can bind to. Distinct from the org group's own fixture ids
// so an assertion that reads a project id where a team id belongs cannot pass.
const (
	orgSelectProjectID  = "55555555-5555-4555-8555-555555555555"
	orgSelectRunnerID   = "77777777-7777-4777-8777-777777777777"
	orgSelectIdentityID = "88888888-8888-4888-8888-888888888888"
)

// orgSelectGrantsClient is the whole surface promptGrantsAdd reads.
func orgSelectGrantsClient() orgSelectFixedClient {
	return orgSelectFixedClient{
		members: []api.Member{{ID: orgFormMemberID, UserID: orgFormUserID, Email: "ada@x.com", Name: "Ada"}},
		teams:   []api.Team{{ID: orgFormTeamID, Name: "platform", MemberCount: 2}},
		roles: []api.Role{
			{ID: orgFormOwnerID, Name: "owner", IsBuiltin: true, PermissionKeys: []string{"project:deploy", "member:view"}},
			{ID: orgFormRoleID, Name: "deployers", PermissionKeys: []string{"project:deploy"}},
		},
		projects: []types.ConfigurationSummary{{
			ID: orgSelectProjectID, ProjectName: "web", Region: "eu-central-1",
			CloudProvider: types.CloudProviderAws, EnvironmentStage: types.EnvironmentStageProduction,
		}},
		runners: []api.Runner{{
			ID: orgSelectRunnerID, Name: "prod", Operator: "managed", Status: "online", IsDefault: true,
		}},
		identities: []api.CloudIdentity{{ID: orgSelectIdentityID, Label: "prod-aws", Provider: "aws"}},
	}
}

// TestOrgSelect_GrantsFormBindsARole drives the whole multi-step form on the role branch and asserts
// EVERY field it wrote back.
//
// Five forms in order: the kind/effect/binding page, the principal picker, the role picker, the
// resource-KIND page, and the picker over that kind's live resources. Asserting only the role would
// pass for a form that had silently dropped the principal, which is the field that decides who the
// grant is for.
//
// The resource is chosen by moving DOWN once on the last page and NOT by typing: index 0 there is
// "every project", so an assertion that lands on the project id can only have come from reading the
// picker's answer.
func TestOrgSelect_GrantsFormBindsARole(t *testing.T) {
	orgFormInteractive(t)
	authFormAnswer(t,
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)},
		// The resource-kind page: org, project, runner, cloud_identity — one Down is `project`.
		&authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)},
	)

	got, err := promptGrantsAdd(orgSelectGrantsClient(), "o1", grantsAddAnswers{
		PrincipalType: "user", Effect: "allow", ResourceType: "org",
	})
	if err != nil {
		t.Fatalf("promptGrantsAdd: %v", err)
	}
	if got.Principal != orgFormUserID {
		t.Errorf("principal = %q, want the user id %q", got.Principal, orgFormUserID)
	}
	if got.RoleID != orgFormRoleID {
		t.Errorf("role = %q, want the SECOND role %q — the picker's answer is not being read", got.RoleID, orgFormRoleID)
	}
	if got.Permission != "" {
		t.Errorf("permission = %q; a role grant carries no permission key", got.Permission)
	}
	if got.ResourceType != "project" {
		t.Errorf("resource kind = %q, want %q", got.ResourceType, "project")
	}
	if got.ResourceID != orgSelectProjectID {
		t.Errorf("resource = %q, want the picked project %q — the id must come from the live list, "+
			"never from a box the operator typed a uuid into", got.ResourceID, orgSelectProjectID)
	}
}

// TestOrgSelect_GrantsFormPicksEachKindFromItsOwnLiveList is the unit's whole point, one kind at a
// time: choosing `project`, `runner` or `cloud_identity` offers THAT kind's live rows, and the id
// that comes back is the fixture's, which no stub and no typed value could have produced.
//
// The wrong-list failure is the one worth pinning. `resource_id` is `z.uuid()` on the wire, so a
// runner id posted against `resource_type: project` is accepted, stored, and expands into
// `project:<a runner id>` tuples — a scope that matches nothing, forever, with no error at any
// layer. Each case therefore asserts the id AND that it is not either of the other two.
func TestOrgSelect_GrantsFormPicksEachKindFromItsOwnLiveList(t *testing.T) {
	for _, tc := range []struct {
		kind  string
		downs int
		want  string
	}{
		{"project", 1, orgSelectProjectID},
		{"runner", 2, orgSelectRunnerID},
		{"cloud_identity", 3, orgSelectIdentityID},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			orgFormInteractive(t)
			kindKeys := authFormKey(nil)
			for i := 0; i < tc.downs; i++ {
				kindKeys = authFormKey(kindKeys, tea.KeyDown)
			}
			scripts := authFormAnswer(t,
				&authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)},
				&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
				&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
				&authFormScript{keys: authFormKey(kindKeys, tea.KeyEnter)},
				&authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)},
			)

			got, err := promptGrantsAdd(orgSelectGrantsClient(), "o1", grantsAddAnswers{
				PrincipalType: "user", Effect: "allow", ResourceType: "org",
			})
			if err != nil {
				t.Fatalf("promptGrantsAdd: %v", err)
			}
			if !scripts[4].ran {
				t.Fatal("no resource picker was opened; the kind was chosen and nothing asked which one")
			}
			if got.ResourceType != tc.kind {
				t.Fatalf("resource kind = %q, want %q", got.ResourceType, tc.kind)
			}
			if got.ResourceID != tc.want {
				t.Errorf("resource = %q, want %q — %s's picker is reading another kind's list",
					got.ResourceID, tc.want, tc.kind)
			}
			for _, other := range []string{orgSelectProjectID, orgSelectRunnerID, orgSelectIdentityID} {
				if other != tc.want && got.ResourceID == other {
					t.Errorf("resource = %q, which belongs to a DIFFERENT kind: the grant would scope "+
						"to %s:<an id of another type> and match nothing", got.ResourceID, tc.kind)
				}
			}
			if _, ok := grantResourceScope(orgSelectGrantsClient(), tc.kind); !ok {
				t.Errorf("%q reports no live list although the picker just used one", tc.kind)
			}
		})
	}
}

// TestOrgSelect_GrantsFormScopesToTheWholeKind pins the FIRST row of every scoped picker: the grant
// covers the kind, not one thing.
//
// It is what `--resource-type project` with no `--resource` already meant, so a picker that offered
// instances alone would be a narrower command than the typed-id box it replaces — and an operator
// who wanted "every project" would have no key to press.
func TestOrgSelect_GrantsFormScopesToTheWholeKind(t *testing.T) {
	orgFormInteractive(t)
	authFormAnswer(t,
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
	)

	got, err := promptGrantsAdd(orgSelectGrantsClient(), "o1", grantsAddAnswers{
		PrincipalType: "user", Effect: "allow", ResourceType: "org", ResourceID: orgSelectRunnerID,
	})
	if err != nil {
		t.Fatalf("promptGrantsAdd: %v", err)
	}
	if got.ResourceType != "project" {
		t.Fatalf("resource kind = %q, want %q", got.ResourceType, "project")
	}
	if got.ResourceID != "" {
		t.Errorf("resource = %q, want empty — the first row scopes to every project, and the id the "+
			"flags carried must not survive it", got.ResourceID)
	}
	if want := "Every project in this organization"; grantWholeKindChoice(
		grantResourceKind{Noun: "project"})[0].Label != want {
		t.Errorf("the whole-kind row reads %q, want %q",
			grantWholeKindChoice(grantResourceKind{Noun: "project"})[0].Label, want)
	}
}

// TestOrgSelect_GrantsFormAsksNoResourceForTheOrgKind pins the kind that takes no id at all.
//
// `resource_type: "org"` is org-wide BY CONSTRUCTION: apps/console/lib/authz/fga-tuples.ts computes
// `orgWide = resourceId === null || resourceType === "org"` before it expands anything, so an id
// stored against it reaches no tuple. The form used to accept one — a question whose answer could
// not matter, in the exact silent class this unit exists to close — so it now asks nothing, and any
// id the flags carried is cleared rather than posted.
func TestOrgSelect_GrantsFormAsksNoResourceForTheOrgKind(t *testing.T) {
	orgFormInteractive(t)
	scripts := authFormAnswer(t,
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
	)

	got, err := promptGrantsAdd(orgSelectGrantsClient(), "o1", grantsAddAnswers{
		PrincipalType: "user", Effect: "allow", ResourceType: "org", ResourceID: orgSelectProjectID,
	})
	if err != nil {
		t.Fatalf("promptGrantsAdd: %v", err)
	}
	if got.ResourceType != grantResourceTypeOrg {
		t.Fatalf("resource kind = %q, want %q", got.ResourceType, grantResourceTypeOrg)
	}
	if got.ResourceID != "" {
		t.Errorf("resource = %q; an id under the org kind is written to the row and then ignored by "+
			"every tuple the grant syncs, so it must not be carried", got.ResourceID)
	}
	if scripts[3].state != huh.StateCompleted {
		t.Errorf("the resource-kind page ended in state %v, want completed", scripts[3].state)
	}
}

// TestOrgSelect_GrantsFormTypesTheIDForAKindItCannotList pins the fallback arm, and it is a real
// arm rather than a defensive one: `resource_type` is `z.string().min(1)` on the wire, so a kind
// added to grantResourceTypeSuggestions before its arm reaches grantResourceScope has to stay
// askable — a form that could only offer what it can list would REMOVE a grant the server accepts.
//
// `connector` is that shape today: an instance type in apps/console/lib/authz/fga-hierarchy.ts that
// neither list knows about.
func TestOrgSelect_GrantsFormTypesTheIDForAKindItCannotList(t *testing.T) {
	orgFormInteractive(t)
	if _, ok := grantResourceScope(orgSelectGrantsClient(), "connector"); ok {
		t.Skip("connector has gained a live list; pick another unlisted kind for this arm")
	}
	script := &authFormScript{keys: append(authFormType("  "+orgSelectIdentityID+"  "),
		tea.KeyMsg{Type: tea.KeyEnter})}
	authFormAnswer(t, script)

	got, err := promptGrantResource(orgSelectGrantsClient(), grantsAddAnswers{ResourceType: "connector"})
	if err != nil {
		t.Fatalf("promptGrantResource: %v", err)
	}
	if !script.ran {
		t.Fatal("no form was opened; a kind with no list became unaskable")
	}
	if got.ResourceID != orgSelectIdentityID {
		t.Errorf("resource = %q, want %q — the typed id must be trimmed, or it goes to the server padded",
			got.ResourceID, orgSelectIdentityID)
	}
}

// TestOrgSelect_EverySuggestedKindIsListable is the guard the fallback above leans on: every kind
// the resource-KIND picker offers, other than org, must have an arm in grantResourceScope.
//
// Without it the two declarations drift silently and the picker quietly degrades back into the
// typed-id box this unit removed — which is a regression nothing else in the suite can see, because
// typing an id still works.
func TestOrgSelect_EverySuggestedKindIsListable(t *testing.T) {
	c := orgSelectGrantsClient()
	for _, kind := range grantResourceTypeSuggestions {
		if kind == grantResourceTypeOrg {
			continue
		}
		got, ok := grantResourceScope(c, kind)
		if !ok {
			t.Errorf("%q is offered by the resource-kind picker with no live list behind it; add an "+
				"arm to grantResourceScope or stop suggesting it", kind)
			continue
		}
		if got.Noun == "" || got.ListCmd == "" || got.List == nil {
			t.Errorf("%q resolves to %+v; a kind needs a noun, the command that shows the same rows, "+
				"and the list itself", kind, got)
		}
		rows, err := got.List()
		if err != nil || len(rows) == 0 {
			t.Errorf("%q listed %d row(s), err = %v; the fixture answers all three lists", kind, len(rows), err)
		}
	}
}

// TestOrgSelect_GrantsFormReportsAResourceListItCouldNotRead pins the arm this package has got
// wrong before, on the newest list: a list that could not be READ must stop the form, never read as
// an org-wide grant the operator did not ask for.
func TestOrgSelect_GrantsFormReportsAResourceListItCouldNotRead(t *testing.T) {
	orgFormInteractive(t)
	boom := errors.New("the control plane refused the read")
	authFormNoForm(t)

	got, err := promptGrantResource(orgSelectFailingClient{err: boom},
		grantsAddAnswers{ResourceType: "project", ResourceID: orgSelectProjectID})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the cause wrapped", err)
	}
	if got.ResourceID != orgSelectProjectID {
		t.Errorf("a failed list rewrote the resource to %q; the answers must come back untouched",
			got.ResourceID)
	}
}

// TestOrgSelect_ScopeLabelsReadAsSentences pins what a person sees in the resource picker.
//
// A project NAME does not identify a project — two may share one (#3145) — so the provider, region
// and stage are on the line, and an empty identifying field renders the shared sentinel rather than
// a gap. Each case names the exact string: "is not empty" would pass for a label that had lost the
// half that tells two rows apart.
func TestOrgSelect_ScopeLabelsReadAsSentences(t *testing.T) {
	sep := " " + ui.SymbolBullet + " "

	t.Run("project", func(t *testing.T) {
		got := projectScopeLabel(types.ConfigurationSummary{
			ProjectName: "web", Region: "eu-central-1",
			CloudProvider: types.CloudProviderAws, EnvironmentStage: types.EnvironmentStageProduction,
		})
		want := strings.Join([]string{"web", "aws", "eu-central-1", "production"}, sep)
		if got != want {
			t.Errorf("label = %q, want %q", got, want)
		}
		if nameless := projectScopeLabel(types.ConfigurationSummary{Region: "eu-west-1"}); !strings.HasPrefix(nameless, ui.SymbolDash+sep) {
			t.Errorf("a nameless project renders %q; want the shared sentinel, not a gap", nameless)
		}
	})

	t.Run("runner", func(t *testing.T) {
		got := runnerScopeLabel(api.Runner{Name: "prod", Operator: "managed", Status: "online"})
		want := strings.Join([]string{"prod", "managed", "online"}, sep)
		if got != want {
			t.Errorf("label = %q, want %q", got, want)
		}
		marked := runnerScopeLabel(api.Runner{Name: "prod", Operator: "managed", Status: "online", IsDefault: true})
		if marked != want+ui.DefaultBadge() {
			t.Errorf("the org default renders %q, want %q", marked, want+ui.DefaultBadge())
		}
	})

	t.Run("cloud account", func(t *testing.T) {
		got := cloudIdentityScopeLabel(api.CloudIdentity{Label: "prod-aws", Provider: "aws"})
		if want := "prod-aws" + sep + "aws"; got != want {
			t.Errorf("label = %q, want %q", got, want)
		}
		if unlabelled := cloudIdentityScopeLabel(api.CloudIdentity{Provider: "gcp"}); unlabelled != ui.SymbolDash+sep+"gcp" {
			t.Errorf("an unlabelled account renders %q; want the shared sentinel", unlabelled)
		}
	})
}

// TestOrgSelect_ResourcePickSpecIsBuiltFromTheField pins that the resource picker's wording comes
// from the ONE spec entry, not from a second sentence written beside the widget: the form, the
// refusal and the docs table are all renderings of orgFields, and a hand-typed title here is how
// they come apart.
func TestOrgSelect_ResourcePickSpecIsBuiltFromTheField(t *testing.T) {
	field := mustOrgField("alethia grants add", orgFieldKeyResource)
	spec := grantResourcePickSpec(grantResourceKind{Noun: "runner", ListCmd: "alethia runner list"})
	if spec.Field.Title != field.Title || spec.Field.Description != field.Description {
		t.Errorf("the picker asks %q/%q; the spec says %q/%q",
			spec.Field.Title, spec.Field.Description, field.Title, field.Description)
	}
	if spec.Noun != "runner" || spec.ListCmd != "alethia runner list" {
		t.Errorf("spec = %+v; the noun and the list command come from the kind", spec)
	}
	if !strings.Contains(spec.Empty, "runners") {
		t.Errorf("the empty sentence %q does not name the kind", spec.Empty)
	}
}

// TestOrgSelect_GrantsFormBindsAPermission drives the other branch, and pins that choosing a
// permission CLEARS any role the flags carried — a grant binds exactly one, and the server refuses
// both.
func TestOrgSelect_GrantsFormBindsAPermission(t *testing.T) {
	orgFormInteractive(t)
	authFormAnswer(t,
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
	)

	got, err := promptGrantsAdd(orgSelectGrantsClient(), "o1", grantsAddAnswers{
		PrincipalType: "team", Effect: "deny", RoleID: orgFormRoleID, Permission: "member:view",
		ResourceType: "org",
	})
	if err != nil {
		t.Fatalf("promptGrantsAdd: %v", err)
	}
	if got.RoleID != "" {
		t.Errorf("role = %q; choosing a permission must clear it, or the server refuses the pair", got.RoleID)
	}
	// The catalog is sorted, so the highlighted option is member:view.
	if got.Permission != "member:view" {
		t.Errorf("permission = %q, want %q", got.Permission, "member:view")
	}
	if got.Principal != orgFormTeamID {
		t.Errorf("principal = %q, want the TEAM id %q", got.Principal, orgFormTeamID)
	}
}

// TestOrgSelect_GrantsFormReportsWhatItCouldNotAsk walks the arms where the form cannot continue.
// Each returns an error rather than a half-filled grant, and the answers it was given come back
// unchanged so a caller cannot mistake them for a completed form.
func TestOrgSelect_GrantsFormReportsWhatItCouldNotAsk(t *testing.T) {
	base := grantsAddAnswers{PrincipalType: "user", Effect: "allow", ResourceType: "org"}

	t.Run("the first page is abandoned", func(t *testing.T) {
		orgFormInteractive(t)
		boom := errors.New("terminal closed")
		prev := runHuhForm
		runHuhForm = func(...*huh.Group) error { return boom }
		t.Cleanup(func() { runHuhForm = prev })
		if _, err := promptGrantsAdd(orgSelectGrantsClient(), "o1", base); !errors.Is(err, boom) {
			t.Errorf("err = %v, want the form's error", err)
		}
	})

	t.Run("there is nobody to grant access to", func(t *testing.T) {
		orgFormInteractive(t)
		authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)})
		_, err := promptGrantsAdd(orgSelectFixedClient{}, "o1", base)
		if err == nil || !strings.Contains(err.Error(), grantPrincipalPickSpec.Empty) {
			t.Errorf("err = %v, want %q", err, grantPrincipalPickSpec.Empty)
		}
	})

	t.Run("there is no role to bind", func(t *testing.T) {
		orgFormInteractive(t)
		authFormAnswer(t,
			&authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)},
			&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		)
		c := orgSelectFixedClient{members: []api.Member{{UserID: orgFormUserID, Email: "ada@x.com"}}}
		_, err := promptGrantsAdd(c, "o1", base)
		if err == nil || !strings.Contains(err.Error(), grantRolePickSpec.Empty) {
			t.Errorf("err = %v, want %q", err, grantRolePickSpec.Empty)
		}
	})

	t.Run("there is no permission catalog", func(t *testing.T) {
		orgFormInteractive(t)
		authFormAnswer(t,
			&authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)},
			&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		)
		c := orgSelectFixedClient{
			members: []api.Member{{UserID: orgFormUserID, Email: "ada@x.com"}},
			roles:   []api.Role{{ID: orgFormOwnerID, Name: "owner", IsBuiltin: true}},
		}
		_, err := promptGrantsAdd(c, "o1", grantsAddAnswers{
			PrincipalType: "user", Effect: "allow", ResourceType: "org", Permission: "member:view",
		})
		if !errors.Is(err, errNoPermissionCatalog) {
			t.Errorf("err = %v, want the empty-catalog refusal", err)
		}
	})

	t.Run("the roles call fails", func(t *testing.T) {
		orgFormInteractive(t)
		authFormAnswer(t,
			&authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)},
			&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		)
		boom := errors.New("roles unreadable")
		c := orgSelectHalfClient{
			members:  []api.Member{{UserID: orgFormUserID, Email: "ada@x.com"}},
			rolesErr: boom,
		}
		if _, err := promptGrantsAdd(c, "o1", base); !errors.Is(err, boom) {
			t.Errorf("err = %v, want the roles error", err)
		}
	})

}

// orgSelectHalfClient answers members and teams and fails the roles call.
type orgSelectHalfClient struct {
	members  []api.Member
	teams    []api.Team
	rolesErr error
}

func (c orgSelectHalfClient) ListMembers(string) ([]api.Member, error) { return c.members, nil }
func (c orgSelectHalfClient) ListTeams(string) ([]api.Team, error)     { return c.teams, nil }
func (c orgSelectHalfClient) ListRoles() ([]api.Role, error)           { return nil, c.rolesErr }
func (c orgSelectHalfClient) GetRunners() ([]api.Runner, error)        { return nil, nil }
func (c orgSelectHalfClient) GetCloudIdentities() ([]api.CloudIdentity, error) {
	return nil, nil
}
func (c orgSelectHalfClient) GetConfigurations() ([]types.ConfigurationSummary, error) {
	return nil, nil
}

// TestOrgSelect_RoleOptionsKeepTheCallersOwnValue pins the arm where --role already names one of the
// org's roles: it must be offered ONCE, not prepended a second time.
func TestOrgSelect_RoleOptionsKeepTheCallersOwnValue(t *testing.T) {
	roles := []api.Role{{Name: "owner", IsBuiltin: true}, {Name: "deployers"}}

	known := roleOptions(roles, "deployers")
	if len(known) != 2 {
		t.Errorf("a role the org already has must not be offered twice; got %d options", len(known))
	}
	unknown := roleOptions(roles, "member")
	if len(unknown) != 3 || unknown[0].Value != "member" {
		t.Errorf("the caller's own default must be offered FIRST even when the org has no such role; got %v",
			unknown)
	}
	if len(roleOptions(roles, "")) != 2 {
		t.Error("an empty current value adds no option")
	}
}

// TestOrgSelect_StringOptionsAreValueLabelled pins the closed-set option builder: the label a person
// reads IS the value that is sent, so a picker cannot show one thing and post another.
func TestOrgSelect_StringOptionsAreValueLabelled(t *testing.T) {
	got := stringOptions(grantEffects)
	if len(got) != len(grantEffects) {
		t.Fatalf("%d options for %d values", len(got), len(grantEffects))
	}
	for i, o := range got {
		if o.Value != grantEffects[i] || o.Key != grantEffects[i] {
			t.Errorf("option %d = %q/%q, want both %q", i, o.Key, o.Value, grantEffects[i])
		}
	}
}

// ── grants add, through the real command ────────────────────────────────────────────────────────

// TestOrgSelect_GrantsAddRefusesAValueOutsideTheRouteEnums drives the two closed-set arms through
// the real cobra tree, and asserts NOTHING was sent — a refusal that still posts is not a refusal.
func TestOrgSelect_GrantsAddRefusesAValueOutsideTheRouteEnums(t *testing.T) {
	for name, args := range map[string][]string{
		"principal kind": {"grants", "add", "--principal", orgFormUserID, "--role", orgFormRoleID,
			"--principal-type", "service"},
		"effect": {"grants", "add", "--principal", orgFormUserID, "--role", orgFormRoleID,
			"--effect", "audit"},
	} {
		t.Run(name, func(t *testing.T) {
			s, run := orgFormEnv(t, orgFormDefaultPayloads())
			code, out := run(append(args, "--no-input")...)
			if code == 0 {
				t.Fatalf("exit = 0 for a value the route's z.enum refuses")
			}
			if muts := s.mutations(); len(muts) > 0 {
				t.Errorf("a refused grant still reached the control plane: %v", muts)
			}
			if !strings.Contains(out, "is not one of") {
				t.Errorf("the refusal does not say what the allowed values are:\n       %q", strings.TrimSpace(out))
			}
		})
	}
}

// TestOrgSelect_GrantsAddRefusesAnIDTheOrgKindWouldIgnore pins the headless half of the same rule
// the form now enforces by asking nothing: `--resource` with `--resource-type org` is refused, and
// NOTHING is sent.
//
// The control plane computes `orgWide = resourceId === null || resourceType === "org"`
// (apps/console/lib/authz/fga-tuples.ts) before it expands a tuple, so accepting the pair posts a
// grant over the WHOLE organization while the command line reads as one resource. `org` is also the
// default kind, so the case that matters is `--resource <id>` with no `--resource-type` at all —
// which is why that arm is driven here too, and why the refusal names the id it was given.
func TestOrgSelect_GrantsAddRefusesAnIDTheOrgKindWouldIgnore(t *testing.T) {
	for name, args := range map[string][]string{
		"the kind is named": {"grants", "add", "--principal", orgFormUserID, "--role", orgFormRoleID,
			"--resource-type", "org", "--resource", orgSelectProjectID},
		"the kind is left at its default": {"grants", "add", "--principal", orgFormUserID,
			"--role", orgFormRoleID, "--resource", orgSelectProjectID},
	} {
		t.Run(name, func(t *testing.T) {
			s, run := orgFormEnv(t, orgFormDefaultPayloads())
			code, out := run(append(args, "--no-input", "--output", "json")...)
			if code == 0 {
				t.Fatalf("exit = 0; the id would be stored and ignored\n       said: %q", strings.TrimSpace(out))
			}
			if !strings.Contains(out, orgSelectProjectID) {
				t.Errorf("the refusal does not name the id it was given:\n       %q", strings.TrimSpace(out))
			}
			if !strings.Contains(out, "org-wide") {
				t.Errorf("the refusal does not say WHY the id cannot apply:\n       %q", strings.TrimSpace(out))
			}
			if muts := s.mutations(); len(muts) > 0 {
				t.Errorf("a grant was sent although the pair was refused: %v", muts)
			}
		})
	}

	t.Run("a scoped kind is untouched", func(t *testing.T) {
		s, run := orgFormEnv(t, orgFormDefaultPayloads())
		code, out := run("grants", "add", "--principal", orgFormUserID, "--role", orgFormRoleID,
			"--resource-type", "project", "--resource", orgSelectProjectID, "--no-input", "--output", "json")
		if code != 0 {
			t.Fatalf("exit = %d; a scoped kind takes an id\n       said: %q", code, strings.TrimSpace(out))
		}
		if muts := s.mutations(); len(muts) != 1 {
			t.Errorf("mutations = %v, want the one POST", muts)
		}
	})
}

// TestOrgSelect_GrantsAddReportsAServerRefusal pins that a control plane saying no is fatal, not a
// success message printed over a 500.
func TestOrgSelect_GrantsAddReportsAServerRefusal(t *testing.T) {
	s, run := orgFormEnv(t, orgFormDefaultPayloads())
	s.fail(http.MethodPost, "/api/cli/grants")
	code, out := run("grants", "add", "--principal", orgFormUserID, "--role", orgFormRoleID,
		"--no-input", "--output", "json")
	if code == 0 {
		t.Fatalf("exit = 0 although the grant was refused\n       said: %q", strings.TrimSpace(out))
	}
}

// TestOrgSelect_GrantsAddNeedsAnOrgOnlyToLookOneUp pins the lazy org resolution.
//
// A grant whose principal and role are already ids needs no member list, so a CLI that resolved the
// active org eagerly would refuse a perfectly complete command in community scope. The same command
// with an EMAIL must then report the missing org, because that lookup genuinely needs it.
func TestOrgSelect_GrantsAddNeedsAnOrgOnlyToLookOneUp(t *testing.T) {
	s, run := orgFormEnv(t, orgFormDefaultPayloads())
	orgSelectClearActiveOrg(t)

	code, out := run("grants", "add", "--principal", orgFormUserID, "--role", orgFormRoleID,
		"--no-input", "--output", "json")
	if code != 0 {
		t.Fatalf("a fully-identified grant must not need an active org; exit = %d, said %q",
			code, strings.TrimSpace(out))
	}
	if !s.saw(http.MethodPost, "/api/cli/grants") {
		t.Errorf("the grant was not sent; requests = %v", s.requests)
	}

	s.forget()
	code, out = run("grants", "add", "--principal", "ada@example.com", "--role", orgFormRoleID,
		"--no-input", "--output", "json")
	if code == 0 {
		t.Fatalf("an email needs a member list, which needs an org; exit = 0")
	}
	if !strings.Contains(out, "org switch") {
		t.Errorf("the refusal does not say how to get an active org:\n       %q", strings.TrimSpace(out))
	}
	if muts := s.mutations(); len(muts) > 0 {
		t.Errorf("a grant was sent with an unresolved principal: %v", muts)
	}
}

// orgSelectFailOnForm makes the Nth runHuhForm call fail and every earlier one succeed, so a
// multi-step form's LATER abandonment arms can each be driven on their own.
//
// A stub that failed the first call would only ever reach the first arm, which is how a form's
// second and third pages end up with no test at all.
func orgSelectFailOnForm(t *testing.T, n int, err error) {
	t.Helper()
	prev := runHuhForm
	calls := 0
	runHuhForm = func(...*huh.Group) error {
		calls++
		if calls == n {
			return err
		}
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// TestOrgSelect_EveryPromptReportsAnAbandonedForm walks the abandonment arm of every prompt in the
// group, including the later pages of `grants add`.
//
// A form the operator walks away from must produce an error and no value. Returning nil with an
// empty answer is the failure worth pinning: `teams create` would post an unnamed team, and
// `grants add` a grant bound to nothing.
func TestOrgSelect_EveryPromptReportsAnAbandonedForm(t *testing.T) {
	boom := errors.New("the terminal went away")
	client := orgSelectGrantsClient()

	t.Run("members add", func(t *testing.T) {
		orgFormInteractive(t)
		orgSelectFailOnForm(t, 1, boom)
		if _, _, err := promptMembersAdd(client, "", "member", true); !errors.Is(err, boom) {
			t.Errorf("err = %v, want the form's error", err)
		}
	})
	t.Run("teams create", func(t *testing.T) {
		orgFormInteractive(t)
		orgSelectFailOnForm(t, 1, boom)
		if _, err := promptName("alethia teams create", orgFieldKeyName); !errors.Is(err, boom) {
			t.Errorf("err = %v, want the form's error", err)
		}
	})
	t.Run("roles create permissions", func(t *testing.T) {
		orgFormInteractive(t)
		orgSelectFailOnForm(t, 1, boom)
		if _, err := promptRolePermissions(client, nil); !errors.Is(err, boom) {
			t.Errorf("err = %v, want the form's error", err)
		}
	})
	// The typed-id fallback is the one grants-add page promptGrantsAdd cannot reach on its own —
	// its resource-KIND picker can only write back a kind grantResourceScope knows — so it is
	// abandoned here directly, on the kind that has no live list.
	t.Run("grants add · the typed-id fallback", func(t *testing.T) {
		orgFormInteractive(t)
		orgSelectFailOnForm(t, 1, boom)
		got, err := promptGrantResource(client, grantsAddAnswers{
			ResourceType: "connector", ResourceID: orgSelectProjectID})
		if !errors.Is(err, boom) {
			t.Errorf("err = %v, want the form's error", err)
		}
		if got.ResourceID != orgSelectProjectID {
			t.Errorf("an abandoned input rewrote the resource to %q", got.ResourceID)
		}
	})

	// The grants form's pages, one at a time. Page 2 is the principal picker, page 3 the binding,
	// page 4 the resource KIND and page 5 the picker over that kind's live resources; each must stop
	// the form rather than carry an empty answer forward.
	for name, tc := range map[string]struct {
		page int
		in   grantsAddAnswers
	}{
		"grants add · the role picker":     {3, grantsAddAnswers{PrincipalType: "user", Effect: "allow", ResourceType: "org"}},
		"grants add · the permission list": {3, grantsAddAnswers{PrincipalType: "user", Effect: "allow", ResourceType: "org", Permission: "member:view"}},
		"grants add · the resource kind":   {4, grantsAddAnswers{PrincipalType: "user", Effect: "allow", ResourceType: "org"}},
		// Page 5 exists only once a SCOPED kind is chosen. The stub answers no form, so the kind
		// the caller carried survives page 4 and the picker over that kind's live rows opens.
		"grants add · the resource picker": {5, grantsAddAnswers{PrincipalType: "user", Effect: "allow", ResourceType: "project"}},
	} {
		t.Run(name, func(t *testing.T) {
			orgFormInteractive(t)
			orgSelectFailOnForm(t, tc.page, boom)
			if _, err := promptGrantsAdd(client, "o1", tc.in); !errors.Is(err, boom) {
				t.Errorf("err = %v, want the form's error", err)
			}
		})
	}
}

// TestOrgSelect_ResolveByNameOrIDReportsAnEmptyList pins the arm where the lookup has nothing to
// look through: the spec's own sentence, not a bare "not found" that reads as a typo.
func TestOrgSelect_ResolveByNameOrIDReportsAnEmptyList(t *testing.T) {
	_, err := resolveByNameOrID(grantRolePickSpec, "deployers", func() ([]orgChoice, error) { return nil, nil })
	if err == nil || err.Error() != grantRolePickSpec.Empty {
		t.Errorf("err = %v, want %q", err, grantRolePickSpec.Empty)
	}
}

// TestOrgSelect_MustOrgFieldPanicsOnAMiss pins the deliberate panic.
//
// Both arguments are constants in this package, so a miss is a programming error — and the
// alternative, a zero orgField, is a form that opens with an empty title and asks the user for
// something unnamed. The message must name both, because that is all the person debugging it gets.
func TestOrgSelect_MustOrgFieldPanicsOnAMiss(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("a missing field returned a zero orgField instead of panicking; the form would " +
				"have opened with no title")
		}
		msg, _ := r.(string)
		for _, want := range []string{"alethia teams delete", "nonesuch", "org_fields.go"} {
			if !strings.Contains(msg, want) {
				t.Errorf("the panic does not name %q: %v", want, r)
			}
		}
	}()
	mustOrgField("alethia teams delete", "nonesuch")
}

// TestOrgSelect_RolesCreateReportsAServerRefusal pins the two arms `roles create` adds: a control
// plane that refuses is fatal, and a permission catalog that cannot be read stops the command
// rather than creating a role with none.
func TestOrgSelect_RolesCreateReportsAServerRefusal(t *testing.T) {
	t.Run("the create is refused", func(t *testing.T) {
		s, run := orgFormEnv(t, orgFormDefaultPayloads())
		s.fail(http.MethodPost, "/api/cli/roles")
		code, out := run("roles", "create", "deployers", "--permission", "project:deploy",
			"--no-input", "--output", "json")
		if code == 0 {
			t.Fatalf("exit = 0 although the role was refused\n       said: %q", strings.TrimSpace(out))
		}
	})

	t.Run("the catalog cannot be read", func(t *testing.T) {
		s, run := orgFormEnv(t, orgFormDefaultPayloads())
		s.fail(http.MethodGet, "/api/cli/roles")
		orgFormInteractive(t)
		code, out := run("roles", "create", "deployers", "--output", "json")
		if code == 0 {
			t.Fatalf("exit = 0 although the permission catalog was unreadable\n       said: %q",
				strings.TrimSpace(out))
		}
		if muts := s.mutations(); len(muts) > 0 {
			t.Errorf("a role was created without the permissions the operator was never shown: %v", muts)
		}
	})
}

// TestOrgSelect_GrantsAddFormNeedsAnActiveOrg pins the last of the lazy-org arms: with nothing to
// resolve against AND nothing named, the command reports the missing org instead of opening a form
// it cannot fill.
func TestOrgSelect_GrantsAddFormNeedsAnActiveOrg(t *testing.T) {
	s, run := orgFormEnv(t, orgFormDefaultPayloads())
	orgSelectClearActiveOrg(t)
	orgFormInteractive(t)

	code, out := run("grants", "add", "--output", "json")
	if code == 0 {
		t.Fatalf("exit = 0 with no principal and no org to pick one from\n       said: %q", strings.TrimSpace(out))
	}
	if !strings.Contains(out, "org switch") {
		t.Errorf("the refusal does not say how to get an active org:\n       %q", strings.TrimSpace(out))
	}
	if muts := s.mutations(); len(muts) > 0 {
		t.Errorf("a grant was sent: %v", muts)
	}
}

// TestOrgSelect_ForeignOrgInviteAsksInsteadOfListing pins the BEHAVIOUR behind promptMembersAdd's
// offerOrgRoles argument, in both directions.
//
// `GET /api/cli/roles` is scoped by the X-Alethia-Org header. When that header names a different
// org from the one the invitation lands in, a role picker filled from that call names roles that do
// not exist where the invitation goes — and `role` is a free string on the wire, so nothing
// downstream would object. Withholding the list and asking is the only honest answer.
//
// Since #3817 the caller passes true: `--org` is a root persistent flag that sets the header and the
// members path from ONE value, so the two can no longer disagree. The false arm is kept and driven
// here anyway, because it is the property the argument exists to carry — if a future scope reaches
// the path without reaching the header, this is the behaviour that has to come back, and a
// deleted-because-unreached branch is one nobody would think to restore.
func TestOrgSelect_ForeignOrgInviteAsksInsteadOfListing(t *testing.T) {
	t.Run("the active org is offered its own roles", func(t *testing.T) {
		orgFormInteractive(t)
		c := &orgSelectCountingRoles{roles: orgSelectGrantsClient().roles}
		authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})
		_, role, err := promptMembersAdd(c, "ada@x.com", "owner", true)
		if err != nil {
			t.Fatalf("promptMembersAdd: %v", err)
		}
		if c.calls != 1 {
			t.Errorf("the roles list was fetched %d time(s), want 1", c.calls)
		}
		if role != "owner" {
			t.Errorf("role = %q, want the picked option", role)
		}
	})

	t.Run("a foreign org is asked, never offered a list it cannot vouch for", func(t *testing.T) {
		orgFormInteractive(t)
		c := &orgSelectCountingRoles{roles: orgSelectGrantsClient().roles}
		keys := append(authFormClear(), authFormType("  their-role  ")...)
		keys = authFormKey(keys, tea.KeyEnter)
		authFormAnswer(t, &authFormScript{keys: keys})

		_, role, err := promptMembersAdd(c, "ada@x.com", "member", false)
		if err != nil {
			t.Fatalf("promptMembersAdd: %v", err)
		}
		if c.calls != 0 {
			t.Errorf("the ACTIVE org's roles were fetched %d time(s) for an invitation into another org", c.calls)
		}
		if role != "their-role" {
			t.Errorf("role = %q, want the typed answer, trimmed", role)
		}
	})
}

// orgSelectCountingRoles records how many times the roles list was read.
type orgSelectCountingRoles struct {
	roles []api.Role
	calls int
}

func (c *orgSelectCountingRoles) ListRoles() ([]api.Role, error) {
	c.calls++
	return c.roles, nil
}
