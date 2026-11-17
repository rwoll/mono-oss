import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import type canvas from './canvas.ts'

export const { useCanvas, useAction } = createCanvasHooks<typeof canvas>()
