#!/usr/bin/env python3
"""
Regenerates icon.png, the 128x128 marketplace icon shown in the Extensions list.

    python3 make-icon.py

The activity bar uses icon.svg instead — that one is monochrome and VS Code
masks it to the theme colour, so it can't be a PNG.

This exists because a PNG is the one file here that can't be copied as text;
anything that moves the project around (a paste, an email, a sync that mangles
binaries) can regenerate it from this rather than lose it.

Needs Pillow:  pip install Pillow
"""

from PIL import Image, ImageDraw

SUPERSAMPLE = 4  # draw big, shrink down — cheap anti-aliasing
SIZE = 128
W = SIZE * SUPERSAMPLE

BG = (35, 42, 54, 255)  # slate background
DIM = (89, 99, 122, 255)  # inactive code lines
ACTIVE = (232, 237, 247, 255)  # the line your cursor is on
LANE = (138, 90, 51, 255)  # git lane behind the commit
DOT = (255, 157, 77, 255)  # the commit itself


def main():
    image = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle([0, 0, W - 1, W - 1], radius=28 * SUPERSAMPLE, fill=BG)

    # Three code lines, the middle one being the "current" line.
    for x, y, width, colour in [
        (24, 36, 56, DIM),
        (24, 60, 44, ACTIVE),
        (24, 84, 64, DIM),
    ]:
        draw.rounded_rectangle(
            [x * SUPERSAMPLE, y * SUPERSAMPLE, (x + width) * SUPERSAMPLE, (y + 8) * SUPERSAMPLE],
            radius=4 * SUPERSAMPLE,
            fill=colour,
        )

    # A git lane down the right, with the commit sitting on the active line.
    lane_x = 97
    draw.rounded_rectangle(
        [(lane_x - 2) * SUPERSAMPLE, 30 * SUPERSAMPLE, (lane_x + 2) * SUPERSAMPLE, 98 * SUPERSAMPLE],
        radius=2 * SUPERSAMPLE,
        fill=LANE,
    )

    centre_y = 64
    outer, inner = 11, 5
    draw.ellipse(
        [
            (lane_x - outer) * SUPERSAMPLE,
            (centre_y - outer) * SUPERSAMPLE,
            (lane_x + outer) * SUPERSAMPLE,
            (centre_y + outer) * SUPERSAMPLE,
        ],
        fill=DOT,
    )
    # Punch a hole so the commit reads as a ring rather than a blob.
    draw.ellipse(
        [
            (lane_x - inner) * SUPERSAMPLE,
            (centre_y - inner) * SUPERSAMPLE,
            (lane_x + inner) * SUPERSAMPLE,
            (centre_y + inner) * SUPERSAMPLE,
        ],
        fill=BG,
    )

    image.resize((SIZE, SIZE), Image.LANCZOS).save('icon.png')
    print('wrote icon.png')


if __name__ == '__main__':
    main()
