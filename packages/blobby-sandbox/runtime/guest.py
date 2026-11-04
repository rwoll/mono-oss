#!/usr/bin/env python3
"""The guest side of blobby-sandbox: every desktop operation, as JSON in and JSON out over plain commands.

  guest.py <operation> ['<JSON options>']

It prints one JSON object: the result with "ok": true, or "ok": false with a "code" and an "error"
that says what to do. blobby-sandbox runs it as the desktop user, in the session's environment. Because it
needs nothing but a way to run commands, every backend, local or remote, gets the whole desktop API.

Operations:
  exec -- <command>                        runs a command as this process
  status                                   whether the session runs and GNOME Shell is up, and the recording
  screenshot                               the screen as a base64 PNG
  input        {"click": [x, y], "button": "left", "double": false} | {"move": [x, y]}
               | {"type": "text"} | {"key": "ctrl+l Return"} | {"scroll": [dx, dy], "at": [x, y]}
               The pointer glides to [x, y] as a hand moves a mouse; "instant": true jumps.
  resize       {"width": w, "height": h}
  ui.snapshot  {"app": "...", "match": "...", "max": 300}
  ui.act       {"path": "4.0.1", "do": "press" | "focus" | "set", "action": "...", "text": "..."}
  record.start {"maxSeconds": 600}
  record.stop                              {"id", "size", "sha256", "seconds"}
  media.read   {"id": "...", "offset": 0, "length": 4194304}
  media.delete {"id": "..."}
  step.start   {"id", "sandbox", "callbacks", "run", "cwd"}   a recipe step file
               | {"id", "sandbox", "callbacks", "argv", "secret"}   any command, for `exec --secret`
  step.poll    {"id", "offset", "outputOffset"}           progress, callback requests, output, and exit
  ui.wait      {"match", "app", "role", "state", "gone", "timeoutSeconds"}
                                                          waits here until an element matches, or none does
  step.answer  {"id", "request", "answer"}
  step.stop    {"id"}
"""
import base64
import contextlib
import hashlib
import json
import math
import os
import random
import re
import secrets
import shutil
import signal
import struct
import subprocess
import sys
import time

MEDIA_DIR = "/var/tmp/blobby-media"
# Memory only. Tests point it elsewhere.
SHM = os.environ.get("BLOBBY_SHM", "/dev/shm")
STEPS_DIR = os.path.join(SHM, "blobby-steps")
RECORDING = os.path.join(MEDIA_DIR, "recording.json")
NODE = "/opt/blobby/node/bin/node"
# The scripts library, on every step's and command's PATH.
SCRIPTS_DIR = "/opt/blobby/runtime/scripts"
ID = re.compile(r"^[a-f0-9]{8,64}$")
MAX_CHUNK = 4 * 1024 * 1024
OUTPUT_CHUNK = 256 * 1024


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def check_id(value, what="id"):
    if not isinstance(value, str) or not ID.match(value):
        raise Failure("invalid_id", f"{what} must be 8 to 64 lowercase hex characters.")
    return value


def private_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def run(command, **kwargs):
    return subprocess.run(command, capture_output=True, text=True, **kwargs)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


# The guard against capturing secrets.


def exec_(argv):
    """Runs a command as this process, so its exit code and output are the command's."""
    if not argv:
        print("blobby-sandbox: exec needs a command", file=sys.stderr)
        return 2
    os.environ["PATH"] = f"{SCRIPTS_DIR}:{os.environ.get('PATH', '')}"
    try:
        os.execvp(argv[0], argv)
    except OSError as error:
        print(f"blobby-sandbox: {argv[0]}: {error.strerror}", file=sys.stderr)
        return 127


# Screen and input.


