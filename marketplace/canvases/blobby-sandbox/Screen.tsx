import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { getCanvasClient } from '@rwoll/canvas-kit/react'
import type canvas from './canvas.ts'

export type Fit = 'scale' | 'remote'
export type Phase = { kind: 'connecting' | 'connected' | 'disconnected' | 'failed'; message?: string }

const RETRIES = 5
const RETRY_MS = 1500

interface ScreenProps {
  name: string
  /** Changes when the desktop gets a new viewer port, which also reconnects. */
  port: number
  fit: Fit
  onPhase(phase: Phase): void
  onReady(rfb: RFB | undefined): void
}

/**
 * The noVNC viewer for one desktop. It connects straight to the desktop's
 * websocket on 127.0.0.1. Give it a new `key` to reconnect.
 */
export function Screen({ name, port, fit, onPhase, onReady }: ScreenProps) {
  const target = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | undefined>(undefined)
  const fitRef = useRef(fit)
  const callbacks = useRef({ onPhase, onReady })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    callbacks.current = { onPhase, onReady }
  })

  useEffect(() => {
    let rfb: RFB | undefined
    let cancelled = false
    let connected = false
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const report = (phase: Phase) => {
      if (!cancelled) callbacks.current.onPhase(phase)
    }
    const failed = (message: string) => {
      if (cancelled) return
      // A desktop that just started may not accept connections for a moment.
      if (!connected && retry < RETRIES) {
        report({ kind: 'connecting', message: 'Waiting for the desktop…' })
        timer = setTimeout(() => setRetry((count) => count + 1), RETRY_MS)
      } else {
        report({ kind: 'failed', message })
      }
    }

    report({ kind: 'connecting' })
    getCanvasClient<typeof canvas>()
      .run('connect_desktop', { name })
      .then(({ url, password }) => {
        if (cancelled || !target.current) return
        rfb = new RFB(target.current, url, { credentials: { password }, wsProtocols: ['binary'] })
        rfb.background = 'transparent'
        rfb.scaleViewport = fitRef.current === 'scale'
        rfb.resizeSession = fitRef.current === 'remote'
        rfb.addEventListener('connect', () => {
          connected = true
          report({ kind: 'connected' })
          rfb?.focus({ preventScroll: true })
        })
        rfb.addEventListener('disconnect', (event) => {
          closed = true
          const clean = (event as CustomEvent<{ clean: boolean }>).detail?.clean
          if (connected && clean) report({ kind: 'disconnected' })
          else failed(connected ? 'The connection dropped.' : 'Could not connect to the desktop.')
        })
        rfb.addEventListener('securityfailure', (event) => {
          const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason
          report({ kind: 'failed', message: reason ? `Authentication failed: ${reason}` : 'Authentication failed.' })
        })
        rfb.addEventListener('credentialsrequired', () => report({ kind: 'failed', message: 'The desktop asked for credentials.' }))
        rfbRef.current = rfb
        callbacks.current.onReady(rfb)
      })
      .catch((error: unknown) => failed(error instanceof Error ? error.message : String(error)))

    return () => {
      cancelled = true
      clearTimeout(timer)
      rfbRef.current = undefined
      callbacks.current.onReady(undefined)
      // noVNC logs an error when a closed connection is disconnected again.
      if (!closed) rfb?.disconnect()
    }
  }, [name, port, retry])

  useEffect(() => {
    fitRef.current = fit
    const rfb = rfbRef.current
    if (!rfb) return
    rfb.scaleViewport = fit === 'scale'
    rfb.resizeSession = fit === 'remote'
  }, [fit])

  return <div ref={target} className="screen" aria-label={`${name} desktop`} />
}
