# Fictional civil negligence test packet

All people, businesses, addresses, dates, file numbers, and records below are invented for software testing. This is not a real case, a legal opinion, or a predicted outcome.

Paste `scenario.txt` into Case Intake and save it. Then preview and import only the `sources` folder, and select Ontario civil. Never import `README.md` or `answer-key.json` as evidence: the answer key lists the planted problems and would contaminate any run.

The packet is a two-defendant slip-and-fall action in the Ontario Superior Court of Justice. It deliberately contains conflicts between sources, gaps in the record, expert reports with weak foundations, and one embedded instruction-like line in a site log. All of them are listed in `answer-key.json`, with the file and exact quote for each.

The statutes named in the pleadings are the fictional parties' assertions. They have not been reviewed by counsel, and no case law is cited.

`npx vitest run tests/civilNegligenceFixture.test.ts` checks that the key and the sources agree, imports the packet with the real corpus service, and runs the disclosure analysis on it. That test establishes software behaviour only. It is not proof of live model quality, legal correctness, or integration with any external system.