def png_size(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise Failure("capture_failed", "The screenshot is not a PNG.")
    return struct.unpack(">II", data[16:24])


def screenshot(_):
    path = f"/tmp/blobby-shot-{secrets.token_hex(6)}.png"
    try:
        result = run(["scrot", "--overwrite", "--pointer", path])
        if result.returncode != 0:
            raise Failure("capture_failed", f"The screenshot failed: {result.stderr.strip()[-300:]}")
        with open(path, "rb") as file:
            data = file.read()
    finally:
        if os.path.exists(path):
            os.remove(path)
    width, height = png_size(data)
    return {"png": base64.b64encode(data).decode(), "width": width, "height": height}


def point(value, what):
    if not (isinstance(value, list) and len(value) == 2 and all(isinstance(n, int) and n >= -100000 for n in value)):
        raise Failure("usage", f"{what} must be two whole numbers.")
    return [str(n) for n in value]


def xdotool(*args):
    result = run(["xdotool", *args])
    if result.returncode != 0:
        raise Failure("input_failed", f"xdotool failed: {result.stderr.strip()[-300:]}")


def pointer():
    values = dict(line.split("=", 1) for line in run(["xdotool", "getmouselocation", "--shell"]).stdout.splitlines() if "=" in line)
    return int(values.get("X", 0)), int(values.get("Y", 0))


def glide(x, y):
    """xdotool commands that move the pointer to (x, y) as a hand moves a mouse: along a slight curve,
    fast in the middle and slow at both ends, taking longer for longer moves (Fitts' law)."""
    x0, y0 = pointer()
    dx, dy = x - x0, y - y0
    distance = math.hypot(dx, dy)
    if distance < 3:
        return ["mousemove", str(x), str(y)]
    duration = min(0.9, 0.12 + 0.11 * math.log2(1 + distance / 12))
    steps = max(8, int(duration / 0.012))
    bend = random.uniform(-0.12, 0.12) * distance
    cx, cy = x0 + dx / 2 - dy / distance * bend, y0 + dy / 2 + dx / distance * bend
    commands = []
    for step in range(1, steps + 1):
        t = step / steps
        s = t * t * t * (10 - 15 * t + 6 * t * t)  # minimum jerk
        px = (1 - s) ** 2 * x0 + 2 * (1 - s) * s * cx + s * s * x
        py = (1 - s) ** 2 * y0 + 2 * (1 - s) * s * cy + s * s * y
        commands += ["mousemove", str(round(px)), str(round(py)), "sleep", f"{duration / steps:.3f}"]
    return commands[:-2] + ["mousemove", str(x), str(y)]


def pause(low, high):
    return ["sleep", f"{random.uniform(low, high):.3f}"]


def input_(options):
    buttons = {"left": "1", "middle": "2", "right": "3"}
    instant = bool(options.get("instant"))
    move = lambda x, y: ["mousemove", "--sync", str(x), str(y)] if instant else glide(x, y)
    if "click" in options:
        x, y = (int(n) for n in point(options["click"], "click"))
        button = buttons.get(options.get("button", "left"))
        if not button:
            raise Failure("usage", "button must be left, middle, or right.")
        clicks = 2 if options.get("double") else 1
        if instant:
            xdotool(*move(x, y), "click", "--repeat", str(clicks), button)
        else:
            # A person holds the button for a moment, and leaves a short gap in a double click.
            press = [*pause(0.04, 0.09), "mousedown", button, *pause(0.05, 0.11), "mouseup", button]
            xdotool(*move(x, y), *press, *([*pause(0.08, 0.14), "mousedown", button, *pause(0.05, 0.09), "mouseup", button] if clicks == 2 else []))
    elif "move" in options:
        x, y = (int(n) for n in point(options["move"], "move"))
        xdotool(*move(x, y))
    elif "type" in options:
        if not isinstance(options["type"], str):
            raise Failure("usage", "type must be text.")
        xdotool("type", "--delay", "12", "--", options["type"])
    elif "key" in options:
        keys = options["key"].split() if isinstance(options["key"], str) else []
        if not keys:
            raise Failure("usage", "key must be keys such as ctrl+l or Return.")
        xdotool("key", "--", *keys)
    elif "scroll" in options:
        dx, dy = (int(n) for n in point(options["scroll"], "scroll"))
        commands = []
        if "at" in options:
            x, y = (int(n) for n in point(options["at"], "at"))
            commands += move(x, y)
        for amount, less, more in ((dy, "4", "5"), (dx, "6", "7")):
            if amount:
                delay = "0" if instant else "45"
                commands += ["click", "--repeat", str(min(abs(amount), 50)), "--delay", delay, more if amount > 0 else less]
        if commands:
            xdotool(*commands)
    else:
        raise Failure("usage", "Say click, move, type, key, or scroll.")
    return {}


def resize(options):
    width, height = options.get("width"), options.get("height")
    if not all(isinstance(n, int) and 320 <= n <= 8192 for n in (width, height)):
        raise Failure("usage", "width and height must be whole numbers from 320 to 8192.")
    result = run(["xrandr", "--fb", f"{width}x{height}"])
    if result.returncode != 0:
        raise Failure("resize_failed", f"The screen did not resize: {result.stderr.strip()[-300:]}")
    return {"width": width, "height": height}


# The accessibility tree.

TEXT_ROLES = {"entry", "text", "password text", "terminal", "document web", "combo box", "spin button"}
MAX_DEPTH = 80


def atspi():
    import pyatspi

    pyatspi.setTimeout(750, 1500)
    return pyatspi


def node_at(pyatspi, path):
    try:
        node = pyatspi.Registry.getDesktop(0)
        for index in path.split("."):
            node = node.getChildAtIndex(int(index))
            if node is None:
                raise IndexError
        return node
    except (ValueError, IndexError, LookupError):
        raise Failure("stale_path", f"No element at {path}. The UI changed; take a new snapshot.")


def extents(pyatspi, node):
    try:
        box = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        return [box.x, box.y, box.width, box.height]
    except NotImplementedError:
        return None


def action_names(node):
    try:
        action = node.queryAction()
        return [action.getName(i) for i in range(action.nActions)]
    except NotImplementedError:
        return []


def text_of(node, role):
    if role not in TEXT_ROLES:
        return None
    try:
        text = node.queryText()
        return text.getText(0, min(text.characterCount, 200))
    except NotImplementedError:
        return None


def ui_snapshot(options):
    pyatspi = atspi()
    app, match = options.get("app"), options.get("match")
    limit = max(1, min(int(options.get("max", 300)), 5000))
    states = {
        pyatspi.STATE_FOCUSED: "focused",
        pyatspi.STATE_CHECKED: "checked",
        pyatspi.STATE_SELECTED: "selected",
        pyatspi.STATE_EXPANDED: "expanded",
        pyatspi.STATE_EDITABLE: "editable",
    }
    nodes, truncated = [], False
    desktop = pyatspi.Registry.getDesktop(0)
    stack = []
    for index in reversed(range(desktop.childCount)):
        child = desktop.getChildAtIndex(index)
        if child is not None and (not app or app.lower() in (child.name or "").lower()):
            stack.append((child, str(index), child.name or "", 0))
    while stack:
        node, path, app_name, depth = stack.pop()
        try:
            role = node.getRoleName()
            state = node.getState()
            if depth > 0 and (state.contains(pyatspi.STATE_DEFUNCT) or not state.contains(pyatspi.STATE_SHOWING)):
                continue
            name = node.name or ""
            text = text_of(node, role)
            label = f"{name} {text or ''}".lower()
            if depth > 0 and (name or text) and (not match or match.lower() in label):
                if len(nodes) >= limit:
                    truncated = True
                    break
                entry = {"path": path, "app": app_name, "role": role, "name": name}
                if text:
                    entry["text"] = text
                named = [label for key, label in states.items() if state.contains(key)]
                if not state.contains(pyatspi.STATE_SENSITIVE):
                    named.append("disabled")
                if named:
                    entry["states"] = named
                box = extents(pyatspi, node)
                if box:
                    entry["box"] = box
                actions = action_names(node)
                if actions:
                    entry["actions"] = actions
                nodes.append(entry)
            if depth < MAX_DEPTH:
                for index in reversed(range(node.childCount)):
                    child = node.getChildAtIndex(index)
                    if child is not None:
                        stack.append((child, f"{path}.{index}", app_name, depth + 1))
        except LookupError:
            continue
    return {"nodes": nodes, "truncated": truncated}


def matching(nodes, role, state):
    role, state = (role or "").lower(), (state or "").lower()
    return [n for n in nodes if (not role or n["role"].lower() == role) and (not state or state in n.get("states", []))]


def ui_wait(options):
    """Polls the accessibility tree here, in the sandbox, until an element matches, or with gone, until none does."""
    match = options.get("match")
    if not isinstance(match, str) or not match:
        raise Failure("usage", "ui.wait needs match: text in the element's name or text.")
    seconds = max(1, min(int(options.get("timeoutSeconds", 30)), 300))
    gone = bool(options.get("gone"))
    query = {"app": options.get("app"), "match": match, "max": 50}
    started = time.monotonic()
    while True:
        nodes = matching(ui_snapshot(query)["nodes"], options.get("role"), options.get("state"))
        waited = int((time.monotonic() - started) * 1000)
        if gone and not nodes:
            return {"found": False, "nodes": [], "waitedMs": waited}
        if nodes and not gone:
            return {"found": True, "nodes": nodes, "waitedMs": waited}
        if waited >= seconds * 1000:
            what = " ".join(filter(None, [options.get("state"), options.get("role"), repr(match)]))
            if gone:
                raise Failure("wait_timeout", f"An element matching {what} was still there after {seconds} seconds. Take a screenshot to see why.")
            raise Failure("wait_timeout", f"No element matching {what} appeared in {seconds} seconds. Take a screenshot to see what is on the screen.")
        time.sleep(0.25)


def ui_act(options):
    pyatspi = atspi()
    path = options.get("path")
    if not isinstance(path, str) or not re.match(r"^\d+(\.\d+)*$", path):
        raise Failure("usage", "path must be a path from a snapshot, such as 4.0.1.")
    node = node_at(pyatspi, path)
    kind = options.get("do", "press")
    if kind == "press":
        names = action_names(node)
        if not names:
            raise Failure("no_action", f"{node.getRoleName()} {node.name!r} has no actions. Click its box instead.")
        wanted = options.get("action")
        if wanted:
            if wanted not in names:
                raise Failure("no_action", f"{node.name!r} has no {wanted!r} action, only: {', '.join(names)}.")
            index = names.index(wanted)
        else:
            preferred = [n for n in ("press", "click", "activate", "jump", "toggle") if n in names]
            index = names.index(preferred[0]) if preferred else 0
        if not node.queryAction().doAction(index):
            raise Failure("action_failed", f"{node.name!r} did not run {names[index]!r}.")
        return {"path": path, "name": node.name, "did": names[index]}
    if kind == "focus":
        try:
            ok = node.queryComponent().grabFocus()
        except NotImplementedError:
            ok = False
        if not ok:
            raise Failure("action_failed", f"Could not focus {node.name!r}. Click its box instead.")
        return {"path": path, "name": node.name, "did": "focus"}
    if kind == "set":
        text = options.get("text")
        if not isinstance(text, str):
            raise Failure("usage", "set needs text.")
        try:
            ok = node.queryEditableText().setTextContents(text)
        except NotImplementedError:
            ok = False
        if not ok:
            raise Failure("action_failed", f"{node.name!r} does not take text. Focus it and type instead.")
        return {"path": path, "name": node.name, "did": "set"}
    raise Failure("usage", "do must be press, focus, or set.")


# Recordings and other media, read back in chunks so nothing assumes a disk shared with the client.


def recording():
    try:
        with open(RECORDING) as file:
            state = json.load(file)
    except (OSError, ValueError):
        return None
    return state if alive(state.get("pid", 0)) or os.path.exists(state.get("file", "")) else None


def record_start(options):
    return start_recording(options)


def start_recording(options):
    private_dir(MEDIA_DIR)
    current = recording()
    if current and alive(current["pid"]):
        raise Failure("already_recording", "The desktop is already recording. Stop that recording first.")
    seconds = max(1, min(int(options.get("maxSeconds", 600)), 3600))
    media = secrets.token_hex(16)
    path = os.path.join(MEDIA_DIR, f"{media}.mp4")
    log = open(os.path.join(MEDIA_DIR, "recording.log"), "w")
    # libx264 needs even dimensions; the viewer can resize the screen to any size.
    process = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "1",
         "-framerate", "15", "-i", os.environ.get("DISPLAY", ":1"), "-t", str(seconds),
         "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
        stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
    )
    with open(RECORDING, "w") as file:
        json.dump({"id": media, "pid": process.pid, "file": path, "started": time.time()}, file)
    time.sleep(1)
    if process.poll() is not None:
        os.remove(RECORDING)
        with open(os.path.join(MEDIA_DIR, "recording.log")) as file:
            raise Failure("capture_failed", f"The recording did not start: {file.read().strip()[-300:]}")
    return {"id": media, "maxSeconds": seconds}


