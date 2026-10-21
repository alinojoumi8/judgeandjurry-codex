# TrialLens integration baseline

This change integrates the current working application into the repository's
main branch using a snapshot based on the verified remote main. Unpublished
private evaluation history, case uploads, model request captures, databases,
credentials, and runtime logs are excluded. The original local checkout and
its history are preserved. Regression fixtures included here use fictional
case material; three older test labels were fictionalized for publication.

The baseline includes source checking and structured review recovery,
actor-context and jury validation, full-proceeding source preflight, restart
recovery and archive improvements, current dependencies, and visible TrialLens
branding. It preserves existing API routes and storage identifiers.

This is a development baseline, not a release-readiness claim. The latest
local browser exercise reached a decision sheet, but the formal outcome was
incomplete because one final ballot was withheld. Remaining defects include
approved exercise-threshold amounts being rejected as unsupported financial
facts, an explicit source caution being rejected, incomplete checker fields
and finding identities, and evidence-inspector notes not persisting.

Repository checks and CodeRabbit review are recorded in the pull request.
Historical evaluations remain historical evidence. No existing recorded
ballot is rewritten by this integration.
