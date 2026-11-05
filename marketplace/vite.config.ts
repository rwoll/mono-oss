import { canvasKit } from '@rwoll/canvas-kit/vite'
import { defineConfig } from 'vite'

// Content plugins (skills, MCP servers) live in plugins/. Canvases live in
// canvases/, and each ships as its own plugin, listed here with its skills.
export default defineConfig({
  plugins: [
    canvasKit({
      plugins: [
        {
          name: 'annotate',
          version: '0.2.4',
          description: 'Annotate screenshots and screen recordings with the agent: zoom, marks, captions, before/after, and redaction, exported to PNG, MP4, or GIF.',
          canvases: ['annotate'],
          skills: ['annotate'],
        },
        {
          name: 'blobby-sandbox',
          version: '0.1.4',
          description: 'See, start, drive, screenshot, and record Blobby sandboxes in Copilot: the blobby-sandbox skill, and a canvas over its CLI.',
          canvases: ['blobby-sandbox'],
          skills: ['blobby-sandbox'],
        },
        {
          name: 'session-summary',
          version: '0.7.0',
          description: "An executive summary of this chat's work that the agent keeps up to date on a schedule.",
          canvases: ['session-summary'],
        },
      ],
    }),
  ],
})
