# Fictional venue datasets

Everything in this folder is invented for TrialLens tests and demonstrations. It is not real survey, census, court or verdict data, and it describes no real place or person. Do not treat any figure here as a fact about a real venue, and do not copy these files as a starting point for real research.

| File | Kind | Rows | Purpose |
| --- | --- | --- | --- |
| `population-fictional.json` | population_table | 5 | Pool adjustment. Columns `is_citizen` and `is_adult` stand in for eligibility criteria that a lawyer would enter in the court rules. |
| `attitudes-fictional.json` | attitude_survey | 15 | Strata for sampling. `trust_in_experts` has 24 respondents, below the minimum of 30, so it shows as insufficient data. |
| `focus-group-fictional.json` | focus_group | 3 | Qualitative notes. |
| `verdicts-fictional.json` | verdict_observations | 50 | Enough decided verdicts (44) to show raw and adjusted figures. |
| `verdicts-fictional-small.json` | verdict_observations | 11 | Too few (9 decided): shows the "insufficient data" card. |
| `assumptions-fictional.json` | build input | n/a | Invented response-rate and reporting assumptions, plus a seed. |

Import a file with `POST /api/matters/:matterId/venue/datasets` (the screen has an import form), then build a profile with `POST /api/matters/:matterId/jury-profile/build`.
