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
          version: '0.5.1',
          description:
            'Everything but the kitchen sink: annotated screenshots and recordings, disposable desktop sandboxes, a fake LLM and MCP server for testing, scheduled QA runs of the VS Code Agents window with a triage canvas, a session summary, bakeoffs of variants the agent made, a view of which kinds of tasks your AI credits go to, media-first PR and bug report descriptions, and skills for building canvases.',
          canvases: ['agents-qa', 'annotate', 'bakeoff', 'blobby-sandbox', 'copilot-spend', 'session-summary'],
          skills: ['agent-test-server', 'agents-qa', 'annotate', 'bakeoff', 'blobby-sandbox', 'canvas-kit', 'canvas-kit-publishing', 'canvas-kit-testing', 'pr-descriptions'],
        },
      ],
    }),
  ],
})
