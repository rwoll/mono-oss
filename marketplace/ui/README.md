# Shared UI

The look every canvas in this marketplace shares, from the canvases first built in
agent-customizations: `theme.css` (colors, type, buttons, menus, badges, labeled
blocks, dialogs, and Markdown) and the components in this folder. It is a plain
folder, not a package: canvases import it by path.

```tsx
// canvases/<name>/App.tsx
import { Markdown, RefreshIcon } from '../../ui'
import '../../ui/theme.css'

<section className="block executive">
  <h2 className="label">Executive summary</h2>
  <Markdown>{state.summary}</Markdown>   // Markdown the agent writes, safely
</section>
```

Colors come from the host's theme variables when it provides them, with GitHub-style
light and dark fallbacks. Use the classes in `theme.css` (`pill`, `badge`, `label`,
`block`, `bullets`, `rows`, `menu`, `dialog`, `banner`, `notice`) rather than new
styles, so canvases stay consistent.
