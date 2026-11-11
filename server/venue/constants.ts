// Fixed numbers and wording for the local jury profile. Nothing here is a
// statistic about any real venue: these are limits and labels.

// Below this many decided verdict observations no share and no adjusted figure
// is shown. Plan section 6, F4 proposes 30.
export const MIN_VERDICT_SAMPLE = 30
// Below this many positive awards no award figure is shown.
export const MIN_AWARD_SAMPLE = 30
// Below this many survey respondents on one attitude no distribution is shown
// and that attitude is not sampled.
export const MIN_SURVEY_RESPONDENTS = 30

export const MAX_DATASET_ROWS = 20_000
export const BOOTSTRAP_RESAMPLES = 1_000

export const JURY_PROFILE_ALGORITHM_VERSION = 'jury-profile-1'
export const TRAIT_MAPPING_VERSION = 1

export const PROFILE_LABEL = 'Built only from datasets you imported. Nothing here is calibrated against real outcomes and nothing here predicts how any panel will decide.'

export const POPULATION_NOT_JURY_POOL = 'A population is not a jury pool. People are summoned from a source list, many are not eligible, and many who are eligible are excused or do not respond. The figures below are narrowed with the court rules and with response-rate assumptions that you stated. They are not a description of any actual panel.'

// Priest and Klein (1984) on selection; Bailis and MacCoun (1996) on media data.
export const SELECTION_WARNING = 'Cases that reach a verdict are a selected group, not a random sample of disputes, so these patterns are not a win rate for any case (Priest and Klein, 1984). Data taken from media reports leans toward plaintiff wins and large awards (Bailis and MacCoun, 1996). The adjusted figures depend on reporting assumptions you stated and are not measurements.'

export const NO_CALIBRATION = 'Simulated panels drawn from this profile are not calibrated against real outcomes. A synthetic juror is a sample of attitude and experience strata, not a person.'

export const NO_PROTECTED_CHARACTERISTICS = 'Synthetic jurors are described only by attitudes and experience. This profile does not use, and gives no advice based on, any protected personal characteristic.'