def record_stop(_):
    current = recording()
    if not current:
        raise Failure("not_recording", "The desktop is not recording.")
    pid = current["pid"]
    if alive(pid):
        # ffmpeg finishes the file when it gets SIGINT.
        os.kill(pid, signal.SIGINT)
        for _ in range(150):
            if not alive(pid):
                break
            time.sleep(0.1)
    os.remove(RECORDING)
    path = current["file"]
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        raise Failure("capture_failed", "The recording is empty.")
    probe = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
    try:
        duration = round(float(probe.stdout.strip()), 2)
    except ValueError:
        duration = None
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return {"id": current["id"], "size": os.path.getsize(path), "sha256": digest.hexdigest(), "seconds": duration}


def media_path(options):
    path = os.path.join(MEDIA_DIR, f"{check_id(options.get('id'))}.mp4")
    if not os.path.exists(path):
        raise Failure("not_found", "There is no such recording in the desktop.")
    return path


def media_read(options):
    path = media_path(options)
    offset = int(options.get("offset", 0))
    length = max(1, min(int(options.get("length", MAX_CHUNK)), MAX_CHUNK))
    with open(path, "rb") as file:
        file.seek(offset)
        data = file.read(length)
    return {"data": base64.b64encode(data).decode(), "eof": offset + len(data) >= os.path.getsize(path)}


