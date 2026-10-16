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

# The API and MCP settings pages ship banner art showing upstream URLs and names.
COVERS = os.path.join("packages", "twenty-front", "src", "modules", "settings", "mcp-and-apis", "assets")
COVER_TEXT = {"cover": ("ZeGravity CRM API", "REST and GraphQL access to your workspace"),
              "mcp-cover": ("ZeGravity CRM for AI assistants", "Connect Claude and other MCP clients")}
COVER_THEME = {"dark": ("#06070f", "#1a1640", "#ffffff", "#b3a8ff"), "light": ("#f6f5ff", "#e3defd", "#14112e", "#5b4bd6")}
for prefix, (title, subtitle) in COVER_TEXT.items():
    for theme, (start, end, ink, accent) in COVER_THEME.items():
        svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1388" height="300" viewBox="0 0 1388 300">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{start}"/><stop offset="1" stop-color="{end}"/></linearGradient></defs>
<rect width="1388" height="300" fill="url(#bg)"/>
<circle cx="1200" cy="60" r="220" fill="{accent}" opacity="0.10"/>
<circle cx="1260" cy="250" r="120" fill="#4fd8ff" opacity="0.10"/>
<text x="290" y="140" font-family="DejaVu Sans, Arial, sans-serif" font-size="52" font-weight="700" fill="{ink}">{title}</text>
<text x="290" y="192" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" fill="{accent}">{subtitle}</text>
</svg>"""
        banner = Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode()))).convert("RGBA")
        banner.alpha_composite(render(180), (70, 60))
        banner.save(os.path.join(COVERS, f"{prefix}-{theme}.png"), optimize=True)
shutil.copyfile(os.path.join(HERE, "zegravity-mark.svg"), os.path.join(FRONT_PUBLIC, "integrations", "twenty-logo.svg"))
print(f"regenerated {count} icons")
