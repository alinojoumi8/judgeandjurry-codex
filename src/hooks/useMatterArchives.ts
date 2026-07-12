import { useRef } from 'react'

import { exportMatterArchive, importMatterArchive } from '../api'
import type { Matter, WorkspaceState } from '../types'

interface UseMatterArchivesOptions {
  activeMatter: Matter | null
  onImported: (state: WorkspaceState) => void
  onError: (message: string) => void
}

export function useMatterArchives({
  activeMatter,
  onImported,
  onError,
}: UseMatterArchivesOptions) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const exportActiveMatter = async () => {
    if (!activeMatter) {
      return
    }
    try {
      await exportMatterArchive(activeMatter.id, activeMatter.title)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unable to export matter archive.')
    }
  }

  const importSelectedFile = async (file: File | undefined) => {
    if (!file) {
      return
    }
    try {
      onImported(await importMatterArchive(file))
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unable to import matter archive.')
    } finally {
      if (inputRef.current) {
        inputRef.current.value = ''
      }
    }
  }

  return {
    inputRef,
    openImportPicker: () => inputRef.current?.click(),
    exportActiveMatter,
    importSelectedFile,
  }
}
