import { canvasKit } from '@rwoll/canvas-kit/vite'
import { defineConfig } from 'vite'

// Content plugins (skills, MCP servers) live in plugins/. Canvases live in
// canvases/, and each ships as its own plugin, listed here.
export default defineConfig({
  plugins: [
    canvasKit({
      plugins: [
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
