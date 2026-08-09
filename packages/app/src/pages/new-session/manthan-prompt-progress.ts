/** Live Manthan prefill progress (from SSE comments / bus). */

export type ManthanPromptProgressEvent = {
  sessionID: string
  percent: number | null
  prompt_tokens: number | null
  prompt_tokens_processed: number | null
  prompt_tokens_cached?: number | null
  stage: string | null
  message: string | null
}

const bySession = new Map<string, ManthanPromptProgressEvent>()
const listeners = new Set<(p: ManthanPromptProgressEvent) => void>()

export function notifyManthanPromptProgress(progress: ManthanPromptProgressEvent): void {
  bySession.set(progress.sessionID, progress)
  for (const fn of listeners) {
    try {
      fn(progress)
    } catch {
      // ignore
    }
  }
}

export function peekManthanPromptProgress(sessionID: string): ManthanPromptProgressEvent | undefined {
  return bySession.get(sessionID)
}

export function subscribeManthanPromptProgress(fn: (p: ManthanPromptProgressEvent) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
