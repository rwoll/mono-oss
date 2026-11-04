# PR descriptions

This plugin provides the `pr-descriptions` skill. The skill tells agents how to
write short, reader-first PR titles and descriptions: the problem, repro steps,
the user-facing change with concrete examples, and before/after tables. It also
tells them to leave out validation logs, restated diffs, and process narrative.

- [skills/pr-descriptions/SKILL.md](https://github.com/rwoll/mono-oss/blob/main/marketplace/plugins/pr-descriptions/skills/pr-descriptions/SKILL.md) holds the rules.
- [skills/pr-descriptions/references/examples.md](https://github.com/rwoll/mono-oss/blob/main/marketplace/plugins/pr-descriptions/skills/pr-descriptions/references/examples.md)
  holds real microsoft/vscode PRs rewritten with those rules.

It has no MCP servers, hooks, executable code, or package dependencies.

```sh
copilot plugin marketplace add rwoll/mono-oss#stable
copilot plugin install pr-descriptions@rwoll
```

Agents load the skill when they create, update, or propose a PR. You can also
ask for it directly, for example "tighten this PR description".
