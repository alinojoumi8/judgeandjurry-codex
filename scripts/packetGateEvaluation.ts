export function rejectsInvalidPacket(createRun: () => unknown, expectedErrors: string[]): boolean {
  if (!expectedErrors.length) return false
  try {
    createRun()
    return false
  } catch (error) {
    return error instanceof Error && error.message === expectedErrors.join(' ')
  }
}
