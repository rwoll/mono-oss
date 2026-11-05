# PR descriptions

This plugin provides the `pr-descriptions` skill. The skill tells agents how to
write short, reader-first PR and bug report titles and descriptions: media
first (annotated and redacted screenshots, or a short video), then the problem,
repro steps, and the user-facing change with concrete examples. It also tells
them to leave out validation logs, restated diffs, and process narrative.

- [skills/pr-descriptions/SKILL.md](https://github.com/rwoll/mono-oss/blob/main/marketplace/plugins/pr-descriptions/skills/pr-descriptions/SKILL.md) holds the rules.
- [skills/pr-descriptions/references/examples.md](https://github.com/rwoll/mono-oss/blob/main/marketplace/plugins/pr-descriptions/skills/pr-descriptions/references/examples.md)
  holds real microsoft/vscode PRs and issues rewritten with those rules.

It has no MCP servers, hooks, executable code, or package dependencies.

```sh
copilot plugin marketplace add rwoll/mono-oss#stable
copilot plugin install pr-descriptions@rwoll
```

Agents load the skill when they create, update, or propose a PR or file a bug. You can also
ask for it directly, for example "tighten this PR description".
