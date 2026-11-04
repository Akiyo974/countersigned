"""Render docs/assets/demo.gif from real command output.

Usage:  python3 scripts/render-demo.py . docs/assets/demo.gif
Needs Pillow and DejaVu Sans Mono. Every frame comes from commands actually run
against a fresh temporary store, so the GIF can never drift from the code.
"""
import os, re, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

REPO = sys.argv[1]
OUT = sys.argv[2]

COLS, ROWS = 100, 22
FONT_SIZE = 15
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", FONT_SIZE)
BOLD = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", FONT_SIZE)
CW = round(FONT.getlength("M"))
LH = FONT_SIZE + 6
PAD_X, PAD_TOP, PAD_BOTTOM, BAR = 18, 14, 16, 34
W = PAD_X * 2 + CW * COLS
H = BAR + PAD_TOP + LH * ROWS + PAD_BOTTOM

BG = (13, 17, 23); BARBG = (22, 27, 34); FG = (230, 237, 243); DIM = (125, 133, 144)
COLORS = {31: (255, 123, 114), 32: (63, 185, 80), 33: (210, 153, 34), 36: (121, 192, 255)}
PROMPT = (63, 185, 80)

store = tempfile.mkdtemp()
env = dict(os.environ, TOLLGATE_DIR=store, FORCE_COLOR="1")
env.pop("NO_COLOR", None)

def run(cmd):
    r = subprocess.run(cmd, shell=True, cwd=REPO, env=env, capture_output=True, text=True)
    return (r.stdout + r.stderr).rstrip("\n")

# (what the viewer sees typed, what actually runs, hold seconds after output)
def last_id():
    return open(os.path.join(store, "last-plan")).read().strip()

SCENES = [
    ("# your agent wants to change the ERP. it can only propose:", None, 0.4),
    ("agent plan", "node examples/erp/agent.ts plan", 3.2),
    ("# it tries to skip the human:", None, 0.3),
    ("agent apply", "node examples/erp/agent.ts apply", 2.6),
    ("CLEAR", None, 0),
    ("# you review the exact effects and approve, from your own terminal:", None, 0.3),
    ("tollgate approve {id} --yes", "node src/cli.ts approve {id} --by christen --yes | tail -1", 1.6),
    ("agent apply", "node examples/erp/agent.ts apply", 3.0),
    ("# the agent retries (timeout, crash, confused model). nothing runs twice:", None, 0.3),
    ("agent apply | tail -1", "node examples/erp/agent.ts apply | tail -1", 2.4),
    ("CLEAR", None, 0),
    ("# the ERP answers OK, but the write did not stick:", None, 0.3),
    ("agent flaky", "node examples/erp/agent.ts flaky", 4.5),
    ("tollgate ledger verify", "node src/cli.ts ledger verify", 3.5),
]

ANSI = re.compile(r"\x1b\[([0-9;]*)m")

def parse(line):
    """-> list of (text, color, bold)"""
    out, color, bold, pos = [], FG, False, 0
    for m in ANSI.finditer(line):
        if m.start() > pos:
            out.append((line[pos:m.start()], color, bold))
        for code in [int(c) for c in (m.group(1) or "0").split(";") if c]:
            if code == 0: color, bold = FG, False
            elif code == 1: bold = True
            elif code == 2: color = DIM
            elif code in COLORS: color = COLORS[code]
        pos = m.end()
    if pos < len(line):
        out.append((line[pos:], color, bold))
    return out

def wrap(segments, width):
    """wrap styled segments to width, continuation lines indented 4"""
    lines, cur, n = [], [], 0
    for text, color, bold in segments:
        while text:
            room = width - n
            if len(text) <= room:
                cur.append((text, color, bold)); n += len(text); text = ""
            else:
                cut = text.rfind(" ", 0, room)
                cut = room if cut <= 0 else cut + 1
                cur.append((text[:cut].rstrip(), color, bold))
                lines.append(cur)
                cur, n = [("    ", FG, False)], 4
                text = text[cut:]
    lines.append(cur)
    return lines

frames, durations = [], []
buf = []  # list of styled lines

def draw(cursor=None):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, BAR], fill=BARBG)
    for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 20, 12, 28 + i * 20, 24], fill=col)
    title = "tollgate: plan / approve / apply for AI agent actions"
    d.text(((W - FONT.getlength(title)) / 2, 9), title, font=FONT, fill=DIM)
    visible = buf[-ROWS:]
    for r, segs in enumerate(visible):
        x = PAD_X
        y = BAR + PAD_TOP + r * LH
        for text, color, bold in segs:
            f = BOLD if bold else FONT
            d.text((x, y), text, font=f, fill=color)
            x += CW * len(text)
    if cursor is not None:
        r = min(len(buf), ROWS) - 1
        d.rectangle([cursor, BAR + PAD_TOP + r * LH + 1, cursor + CW - 2, BAR + PAD_TOP + r * LH + LH - 3], fill=FG)
    return img

def push(img, secs):
    frames.append(img); durations.append(int(secs * 1000))

def prompt_line(typed):
    if typed.startswith("#"):
        return [("$ ", PROMPT, True), (typed, DIM, False)]
    return [("$ ", PROMPT, True), (typed, FG, False)]

push(draw(), 0.6)
for typed, cmd, hold in SCENES:
    if typed == "CLEAR":
        buf.clear(); push(draw(), 0.35); continue
    if "{id}" in typed:
        pid = last_id(); typed = typed.replace("{id}", pid); cmd = cmd.replace("{id}", pid)
    buf.append(prompt_line(""))
    step = 2 if typed.startswith("#") else 1
    for i in range(0, len(typed) + 1, step):
        buf[-1] = prompt_line(typed[:i])
        x = PAD_X + CW * (2 + i)
        push(draw(cursor=x), 0.028 if typed.startswith("#") else 0.045)
    buf[-1] = prompt_line(typed)
    if cmd is None:
        push(draw(), hold); continue
    output = run(cmd)
    push(draw(), 0.25)
    for raw in output.split("\n"):
        buf.extend(wrap(parse(raw), COLS))
        push(draw(), 0.06)
    buf.append([])
    push(draw(), hold)

# GIF with a shared palette keeps it small and stable
pal = frames[len(frames) // 2].convert("P", palette=Image.ADAPTIVE, colors=64)
pframes = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
pframes[0].save(OUT, save_all=True, append_images=pframes[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(f"{len(frames)} frames, {sum(durations)/1000:.1f}s, {os.path.getsize(OUT)/1e6:.2f} MB, {W}x{H}")
