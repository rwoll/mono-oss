# Efficient mode: the accessibility tree

Use the tree to find and act on UI by name, without looking at pixels. It is fast and exact, and it keeps working when themes, sizes, or layouts change.

## Find elements

```sh
blobby-sandbox ui repro-123 --app code-insiders --match "toggle chat"
# 8.0.0.0.6.0.0.0.1.0.0.0.0.1.1.0.1.0.0.1.0.0  push button "Toggle Chat" at 1170,40,24,24
```

- Each line is `path  role "name" states at x,y,width,height`. With `--json`, each element also lists its `actions`.
- `--app` takes part of an app's name: `code-insiders`, `Google Chrome`, `gnome-shell`.
- `--match` takes part of an element's name or text, without regard to case. Narrow with it rather than reading the whole tree; VS Code's is large.
- Only visible elements appear. If something is missing, open the view or menu that holds it first.
- `--max` raises the limit of 300 elements; prefer a narrower `--match`.

## Act on them

```sh
blobby-sandbox ui repro-123 8.0.0.0.6.0.0.0.1.0.0.0.0.1.1.0.1.0.0.1.0.0      # press, click, or activate
blobby-sandbox ui repro-123 <path> focus                                      # then type into it
blobby-sandbox ui repro-123 <path> set 'hello world'                          # replace an editable element's text
blobby-sandbox input repro-123 type 'hello world'
blobby-sandbox input repro-123 key ctrl+shift+p
```

- A path is valid only until the UI changes. Take a new `ui` after each step that changes the UI.
- When an element has no action, click the center of its box: `blobby-sandbox input repro-123 click 1182 52 --instant`. Use `--action` to pick one of several actions.
- After an action, wait for its result instead of sleeping or taking screenshots in a loop:
  `blobby-sandbox ui repro-123 --wait --match "Accounts" --role "push button" --json`. It waits in the
  sandbox, in one call, and prints what matched. `--state focused` (or `checked`, `selected`, `expanded`,
  `editable`, `disabled`) narrows it, `--gone` waits until nothing matches, such as for a progress bar, and
  `--timeout` sets how long, 30 seconds by default. When it fails with `wait_timeout`, take a screenshot to
  see why.
- Keyboard shortcuts are often the fastest route in VS Code: the Command Palette (`ctrl+shift+p`), Quick Open (`ctrl+p`), and Chat (`ctrl+alt+i`).

## Things to know

- VS Code and Chrome publish their trees from the start. Web pages in Chrome are in the tree too.
- The vscode-insiders recipe keeps VS Code out of Screen Reader Optimized mode, so the UI you drive is the one users see. Don't turn on `editor.accessibilitySupport` unless the task is about screen readers.
- Confirm results with the tree (a state such as `checked`, `expanded`, or `focused`, or the text of an element), and with a screenshot when what matters is how it looks.
