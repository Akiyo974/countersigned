"""Shrink the rendered PNGs in a folder: 128-color palette, no dithering (paper grain stays subtle)."""
import os
import sys

from PIL import Image

folder = sys.argv[1]
for name in sorted(os.listdir(folder)):
    if not name.endswith(".png"):
        continue
    path = os.path.join(folder, name)
    before = os.path.getsize(path)
    img = Image.open(path).convert("RGB").quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    img.save(path, optimize=True)
    print(f"{name}: {before // 1024} KB -> {os.path.getsize(path) // 1024} KB")
