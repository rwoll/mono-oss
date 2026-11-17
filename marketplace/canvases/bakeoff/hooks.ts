import { createCanvasHooks, getCanvasClient } from '@rwoll/canvas-kit/react'
import { useEffect, useState } from 'react'
import type canvas from './canvas.ts'
import type { Variant } from './schema.ts'
import { loadsText } from './shared.ts'

export const { useCanvas } = createCanvasHooks<typeof canvas>()
export const client = () => getCanvasClient<typeof canvas>()

/** Saves in flight, so a send can wait for the note the user just typed. */
const saving = new Set<Promise<unknown>>()
export function track<T>(promise: Promise<T>): Promise<T> {
  saving.add(promise)
  void promise.catch(() => undefined).finally(() => saving.delete(promise))
  return promise
}
export const saved = () => Promise.allSettled(saving)

const contents = new Map<string, Promise<string>>()

/** A text variant's content, read once. Undefined while it loads, and for variants shown from a file URL. */
export function useContent(bakeoff: string, variant: Variant): { content?: string; error?: string } {
  const id = loadsText(variant) ? variant.id : undefined
  const key = `${bakeoff}/${id}`
  const [loaded, setLoaded] = useState<{ key: string; content?: string; error?: string }>()
  useEffect(() => {
    if (!id) return
    let live = true
    let content = contents.get(key)
    if (!content) {
      content = client()
        .run('load_variant', { variant: id })
        .then((result) => result.content)
      contents.set(key, content)
      content.catch(() => contents.delete(key))
    }
    content.then(
      (text) => live && setLoaded({ key, content: text }),
      (error: unknown) => live && setLoaded({ key, error: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      live = false
    }
  }, [id, key])
  return loaded?.key === key ? loaded : {}
}
