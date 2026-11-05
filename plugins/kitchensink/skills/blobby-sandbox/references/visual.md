# Visual mode: screenshots

Use screenshots when the task is to notice things: exploring a feature, QA, or checking that a change looks right. Work the way a careful person would, from what is on the screen, not from what you expect to be there.

## The loop

1. `blobby-sandbox screenshot repro-123 --out shots/07.png`, then view `shots/07.png`.
2. Describe what you see before acting: the window, its state, anything odd.
3. Act on what you saw, with coordinates from the screenshot (the screen is 1280x800 unless `start --resolution` or the viewer changed it):
   ```sh
   blobby-sandbox input repro-123 click 640 400          # --button right, --double
   blobby-sandbox input repro-123 type 'some text'
   blobby-sandbox input repro-123 key Return
   blobby-sandbox input repro-123 scroll 0 3 --at 640,400
   ```
   The pointer glides there as a person's would, so hover states appear along the way; keep that for QA and recordings. `--instant` jumps.
4. Wait for the UI to settle (usually a second), and take the next screenshot. Never take two actions without looking in between.

Number screenshots in the order you take them, so the sequence tells the story.

## What to look for

- Layout: clipped, overlapping, or misaligned text and controls; scrollbars where none should be; empty space where content should be.
- State: buttons that look enabled but do nothing, spinners that never stop, stale content after an action, focus in the wrong place.
- Consistency: the same thing named, iconed, or colored differently in two places; light and dark themes; narrow and wide windows.
- Feedback: an action with no visible result, errors that say nothing useful, notifications that vanish before they can be read.

When something looks wrong, take a screenshot that shows it clearly, and note the exact steps that led there.

## Helpful commands

```sh
blobby-sandbox exec repro-123 -- wmctrl -l                            # open windows
blobby-sandbox exec repro-123 -- wmctrl -a 'Visual Studio Code'      # bring a window to the front
blobby-sandbox exec repro-123 -- xdotool getactivewindow getwindowname
blobby-sandbox exec repro-123 -- xdotool getmouselocation
```

When you can't find something by eye, look it up in the tree (`blobby-sandbox ui --match`), and use its box.
