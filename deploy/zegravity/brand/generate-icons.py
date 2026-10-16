"""Regenerate every app icon in twenty-front/public from the ZeGravity mark.

Run from the repository root: python3 deploy/zegravity/brand/generate-icons.py
"""
import io
import os
import shutil

import cairosvg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FRONT_PUBLIC = os.path.join("packages", "twenty-front", "public", "images")
MARK = open(os.path.join(HERE, "zegravity-mark.svg")).read()
CANVAS = (6, 7, 15, 255)


def render(size):
    png = cairosvg.svg2png(bytestring=MARK.encode(), output_width=size, output_height=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


count = 0
for directory, _, files in os.walk(os.path.join(FRONT_PUBLIC, "icons")):
    for name in files:
        if not name.endswith(".png"):
            continue
        path = os.path.join(directory, name)
        width, height = Image.open(path).size
        if width == height:
            image = render(width)
        else:
            # Wide tiles and splash screens: dark canvas with the mark centred.
            image = Image.new("RGBA", (width, height), CANVAS)
            side = int(min(width, height) * 0.6)
            image.alpha_composite(render(side), ((width - side) // 2, (height - side) // 2))
        image.save(path, optimize=True)
        count += 1

render(256).save(os.path.join(FRONT_PUBLIC, "icons", "zegravity-workspace-logo.png"), optimize=True)
shutil.copyfile(os.path.join(HERE, "zegravity-mark.svg"), os.path.join(FRONT_PUBLIC, "integrations", "twenty-logo.svg"))
print(f"regenerated {count} icons")