def media_delete(options):
    os.remove(media_path(options))
    return {}


# Recipe steps. A step runs in the background; blobby-sandbox polls it for progress, callback requests, and
# its result, and answers requests by writing files only the desktop user can read.


def step_dir(options):
    return os.path.join(STEPS_DIR, check_id(options.get("id")))


def step_start(options):
    return launch_step(options)


def launch_step(options):
    """Starts a recipe step file (`run` in `cwd`) or any command (`argv`), in the background."""
    directory = step_dir(options)
    argv = options.get("argv")
    if argv is not None:
        if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
            raise Failure("usage", "argv must be a non-empty list of strings.")
        command, cwd = argv, os.path.expanduser("~")
    else:
        script, cwd = options.get("run"), options.get("cwd")
        if not isinstance(script, str) or not isinstance(cwd, str) or not os.path.isfile(os.path.join(cwd, script)):
            raise Failure("usage", f"The step file {script} is not in the recipe.")
        if script.endswith((".mjs", ".js", ".cjs")):
            command = [NODE, script]
        elif script.endswith(".py"):
            command = ["python3", script]
        elif script.endswith(".sh"):
            command = ["bash", script]
        else:
            command = [os.path.join(cwd, script)]
    private_dir(STEPS_DIR)
    if os.path.exists(directory):
        shutil.rmtree(directory)
    for sub in ("", "requests", "answers"):
        private_dir(os.path.join(directory, sub))
    with open(os.path.join(directory, "spec.json"), "w") as file:
        json.dump({"sandbox": options["sandbox"], "step": options["id"], "callbacks": options.get("callbacks", {})}, file)
    env = dict(os.environ, BLOBBY_STEP_DIR=directory, PATH=f"{SCRIPTS_DIR}:/opt/blobby/node/bin:{os.environ.get('PATH', '')}")
    secret = options.get("secret")
    if secret is not None:
        if not isinstance(secret, str) or not re.match(r"^[a-z0-9][a-z0-9-]{0,63}$", secret):
            raise Failure("usage", "secret must be a secret name.")
        env["BLOBBY_SECRET"] = secret
    log = open(os.path.join(directory, "log"), "w")
    process = subprocess.Popen(
        ["bash", "-c", '"$@"; echo $? > "$BLOBBY_STEP_DIR/exit"', "blobby-step", *command],
        cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
    )
    with open(os.path.join(directory, "pid"), "w") as file:
        file.write(str(process.pid))
    return {}


