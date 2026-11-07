# Mareva injunction and set-aside rehearsals

This documentary hearing is for preparing a contested Ontario civil motion. It
produces a simulated judicial ruling, not a court order, a final liability finding
or a probability of success. Review the governing law and the current court record
with qualified counsel before relying on any generated argument.

## Prepare the record

1. Create a case and upload the existing order and amendments, moving record,
   responding record, any reply, and verified legal authorities. Preserve originals.
2. In **Simulation > Review case**, choose **Ontario civil** and draft a model.
   Edit the party names and source coverage. Group parties only when they advance
   the same position for this hearing; identify all represented parties by name.
3. Open **Mareva injunction / set-aside hearing**. Select the hearing type and the
   moving and responding parties. A defendant moving to discharge an injunction
   remains the moving party; plaintiff/defendant labels do not set hearing order.
4. Enter the record cutoff, the exact relief sought and the existing order terms.
   Select sources for each record category. An initial application needs both
   sides' records; a set-aside hearing also needs the challenged order.
5. Replace the framework checklist with the verified law and issue-specific
   burdens for this hearing. The app supplies no universal set-aside burden.
   Review the configuration, save it as a new model, then approve that version.
6. In **Documents > Document use**, review each source's status and restrictions.
   A required hearing record must be readable and permitted for both parties and
   the judge. Reserved, excluded, court-hidden or unreadable material cannot be
   silently treated as part of the hearing record.

Affidavits are attributed evidence, not automatic findings. Factums are advocacy.
A report or generated factum does not become testimony. Describe selected extracts,
missing exhibits and unreadable pages in source coverage. Do not mark an excerpt
as a complete motion record. Date the scenario honestly; historical filings do not
establish the current docket. This workflow does not decide separate Anton Piller,
contempt, damages or final-merits requests bundled into a motion record.

## Run and inspect

In **Simulation > Run simulation**, check source size and confirm external disclosure
when applicable. Start explicitly. The saved run uses its approved model and source
settings. There are four actor stages: moving submission, response, reply, judicial
ruling. Each generated stage uses the existing source checks and repair limits.
The moving advocate sees only its own private preparation; the judge receives the
public submissions and permitted sources. No juror or oral-witness stage runs.

For MiniMax-M3, the hearing requests direct answers for submissions, the ruling,
source checks and repairs. This keeps the existing output allowance available
for the response. It does not change the model, token limit or validation rules.
A truncated response is still withheld. Checker corrections return explicit
structured findings rather than a review encoded inside a second JSON string.
Every ID, assessment field and selector must still be supplied and validated.
A narrowly recognized neutral delivery acknowledgement supplies no review values;
competing assessment text, missing fields and malformed JSON remain withheld.

The preflight shows a 240,000-character source allocation plus a separate, fixed
32,000-character allowance for the complete hearing history (272,000 total).
Source selection, original bytes, permitted paragraphs and earlier submissions
are retained. History cannot borrow unused source capacity, and sources cannot
borrow history capacity. If either allocation is exceeded, the app stops with an
explicit error instead of truncating. This additional history capacity applies
only to Mareva hearings; it does not increase the provider's request, time or
output-token limits. Other proceedings keep their existing context limit.

An initial application permits `grant`, `refuse` or `reserved`. A set-aside hearing
permits `maintain`, `vary`, `discharge` or `reserved`. An invalid or missing disposition
is recorded as no valid judicial ruling; it is never inferred from a party leaning.
A reserved ruling is a recorded reservation, not a decision to grant or discharge.

In **Results > Decision**, inspect the ruling, reasons, source passages and saved
transcript. An exact quotation can open its passage. A whole-document citation
without an exact locator remains explicitly unlocated. Reload or export/import the
case to reopen the saved ruling without regeneration. A source-check failure stays
visible; resume uses completed submissions instead of generating them again.

## Software verification

`npm test -- tests/mareva.test.ts tests/modelProvider.test.ts` covers the hearing
contract, exact outcomes, restrictions, privacy, recovery and provider instructions.
`npm run test:mareva` runs an isolated fictional browser journey through upload,
configuration, ruling, source inspection, reload and archive import. It uses a
scripted actor and is not evidence of live legal accuracy. The journey is included
in aggregate browser coverage and CI. Real-provider acceptance requires a separate
bounded run with disclosed material and saved failure evidence. Use a fresh
temporary directory outside hidden checkout directories for the acceptance
database, source files, previews and uploads. Verify that the browser can
open and download a preserved original from that store.

No new environment variables, dependencies or database migration are required.
Existing model records and proceedings retain their behavior. New hearing settings
are versioned inside the existing case model; new runs receive a server-stamped
civil-hearing identifier.
