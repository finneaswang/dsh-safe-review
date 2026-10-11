# Contributing

Use Node.js 22.19 or newer. Install the pinned dependency tree with `npm ci --ignore-scripts` and run `npm run verify`.

Keep the DSH/Cordis dependency cohort pinned together. Review changes to permission decisions, human-input provenance, one-use grants, budgets, and credential handling with regression cases that demonstrate the failure being prevented. Never make a failing integration test pass by granting Full Access.

Run packed-artifact and restart smoke checks from README before proposing a release. They use isolated DSH homes in `.local/`; do not point tests at a real Desktop profile.

Keep source attribution and copied license notices. Use synthetic data in fixtures. Do not commit keys, user conversations, machine-specific profiles, account usage, or Desktop backups. `npm run check:publication` is an additional guard, not a complete secret detector.

Bug reports should include plugin and DSH versions, OS/architecture, a synthetic reproduction, expected behavior, and the observed result. Distinguish model choices from deterministic gate decisions and native human approval.
