from pathlib import Path
from tempfile import TemporaryDirectory
import subprocess

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "logo-2.png"
ASSETS = ROOT / "apps" / "desktop" / "assets"
PNG_OUTPUT = ASSETS / "app-icon.png"
ICNS_OUTPUT = ASSETS / "app-icon.icns"

SIZE = 1024
BACKGROUND = "#0f0f11"
RECT_INSET = 72
RECT_RADIUS = 210
GLYPH_SIZE = 360


def build_icon() -> Image.Image:
    source = Image.open(SOURCE).convert("RGBA")
    luminance = source.convert("L")
    alpha = ImageChops.multiply(luminance, source.getchannel("A"))
    alpha = alpha.point(lambda value: 0 if value < 24 else value)
    glyph = Image.new("RGBA", source.size, "white")
    glyph.putalpha(alpha)
    bounds = alpha.getbbox()
    if bounds:
        glyph = glyph.crop(bounds)
    scale = min(GLYPH_SIZE / glyph.width, GLYPH_SIZE / glyph.height)
    glyph = glyph.resize(
        (round(glyph.width * scale), round(glyph.height * scale)),
        Image.Resampling.LANCZOS,
    )

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle(
        (RECT_INSET, RECT_INSET, SIZE - RECT_INSET, SIZE - RECT_INSET),
        radius=RECT_RADIUS,
        fill=BACKGROUND,
    )
    position = ((SIZE - glyph.width) // 2, (SIZE - glyph.height) // 2)
    icon.alpha_composite(glyph, position)
    return icon


def generate_icns(icon: Image.Image) -> None:
    sizes = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    with TemporaryDirectory() as temporary:
        iconset = Path(temporary) / "app-icon.iconset"
        iconset.mkdir()
        for filename, size in sizes.items():
            resized = icon.resize((size, size), Image.Resampling.LANCZOS)
            resized.save(iconset / filename)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(ICNS_OUTPUT)],
            check=True,
        )


ASSETS.mkdir(parents=True, exist_ok=True)
app_icon = build_icon()
app_icon.save(PNG_OUTPUT)
generate_icns(app_icon)
