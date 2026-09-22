"""Shared material for the eval cases: readings with known facts, focus data,
and rendered images (handwriting, screenshots, scans) for the vision methods.

The readings are SYNTHETIC on purpose. A real, famous passage can be answered
from memory; a made-up one can only be answered by reading it, so a wrong
number in the output is a reading failure and nothing else.
"""

from __future__ import annotations

import random
from pathlib import Path
from typing import List

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

IMG_DIR = Path(__file__).resolve().parent / "images"
FONTS = "/System/Library/Fonts/Supplemental/"
HAND = FONTS + "Bradley Hand Bold.ttf"
PRINT = FONTS + "Times New Roman.ttf"

# ---- readings --------------------------------------------------------------

CANAL = (
    "In March 1911, the Harlow Valley Irrigation District voted 212 to 187 to build the Pine Creek canal. "
    "Contrary to what the district's own pamphlets later claimed, the canal was not finished on schedule: "
    "construction, budgeted at $48,000, stopped twice, first in 1912 when the contractor, Elias Monk, went "
    "bankrupt, and again in 1914 when a flood destroyed the upper headgate. Water did not reach the lower "
    "farms until June 1916, five years after the vote and at a final cost of $131,500. Historians such as "
    "Dana Whitlow argue that the delay, not the canal itself, reshaped the valley: nearly a third of the "
    "original 94 farm families had sold their land to the Bexar Land Company by 1915, before a single acre "
    "was irrigated."
)
CANAL_FACTS = (
    "Facts in the canal reading: vote March 1911, 212 to 187; budget $48,000; stopped in 1912 (contractor Elias "
    "Monk went bankrupt -- the contractor, NOT the district) and 1914 (flood destroyed the upper headgate); "
    "the canal was NOT finished on schedule; water reached the lower farms June 1916, five years after the vote; "
    "final cost $131,500; Dana Whitlow argues the DELAY reshaped the valley; NEARLY A THIRD of the 94 original "
    "families (not all 94) sold to the Bexar Land Company by 1915, BEFORE any land was irrigated."
)

ENZYME = (
    "In the trial, catalase activity rose as temperature increased from 10°C to 37°C, peaking at 37°C with "
    "8.2 mL of oxygen per minute. At 50°C activity fell to 3.1 mL per minute, and at 65°C no oxygen was "
    "produced at all. When the 65°C sample was cooled back to 37°C, activity did not return. The pH trials "
    "were run separately, all at 25°C."
)
ENZYME_FACTS = (
    "Facts in the enzyme reading: peak 8.2 mL O2/min at 37°C; 3.1 mL/min at 50°C; zero at 65°C; cooling the 65°C "
    "sample back to 37°C did NOT restore activity (the enzyme was denatured: permanent shape change). The passage "
    "reports NO pH results at all, only that pH trials were run separately at 25°C. 8.2 / 3.1 = about 2.6."
)

# ---- images ----------------------------------------------------------------


def render(name: str, lines: List[str], hand: bool = False, size: int = 30, width: int = 1100,
           blur: float = 0.0, rotate: float = 0.0, noise: int = 0, contrast: float = 1.0) -> Path:
    """Render lines of text to a PNG and return its path (cached by name).

    Args:
        name: File stem under images/.
        lines: Text lines, drawn top to bottom.
        hand: Handwriting font (a photo of paper work) instead of print.
        size: Font size in pixels.
        width: Image width in pixels.
        blur: Gaussian blur radius (camera shake / out of focus).
        rotate: Degrees of tilt (a crooked scan).
        noise: Count of random specks (scanner dirt).
        contrast: <1.0 washes the page out (a faint photocopy).
    """
    IMG_DIR.mkdir(exist_ok=True)
    path = IMG_DIR / f"{name}.png"
    if path.exists():
        return path
    font = ImageFont.truetype(HAND if hand else PRINT, size)
    line_h = int(size * 1.55)
    img = Image.new("RGB", (width, line_h * len(lines) + 80), (252, 250, 244) if hand else "white")
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((40, 40 + i * line_h), line, fill=(25, 25, 60) if hand else "black", font=font)
    rng = random.Random(name)  # seeded by name: the same image every run
    for _ in range(noise):
        x, y = rng.randrange(img.width), rng.randrange(img.height)
        draw.ellipse((x, y, x + rng.randrange(1, 4), y + rng.randrange(1, 4)), fill=(90, 90, 90))
    if rotate:
        img = img.rotate(rotate, expand=True, fillcolor="white", resample=Image.BICUBIC)
    if contrast != 1.0:
        img = ImageEnhance.Contrast(img).enhance(contrast)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    img.save(path)
    return path


def wrap(text: str, width: int = 78) -> List[str]:
    """Greedy word wrap, so a paragraph renders as a page of lines."""
    lines, cur = [], ""
    for word in text.split():
        if len(cur) + len(word) + 1 > width:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
    return lines + [cur]


HOMEWORK_LINES = [
    "Algebra HW 3.2",
    "1)  3x + 7 = 25",
    "     3x = 18",
    "     x = 6",
    "2)  2(x - 3) = 4x + 8",
    "     2x - 3 = 4x + 8",
    "     -2x = 11",
    "     x = -5.5",
]

WORKSHEET_LINES = [
    "Name: ____________        Date: ________",
    "Stoichiometry Practice",
    "1. Balance the equation:   ____ Mg  +  ____ O2  ->  ____ MgO",
    "2. If 12.0 g of Mg burns completely, what mass of MgO forms?   ________ g",
    "Element   |   Molar mass (g/mol)",
    "Mg        |   24.3",
    "O         |   16.0",
]
WORKSHEET_TEXT = " ".join(WORKSHEET_LINES)

