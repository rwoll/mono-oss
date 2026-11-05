import { canvasKit } from '@rwoll/canvas-kit/vite'
import { defineConfig } from 'vite'

// The marketplace ships one plugin with every canvas in canvases/ and every skill
// in skills/.
export default defineConfig({
  plugins: [
    canvasKit({
      plugins: [
        {
          name: 'kitchensink',
          version: '0.2.0',
          description:
            'Everything but the kitchen sink: annotated screenshots and recordings, disposable desktop sandboxes, scheduled QA runs of the VS Code Agents window with a triage canvas, a session summary, media-first PR and bug report descriptions, and skills for building canvases.',
          canvases: ['agents-qa', 'annotate', 'blobby-sandbox', 'session-summary'],
          skills: ['agents-qa', 'annotate', 'blobby-sandbox', 'canvas-kit', 'canvas-kit-publishing', 'canvas-kit-testing', 'pr-descriptions'],
        },
      ],
    }),
  ],
})
