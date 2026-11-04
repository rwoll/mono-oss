# Evidence: screenshots and recordings

Evidence shows a reviewer, in seconds, what happened. Each image or clip proves one claim.

## Capture

- **Screenshots:** `blobby-sandbox screenshot <name> --out <file>.png` right after the step that shows the claim, once the UI has settled.
- **Recordings:** `blobby-sandbox record <name> start --max-seconds <n>`, reproduce at a human pace with a pause after each step, then `blobby-sandbox record <name> stop --out <file>.mp4`. Keep clips under about two minutes; make one clip per scenario rather than one long take.
- **Before and after:** capture the same steps, window size, and framing on the base build (before) and on the change (after). Note the commit of each.
- **Never capture secrets:** no password or 2FA entry, no tokens in terminals, no other accounts. Look at every image, and scrub through every recording, before sharing it.

## Describe

For every screenshot or clip, write down:

- what it shows, as a verdict: "✗ New Chat opens a read-only chat with no input", "✓ New Chat opens a working input";
- where to look in it: the element, or for a video the time (`0:24`);
- the build: "main @ c6315a9e" or "this PR @ ee0b5bd7".

Base the verdict on what you checked in the live app (the tree or the screenshot), not on what you expected.

## Share in a pull request or issue

Upload media with the GitHub CLI, never through a browser. Then:

```md
## Before / after

<Build> in a fresh Ubuntu 24.04 sandbox (blobby-sandbox). <What red and green mean, if you annotated.>

| Scenario | Before (main @ abc1234) | After (this PR @ def5678) |
| --- | --- | --- |
| **<Scenario>**, <action> | ![Before: <verdict>](<image URL>) | ![After: <verdict>](<image URL>) |

**After, recorded** (1:12):

<video URL on its own line, so GitHub shows a player>

What to watch: `0:08` <first thing> · `0:31` <second thing>.
```

Alt text states the verdict. Put each video URL on its own line, and list timestamps as text.