def read_json(path):
    try:
        with open(path) as file:
            return json.load(file)
    except (OSError, ValueError):
        return None


def whole_characters(data):
    """How many bytes of data end on a whole UTF-8 character: a split one waits for the next read."""
    start = len(data)
    while start > 0 and len(data) - start < 3 and (data[start - 1] & 0xC0) == 0x80:
        start -= 1
    if start > 0 and data[start - 1] >= 0xC0:
        lead = data[start - 1]
        if len(data) - (start - 1) < (2 if lead < 0xE0 else 3 if lead < 0xF0 else 4):
            return start - 1
    return len(data)


def step_poll(options):
    directory = step_dir(options)
    if not os.path.isdir(directory):
        raise Failure("not_found", "There is no such step in the desktop.")
    offset = int(options.get("offset", 0))
    progress_file = os.path.join(directory, "progress.log")
    lines = []
    if os.path.exists(progress_file):
        with open(progress_file, "rb") as file:
            file.seek(offset)
            data = file.read()
        complete = data[: data.rfind(b"\n") + 1]
        offset += len(complete)
        lines = complete.decode("utf8", "replace").splitlines()
    answered = set(os.listdir(os.path.join(directory, "answers")))
    requests = []
    for name in sorted(os.listdir(os.path.join(directory, "requests"))):
        if name.endswith(".json") and name not in answered:
            request = read_json(os.path.join(directory, "requests", name))
            if request:
                requests.append(request)
    code = None
    try:
        with open(os.path.join(directory, "exit")) as file:
            code = int(file.read().strip())
    except (OSError, ValueError):
        try:
            pid = int(open(os.path.join(directory, "pid")).read())
        except (OSError, ValueError):
            pid = 0
        if not pid or not alive(pid):
            # bash writes the exit file as it ends; check once more before calling the step lost.
            time.sleep(0.2)
            if not os.path.exists(os.path.join(directory, "exit")):
                code = 1
    # Read after the exit, so once the step has exited, all its output is here.
    output_offset = int(options.get("outputOffset", 0))
    log_file = os.path.join(directory, "log")
    data = b""
    with contextlib.suppress(OSError), open(log_file, "rb") as file:
        file.seek(output_offset)
        data = file.read(OUTPUT_CHUNK)
    cut = whole_characters(data)
    size = os.path.getsize(log_file) if os.path.exists(log_file) else 0
    if code is not None and output_offset + len(data) >= size:
        cut = len(data)
    output_offset += cut
    output = data[:cut].decode("utf8", "replace")
    output_done = code is not None and output_offset >= size
    error = (read_json(os.path.join(directory, "error.json")) or {}).get("message")
    if code not in (None, 0) and not error:
        with open(os.path.join(directory, "log"), errors="replace") as file:
            tail = file.read().strip().splitlines()[-5:]
        error = " / ".join(tail) or f"The step exited with code {code}."
    return {
        "progress": lines,
        "offset": offset,
        "requests": requests,
        "exit": code,
        "result": read_json(os.path.join(directory, "result.json")) if code is not None else None,
        "output": output,
        "outputOffset": output_offset,
        "outputDone": output_done,
        "error": error,
    }


