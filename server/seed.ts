import type { CaseStore } from './db'
import type { VerdictReport } from './types'

export function seedDemoData(store: CaseStore): void {
  if (store.listMatters().length > 0) {
    return
  }

  const matter = store.createMatter({
    title: 'Smith v. Northbridge Properties',
    jurisdiction: 'Ontario, Canada - civil liability simulation',
    narrative:
      'On March 3, 2024, Plaintiff Jane Smith slipped and fell in the parking lot of Defendant Northbridge Properties shopping center located at 123 Market Street. Plaintiff alleges the fall was caused by a pothole that was not repaired or marked. Plaintiff suffered a fractured wrist and incurred medical treatment and lost wages. Defendant denies negligence and asserts that the condition was open and obvious and that reasonable maintenance procedures were followed.',
  })

  const evidence = [
    store.addEvidence(matter.id, {
      name: 'Incident Report 03.03.24.pdf',
      type: 'pdf',
      mimeType: 'application/pdf',
      size: 1_200_000,
      text:
        'Incident report records a fall in the north parking lot at approximately 6:15 PM. The report notes wet pavement, low evening light, and a pothole near the pedestrian path.',
      summary:
        'Incident report notes wet pavement, low light, and a pothole near the pedestrian path.',
      tags: ['Timeline', 'Maintenance'],
    }),
    store.addEvidence(matter.id, {
      name: 'Photos - Parking Lot.jpg',
      type: 'image',
      mimeType: 'image/jpeg',
      size: 3_400_000,
      text:
        'Photo set described by user as showing standing water and a pothole in the north parking lot near the fall location.',
      summary:
        'Photo evidence described as showing standing water and a pothole near the fall location.',
      tags: ['Photo', 'Visual evidence'],
    }),
    store.addEvidence(matter.id, {
      name: 'Maintenance Log Jan-Mar 2024.pdf',
      type: 'pdf',
      mimeType: 'application/pdf',
      size: 512_000,
      text:
        'Maintenance logs show inspections every two weeks. The March 1 entry says north lot inspected, no urgent repairs opened. No entry specifically describes the pothole.',
      summary:
        'Maintenance logs show inspections, but no entry specifically describes the pothole.',
      tags: ['Maintenance', 'Timeline'],
    }),
    store.addEvidence(matter.id, {
      name: 'Surveillance Clip 03.03.24.mp4',
      type: 'other',
      mimeType: 'video/mp4',
      size: 18_700_000,
      text:
        'Video metadata supplied by user says the camera angle shows the parking lane for 45 minutes before the fall, with visible water accumulation.',
      summary:
        'Video metadata says water accumulation was visible before the fall.',
      tags: ['Timeline', 'Visual evidence'],
    }),
    store.addEvidence(matter.id, {
      name: 'Medical Records - J. Smith.pdf',
      type: 'pdf',
      mimeType: 'application/pdf',
      size: 842_000,
      text:
        'Medical record excerpt states Jane Smith was treated for a distal radius fracture and instructed to avoid lifting for six weeks.',
      summary:
        'Medical records describe a distal radius fracture and activity restrictions.',
      tags: ['Medical', 'Damages'],
    }),
  ]

  const session = store.createSession(matter.id)
  store.appendTurn(session.id, {
    stage: 'defence_opening',
    role: 'defence',
    title: 'Opening Argument',
    content:
      'The condition was open and obvious. The plaintiff had visited the property multiple times and should have exercised reasonable care. The maintenance record supports a routine inspection process.',
    citations: evidence.slice(1, 4).map((item) => ({
      exhibitId: item.exhibitId,
      evidenceId: item.id,
      label: item.name,
    })),
  })
  store.appendTurn(session.id, {
    stage: 'crown_opening',
    role: 'crown',
    title: 'Response',
    content:
      'The hazard may not have been visible due to poor lighting and standing water. Northbridge failed to inspect and repair within a reasonable timeframe after recurring wet-lot conditions.',
    citations: [evidence[0], evidence[1], evidence[4]].map((item) => ({
      exhibitId: item.exhibitId,
      evidenceId: item.id,
      label: item.name,
    })),
  })
  store.appendTurn(session.id, {
    stage: 'jury_deliberation',
    role: 'jury',
    title: 'Deliberation',
    content:
      'The jury panel is weighing whether the condition was unreasonably dangerous, whether inspection was adequate, and whether the plaintiff took reasonable care.',
    citations: [evidence[0], evidence[1], evidence[2]].map((item) => ({
      exhibitId: item.exhibitId,
      evidenceId: item.id,
      label: item.name,
    })),
  })
  store.appendTurn(session.id, {
    stage: 'defence_rebuttal',
    role: 'defence',
    title: 'Rebuttal',
    content:
      'The maintenance logs show regular inspections. A transient puddle does not establish liability without proof of notice or unreasonable delay.',
    citations: [evidence[2]].map((item) => ({
      exhibitId: item.exhibitId,
      evidenceId: item.id,
      label: item.name,
    })),
  })
  store.appendTurn(session.id, {
    stage: 'crown_rebuttal',
    role: 'crown',
    title: 'Surrebuttal',
    content:
      'Maintenance logs are incomplete. The video description indicates water accumulation was present for an extended period, which raises a notice and inspection-frequency issue.',
    citations: [evidence[3], evidence[4]].map((item) => ({
      exhibitId: item.exhibitId,
      evidenceId: item.id,
      label: item.name,
    })),
  })
  store.appendTurn(session.id, {
    stage: 'judge_ruling',
    role: 'judge',
    title: 'Analysis & Decision Support',
    content:
      'I have considered the arguments, exhibits, and Ontario occupiers liability framing. The plaintiff currently has the stronger simulation position, but the result turns on notice, lighting, and maintenance completeness.',
    citations: evidence.map((item) => ({
      exhibitId: item.exhibitId,
      evidenceId: item.id,
      label: item.name,
    })),
  })

  const verdict: VerdictReport = {
    outcome: 'Plaintiff Prevails',
    confidence: 72,
    keyFactors: [
      'Unrepaired hazard in common parking area',
      'Visibility affected by lighting and standing water',
      'Inspection frequency may be insufficient',
      'Plaintiff care remains a live issue',
    ],
    unresolvedIssues: [
      'Duration of hazard existed unknown',
      'Completeness of maintenance logs',
      'Whether warnings were feasible',
      'Contributory negligence evidence',
    ],
    recommendedNextSteps: [
      'Clarify inspection schedule and repair records',
      'Obtain full surveillance coverage',
      'Consider expert evidence on property standards',
      'Prepare damages assessment',
    ],
    citationWarnings: [],
    disclaimer:
      'Decision-support simulation only. This is not legal advice or a binding court outcome; attorney review is required.',
  }

  store.saveVerdict(session.id, verdict)
  store.setSessionStatus(session.id, 'completed')
}