NOTES_LINES = [
    "Canal notes",
    "- vote was March 1911, 212 to 187",
    "- contractor Elias Monk went bankrupt 1912",
    "- flood wrecked the upper headgate in 1914",
    "- water reached lower farms June 1916",
    "- final cost $131,500 (budget was $48,000)",
]
NOTES_TEXT = " ".join(NOTES_LINES)

# ---- video captions --------------------------------------------------------

CAPTIONS = [
    (0, "Hey everyone, today we're walking through photosynthesis, start to finish."),
    (14, "It happens in the chloroplast, and it has two stages."),
    (31, "Stage one is the light reactions, in the thylakoid membranes."),
    (52, "Light hits chlorophyll and excites electrons."),
    (70, "Those electrons come from splitting water, which releases oxygen as a byproduct."),
    (95, "Quick aside: why are leaves green? Chlorophyll absorbs red and blue light and reflects green."),
    (121, "So the green you see is the light the plant is NOT using."),
    (140, "The light reactions make two things: ATP and NADPH."),
    (168, "Think of those as charged batteries for stage two."),
    (190, "Notice the light reactions do not make sugar. People get that wrong on tests all the time."),
    (222, "Stage two is the Calvin cycle, and it happens in the stroma."),
    (248, "It takes carbon dioxide from the air and fixes it using an enzyme called rubisco."),
    (275, "It spends the ATP and NADPH from stage one to build a three-carbon sugar called G3P."),
    (312, "It takes three turns of the cycle to net one G3P, and two G3P to make one glucose."),
    (340, "The Calvin cycle doesn't need light directly, but it stops soon after dark because it runs out of ATP and NADPH."),
    (371, "Recap: light reactions, thylakoid, make ATP and NADPH and release oxygen."),
    (389, "Calvin cycle, stroma, uses carbon dioxide to build sugar."),
    (402, "That's it. See you next time."),
]
CAPTION_PAYLOAD = [{"t": t, "text": text} for t, text in CAPTIONS]
VIDEO = {"title": "Photosynthesis in 7 minutes", "duration": 415, "auto": False}
VIDEO_FACTS = (
    "Caption timeline: 31s light reactions in thylakoid membranes; 70s water split releases oxygen; 95s why leaves "
    "are green (chlorophyll absorbs red+blue, reflects green); 140s light reactions make ATP and NADPH; 190s light "
    "reactions do NOT make sugar; 222s Calvin cycle in the stroma; 248s rubisco fixes CO2; 275s builds G3P; 312s three "
    "turns per G3P, two G3P per glucose; 340s Calvin cycle needs no light directly but stops after dark."
)

# ---- focus data (autopsy) --------------------------------------------------

SESSIONS = [
    {"day": "Mon", "start": "16:10", "plannedMin": 25, "actualMin": 27, "distractions": 1, "stepsDone": 3, "quit": False},
    {"day": "Mon", "start": "22:40", "plannedMin": 30, "actualMin": 2, "distractions": 0, "stepsDone": 0, "quit": True},
    {"day": "Tue", "start": "16:05", "plannedMin": 25, "actualMin": 25, "distractions": 0, "stepsDone": 4, "quit": False},
    {"day": "Tue", "start": "23:15", "plannedMin": 45, "actualMin": 1, "distractions": 0, "stepsDone": 0, "quit": True},
    {"day": "Wed", "start": "16:20", "plannedMin": 25, "actualMin": 31, "distractions": 2, "stepsDone": 3, "quit": False},
    {"day": "Wed", "start": "22:55", "plannedMin": 30, "actualMin": 9, "distractions": 4, "stepsDone": 1, "quit": True},
    {"day": "Thu", "start": "16:00", "plannedMin": 25, "actualMin": 24, "distractions": 1, "stepsDone": 3, "quit": False},
    {"day": "Thu", "start": "23:05", "plannedMin": 60, "actualMin": 3, "distractions": 1, "stepsDone": 0, "quit": True},
    {"day": "Fri", "start": "16:30", "plannedMin": 25, "actualMin": 26, "distractions": 1, "stepsDone": 2, "quit": False},
    {"day": "Sat", "start": "11:00", "plannedMin": 50, "actualMin": 48, "distractions": 3, "stepsDone": 5, "quit": False},
]


def session_facts() -> str:
    """Ground-truth stats for the autopsy judge, computed (never typed by hand)."""
    afternoon = [s for s in SESSIONS if s["start"].startswith("16")]
    late = [s for s in SESSIONS if s["start"] >= "22:00"]
    total = sum(s["actualMin"] for s in SESSIONS)
    return (
        f"Computed from the data: {len(SESSIONS)} sessions, {total} actual minutes in total. "
        f"{len(afternoon)} sessions started around 4pm: none quit, average actual {sum(s['actualMin'] for s in afternoon) / len(afternoon):.1f} min, "
        f"{sum(s['stepsDone'] for s in afternoon)} steps done. "
        f"{len(late)} sessions started after 10pm: ALL {sum(1 for s in late if s['quit'])} were quit, average actual "
        f"{sum(s['actualMin'] for s in late) / len(late):.1f} min against an average plan of {sum(s['plannedMin'] for s in late) / len(late):.1f} min, "
        f"{sum(s['stepsDone'] for s in late)} step done in total. "
        f"Quit sessions overall: {sum(1 for s in SESSIONS if s['quit'])} of {len(SESSIONS)}. "
        f"Late-night plans are the LONGEST plans (30-60 min) and the shortest actuals. The Saturday 11:00 session was the longest actual (48 min, 5 steps)."
    )