def step_answer(options):
    directory = step_dir(options)
    request = check_id(options.get("request"), "request")
    path = os.path.join(directory, "answers", f"{request}.json")
    descriptor = os.open(f"{path}.tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump(options.get("answer", {}), file)
    os.rename(f"{path}.tmp", path)
    return {}


def step_stop(options):
    directory = step_dir(options)
    try:
        pid = int(open(os.path.join(directory, "pid")).read())
        os.killpg(pid, signal.SIGTERM)
    except (OSError, ValueError):
        pass
    shutil.rmtree(directory, ignore_errors=True)
    return {}


def status(_):
    session = run(["pgrep", "-u", str(os.getuid()), "-f", "^/bin/bash /opt/blobby/(runtime|guest)/session.sh"]).returncode == 0
    # GNOME Shell takes its bus name once it is up, a moment before it paints.
    shell = session and "true" in run(
        ["gdbus", "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
         "--method", "org.freedesktop.DBus.NameHasOwner", "org.gnome.Shell"]
    ).stdout
    current = recording()
    return {"session": session, "ready": shell, "recording": current["id"] if current and alive(current["pid"]) else None}


OPERATIONS = {
    "status": status,
    "screenshot": screenshot,
    "input": input_,
    "resize": resize,
    "ui.snapshot": ui_snapshot,
    "ui.act": ui_act,
    "ui.wait": ui_wait,
    "record.start": record_start,
    "record.stop": record_stop,
    "media.read": media_read,
    "media.delete": media_delete,
    "step.start": step_start,
    "step.poll": step_poll,
    "step.answer": step_answer,
    "step.stop": step_stop,
}


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "exec":
        return exec_(sys.argv[3:] if len(sys.argv) > 2 and sys.argv[2] == "--" else sys.argv[2:])
    if len(sys.argv) < 2 or sys.argv[1] not in OPERATIONS:
        print(json.dumps({"ok": False, "code": "usage", "error": f"Operations: {', '.join(OPERATIONS)}"}))
        return 2
    try:
        options = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        if not isinstance(options, dict):
            raise Failure("usage", "Options must be a JSON object.")
        result = OPERATIONS[sys.argv[1]](options)
    except Failure as failure:
        print(json.dumps({"ok": False, "code": failure.code, "error": str(failure)}))
        return 1
    except ValueError as error:
        print(json.dumps({"ok": False, "code": "usage", "error": str(error)}))
        return 1
    print(json.dumps({"ok": True, **result}))
    return 0


sys.exit(main())
