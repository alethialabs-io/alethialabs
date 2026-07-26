// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

// SubnetMeta is the minimal subnet metadata the AWS brownfield classifier needs — an id
// and whether the subnet auto-assigns public IPs (EC2 MapPublicIpOnLaunch). Kept free of
// the AWS SDK so the selection logic is a pure, unit-testable function.
type SubnetMeta struct {
	ID     string
	Public bool
}

// SelectBrownfieldSubnets partitions an existing VPC's subnets into the (private, public)
// tfvar lists the AWS template consumes, honoring an explicit user selection when present
// (#1352). Unlike GCP/Azure/Alibaba — whose templates take a single subnet var — AWS needs
// the public/private split, which only the live subnet metadata provides, so the selection
// is applied here rather than as a static tfvar.
//
//   - selected empty  → use every discovered subnet (today's auto-discover behaviour).
//   - selected present → keep only the chosen ids, in the user's chosen order; a selected id
//     not present among the discovered subnets is dropped.
//   - if that leaves nothing classifiable but a selection exists (discovery failed or matched
//     no ids), fall back to the raw selection in BOTH lists — unclassified is still better
//     than the template's `[""]` default, which fails at apply, not plan.
//
// The empty-side-mirrors-the-other guard preserves the pre-existing behaviour so a VPC with
// only public (or only private) subnets still fills both lists.
func SelectBrownfieldSubnets(discovered []SubnetMeta, selected []string) (private, public []string) {
	use := discovered
	if len(selected) > 0 {
		byID := make(map[string]SubnetMeta, len(discovered))
		for _, s := range discovered {
			byID[s.ID] = s
		}
		filtered := make([]SubnetMeta, 0, len(selected))
		for _, id := range selected {
			if s, ok := byID[id]; ok {
				filtered = append(filtered, s)
			}
		}
		use = filtered
	}

	for _, s := range use {
		if s.Public {
			public = append(public, s.ID)
		} else {
			private = append(private, s.ID)
		}
	}

	// A non-empty selection that couldn't be classified (discovery failed / no id matched)
	// is honored raw rather than dropped to the failing `[""]` default.
	if len(private) == 0 && len(public) == 0 && len(selected) > 0 {
		raw := append([]string(nil), selected...)
		return raw, append([]string(nil), selected...)
	}
	if len(public) == 0 {
		public = private
	}
	if len(private) == 0 {
		private = public
	}
	return private, public
}
