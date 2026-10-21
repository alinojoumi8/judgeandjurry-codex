// Match across printed line labels only within a consecutive Q/A transcript
// block. Keep the original string length/offsets and all spoken numbers intact.
// This is a comparison view; saved quotations always retain the source bytes.
export function transcriptQuotationText(text: string): string {
  const lines = text.split('\n')
  for (let start = 0; start < lines.length; start++) {
    const first = lines[start].match(/^(\s*)(\d{1,2})([ \t]+)(\S.*)$/)
    if (!first || Number(first[2]) < 1) continue
    let end = start
    const block: RegExpMatchArray[] = []
    while (end < lines.length) {
      const line = lines[end].match(/^(\s*)(\d{1,2})([ \t]+)(\S.*)$/)
      if (!line || Number(line[2]) !== Number(first[2]) + end - start) break
      block.push(line)
      end++
    }
    const turns = block.filter(line => /^(?:\d+\s+)?[QA]\.\s/.test(line[4]))
      const header = lines.slice(Math.max(0, start - 8), start).join('\n')
      const continuation = Number(first[2]) === 1 && block.length >= 20 && block.length <= 30 &&
        /\b(?:INTERVIEW|EXAMINATION|TRANSCRIPT) OF\b/i.test(header) && /(?:^|\n)Page \d+[ \t]*\r?\n?$/i.test(header)
      if (block.length >= 3 && turns.length >= 2 || continuation) {
      for (let index = start; index < end; index++) {
        const line = block[index - start]
        lines[index] = `${line[1]}${' '.repeat(line[2].length)}${line[3]}${line[4]}`
      }
    }
    start = Math.max(start, end - 1)
  }
  return lines.join('\n')
}
