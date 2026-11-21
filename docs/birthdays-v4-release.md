# Pricing V4.2 — source and deployment status

The public package source is [`src/data/birthday-packages-v4.json`](../src/data/birthday-packages-v4.json). The matching stable CRM IDs, display names and weekday/weekend prices are seeded by `platform/migrations/018_birthday_crm_v2.sql`:

| Public package | CRM ID | Weekend / base | Weekday |
|---|---|---:|---:|
| HAPPY PARTY | `happy-party` | 54,900 ₸ | 38,430 ₸ |
| STAR PARTY | `star-party` | 79,900 ₸ | 55,930 ₸ |
| BOOM BALA PARTY | `boom-bala-party` | 114,900 ₸ | 80,430 ₸ |

The weekday amount is 70% of the base amount. The database seed adds a missing base/weekday rule but does not overwrite an existing price rule; the deployment preflight rejects an amount/name mismatch. Existing legacy package IDs and historical prices are preserved by migration 018. Legacy packages are archived only after the V4.2 site has been deployed and verified.

**Release status:** integration RC only; no Production migration or deployment has been run. See [Stage 2 release runbook](birthdays-v4-runbook.md) for migration ordering, staged package cutover, checks, rollback and current blockers.
