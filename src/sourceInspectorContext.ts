import { createContext, useContext } from 'react'
import type { TraceReference } from '../server/trialEngineTypes'

type OpenSource = (source: TraceReference, trigger: HTMLButtonElement) => void
export const SourceContext = createContext<OpenSource | null>(null)
export const useSourceInspector = () => useContext(SourceContext)
