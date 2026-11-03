# canvas-kit

This plugin provides skills for building Copilot canvases with
[`@rwoll/canvas-kit`](../../../packages/canvas-kit):

- [canvas-kit](skills/canvas-kit/SKILL.md): create or change a canvas: state,
  actions, React UI, saved documents, and scheduled jobs.
- [canvas-kit-testing](skills/canvas-kit-testing/SKILL.md): unit tests with Vitest
  and browser tests with Playwright.
- [canvas-kit-publishing](skills/canvas-kit-publishing/SKILL.md): publish canvases
  and other plugins as a marketplace with GitHub Actions.

It has no MCP servers, hooks, executable code, or package dependencies.

```sh
copilot plugin marketplace add rwoll/mono-oss#stable
copilot plugin install canvas-kit@rwoll
```
