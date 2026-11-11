# server/forecast

Pure, deterministic, seeded math for the case-intelligence forecasts (win rates,
panel outcomes, damages, damages psychology, advocacy-style studies). No database,
model or trial-engine imports: modules take plain typed inputs so later milestones
can wire data in. Numbers come from this code, never from a model.

**Everything here is a simulation output.** A result describes how simulated panels
behaved under the supplied inputs. It is not a forecast of a real verdict, not legal
advice, and not tested against real outcomes unless a separate calibration says so.
Wording helpers (`formatWinRate`) always say this.

## Modules

| Module | Purpose |
| --- | --- |
| `prng.ts` | Seeded xoshiro128** generator, `derivedSeed(seed, label)`, normal/gamma/beta draws |
| `stats.ts`, `paired.ts` | Quantiles, normal quantile/CDF, incomplete beta, OLS, pairing on common seeds |
| `money.ts` | Integer-cent arithmetic, half-even rounding, largest-remainder apportionment |
| `intervals.ts` | Wilson interval, seeded percentile bootstrap, exploratory flag (< 20 runs) |
| `panelMath.ts` | Poisson-binomial votes, decision rules, reduced panels, beta-binomial correlation, Monte Carlo, joint verdict-form simulation |
| `socialDecision.ts` | Social decision scheme tables (Davis, 1973): estimated with smoothing, or reference schemes |
| `winRates.ts` | Per-defendant, per-claim liability results and the plain-language wording |
| `damagesPipeline.ts` | Ordered damages pipeline with a ledger; stops on missing rule inputs |
| `damagesModel.ts` | Zero-plus-lognormal award model, seeded resampling, percentiles, deliberation shift |
| `damagesPsychology.ts` | Paired anchoring/framing effects, backfire, numeracy interaction, condition availability |
| `styleEffects.ts` | Paired style comparison with length control, recommendation, blends |

Import from `./index`.

## Units and conventions

- **Money** is an integer number of cents. Non-integer or negative amounts throw.
- **Percentages in money code** are integer basis points (2500 = 25%). Interest is a rate per period
  with a whole number of periods (pick the period to match, e.g. monthly rate and months).
- **Probabilities** are floats in [0, 1]. `claimant` means the claimant (plaintiff) side prevails.
- **Votes**: "initial split" is the number of claimant-side jurors out of n.

## Rounding rules

- Percentage-of-amount: **round half to even** on the cent (`percentOf`, fees, fault, collectability, compound interest each period).
- A rounded total split across lines (fault reductions, cap trimming, deductions): **largest remainder**,
  ties broken by line order. Parts are integers and always sum exactly to the whole. A line never goes below zero.
- Statistics reported in cents (percentiles, medians, means): linear interpolation, then half-even to a cent.
- Display percents (`formatPercent`): whole percents, **half up**, estimate and each bound rounded separately.
  `0.4%` shows as `0%`; only exact 1 shows `100%`.

## Seeding

Every random function takes an explicit `seed`. Same seed and inputs give identical output. Each consumer derives its
own stream with `derivedSeed(seed, label)` so adding one analysis never shifts the numbers of another. Bootstraps resample
whole units (runs, seeds or pairs), never jurors within a run.

## What is and is not established

- Wilson intervals assume independent trials. Use runs (panels) as the trials, never jurors.
- Bootstrap intervals are per estimate and are not adjusted for multiple comparisons.
- Below 20 completed runs results are `exploratory`.
- Correlation: `rho = 0` is exactly independence. With `rho > 0` jurors share a Beta common shock; for different juror
  probabilities this is a quadrature mixture with clamping, an approximation documented in `panelMath.ts`.
  The beta-binomial `rho` must be estimated from between-run variation by the caller.
- Reference social decision schemes are illustrative theory, never data. Cells with few observations are flagged `sparse`.
- Element shares are juror shares. They are never multiplied into a claim probability. A panel result for an element exists
  only when the element is its own verdict question.
- The damages pipeline applies the rule pack's order and values. It does not know the law. A missing or `unknown`
  rule value stops the calculation (`status: 'incomplete'`) and is never treated as zero. Punitive lines are included only
  when `punitiveAvailable` is `true`.
- Damages psychology and style results are **model behaviour**. Human research is a reference only. The only grouping
  variable is a numeric trait (numeracy); there is no input for protected characteristics.
- Style comparisons control for advocacy length by regression on the paired length difference. That removes a linear length
  effect only.
- Nothing here has been calibrated against real outcomes. The "calibrated" wording needs an explicit, complete
  `calibration` object with `passed: true`; without it the "not yet tested against real outcomes" sentence always appears.
