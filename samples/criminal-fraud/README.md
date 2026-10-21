# Fictional Crown and defence test packet

All people, businesses, dates, and transactions below are invented for software testing. This is not a real case, a legal opinion, or a predicted verdict.

Paste `scenario.txt` into Case Intake and save it. In Full Proceeding, preview and import only the `sources` folder, select Ontario criminal jury, draft and approve the neutral model, and enter `crown-argument.md` and `defence-argument.md` under the respective Side Theories. Arguments are private advocacy, not source evidence; do not import them as exhibits.

The packet intentionally supports competing inferences. The receipt establishes payment, the transfer establishes use of funds, and the email leaves authorization disputed. A scripted test panel splits 9–3 to exercise the no-verdict path; those votes are test data, not model reasoning.

In the neutral model editor, use **Element evidence matrix** to link the transaction extract as supporting material and the ambiguous email as contrary material for an element. Add questions about authorization and the full account history, save the model, and approve its new version. The test exercises the source viewer and preserved-file download, then reopens the saved trace on the decision sheet.

The automated example also saves an alternate admission version that excludes the transaction extract and runs three further variants. Its deliberately scripted actors then choose not guilty unanimously, giving the comparison a known outcome change and nine changed ballot choices to verify. This is a software test condition, not an assessment of how a real jury or a live model would decide the packet.

Run `npm run test:arguments` for the browser workflow with a deterministic injected test model and an isolated temporary database. No external provider calls are made. Results and screenshots are written to `tmp/qa/arguments/`. Run the app with a configured real provider separately to assess generated advocacy quality.
