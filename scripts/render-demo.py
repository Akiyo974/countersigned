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
def _font(names):
    dirs = [os.environ.get("DEMO_FONT_DIR", ""), "/mnt/skills/examples/canvas-design/canvas-fonts", "/usr/share/fonts/truetype/dejavu"]
    for d in dirs:
        for n in names:
            p = os.path.join(d, n)
            if d and os.path.exists(p):
                return ImageFont.truetype(p, FONT_SIZE)
    raise SystemExit("no monospace font found: set DEMO_FONT_DIR")
FONT = _font(["GeistMono-Regular.ttf", "DejaVuSansMono.ttf"])
BOLD = _font(["GeistMono-Bold.ttf", "DejaVuSansMono-Bold.ttf"])
CW = round(FONT.getlength("M"))
LH = FONT_SIZE + 6
PAD_X, PAD_TOP, PAD_BOTTOM, BAR = 18, 14, 16, 34
W = PAD_X * 2 + CW * COLS
H = BAR + PAD_TOP + LH * ROWS + PAD_BOTTOM

# The "registre" palette: ink on paper, one red. Same tokens as the website.
BG = (236, 233, 225); BARBG = (227, 223, 212); FG = (20, 20, 18); DIM = (98, 93, 83)
COLORS = {31: (180, 45, 20), 32: (46, 94, 58), 33: (138, 90, 0), 36: (20, 20, 18)}
RULE = (212, 207, 194); INK = (20, 20, 18); RED = (210, 56, 27)
PROMPT = RED

store = tempfile.mkdtemp()
env = dict(os.environ, COUNTERSIGNED_DIR=store, FORCE_COLOR="1")
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
    ("countersigned approve {id} --yes", "node src/cli.ts approve {id} --by christen --yes | tail -1", 1.6),
    ("agent apply", "node examples/erp/agent.ts apply", 3.0),
    ("# the agent retries (timeout, crash, confused model). nothing runs twice:", None, 0.3),
    ("agent apply | tail -1", "node examples/erp/agent.ts apply | tail -1", 2.4),
    ("CLEAR", None, 0),
    ("# the ERP answers OK, but the write did not stick:", None, 0.3),
    ("agent flaky", "node examples/erp/agent.ts flaky", 4.5),
    ("countersigned ledger verify", "node src/cli.ts ledger verify", 3.5),
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
    d.line([0, BAR, W, BAR], fill=INK, width=2)
    d.rectangle([0, 0, W - 1, H - 1], outline=INK, width=2)
    d.ellipse([18, 11, 31, 24], outline=RED, width=2)
    d.ellipse([22, 15, 27, 20], fill=RED)
    d.text((40, 9), "COUNTERSIGNED", font=FONT, fill=INK)
    title = "TERMINAL \u00b7 FIG. 3"
    d.text((W - 20 - FONT.getlength(title), 9), title, font=FONT, fill=DIM)
    for y in range(BAR + PAD_TOP + LH - 4, H - PAD_BOTTOM, LH):
        d.line([2, y, W - 3, y], fill=RULE, width=1)
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
