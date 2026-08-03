#!/usr/bin/env python3
"""Generate CrowdCut's one-page festival roadmap PDF."""

from pathlib import Path
from textwrap import wrap

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import landscape, letter
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "CrowdCut_Next_Steps.pdf"

INK = HexColor("#07080D")
PANEL = HexColor("#11131C")
PANEL_2 = HexColor("#171A25")
WHITE = HexColor("#F8FAFC")
MUTED = HexColor("#A6ADBB")
ACID = HexColor("#F1FF38")
PINK = HexColor("#FF3D84")
CYAN = HexColor("#63E6FF")
VIOLET = HexColor("#9A70FF")
LINE = HexColor("#303443")


def rounded_box(c, x, y, w, h, fill, stroke=LINE, radius=12, width=1):
    c.setLineWidth(width)
    c.setStrokeColor(stroke)
    c.setFillColor(fill)
    c.roundRect(x, y, w, h, radius, stroke=1, fill=1)


def text(c, value, x, y, size=10, color=WHITE, font="Helvetica", align="left"):
    c.setFillColor(color)
    c.setFont(font, size)
    if align == "right":
        c.drawRightString(x, y, value)
    elif align == "center":
        c.drawCentredString(x, y, value)
    else:
        c.drawString(x, y, value)


def wrapped(c, value, x, y, width_chars, size=9, leading=12, color=MUTED, font="Helvetica"):
    lines = wrap(value, width=width_chars, break_long_words=False, break_on_hyphens=False)
    for line in lines:
        text(c, line, x, y, size=size, color=color, font=font)
        y -= leading
    return y


def bullet_list(c, items, x, y, width_chars=39):
    for item in items:
        text(c, "+", x, y + 1, size=10, color=ACID, font="Helvetica-Bold")
        y = wrapped(c, item, x + 14, y, width_chars, size=8.4, leading=10.5, color=WHITE)
        y -= 6
    return y


def metric(c, x, y, accent, value, label):
    c.setStrokeColor(accent)
    c.setLineWidth(3)
    c.line(x, y + 3, x, y + 34)
    text(c, value, x + 10, y + 20, size=14, color=WHITE, font="Helvetica-Bold")
    text(c, label, x + 10, y + 6, size=6.7, color=MUTED, font="Helvetica-Bold")


def draw_pdf():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=landscape(letter))
    width, height = landscape(letter)

    c.setTitle("CrowdCut Live - Festival Roadmap")
    c.setAuthor("CrowdCut")
    c.setSubject("Next steps from live hackathon demo to festival-scale product")

    c.setFillColor(INK)
    c.rect(0, 0, width, height, stroke=0, fill=1)

    # Brand ring.
    c.setLineWidth(4)
    c.setStrokeColor(ACID)
    c.circle(43, 573, 11, stroke=1, fill=0)
    c.setStrokeColor(PINK)
    c.arc(32, 562, 54, 584, 300, 82)

    text(c, "CROWDCUT", 64, 568, size=18, color=WHITE, font="Helvetica-Bold")
    text(c, "LIVE", 168, 572, size=7, color=INK, font="Helvetica-Bold")
    c.setFillColor(PINK)
    c.roundRect(164, 567, 27, 12, 3, stroke=0, fill=1)
    text(c, "LIVE", 177.5, 570.2, size=6.5, color=WHITE, font="Helvetica-Bold", align="center")

    text(c, "FROM HACKATHON DEMO TO FESTIVAL INFRASTRUCTURE", 762, 574,
         size=8.3, color=ACID, font="Helvetica-Bold", align="right")

    # Hero promise.
    rounded_box(c, 30, 474, 732, 72, PANEL, stroke=LINE, radius=14)
    text(c, "THE CROWD BECOMES THE CAMERA NETWORK.", 49, 513, size=22, color=WHITE, font="Helvetica-Bold")
    text(c, "Turn the phones already in the audience into a live production - then give every fan a personal film.",
         49, 489, size=10.5, color=MUTED)
    c.setFillColor(ACID)
    c.roundRect(650, 493, 86, 30, 15, stroke=0, fill=1)
    text(c, "ROADMAP", 693, 503, size=8.3, color=INK, font="Helvetica-Bold", align="center")

    # Three strategic columns.
    columns = [
        (
            "01", "FESTIVAL-READY SCALE", CYAN,
            [
                "Stage-scoped rooms and official-app deep links.",
                "Adaptive uplink plus offline Burst queues for congested festival networks.",
                "25-100+ device load validation and automatic video quality tiers.",
                "Venue moderation, artist rights, consent, and content lifecycle controls.",
            ],
        ),
        (
            "02", "FAN + ARTIST PRODUCT", PINK,
            [
                "Artist-triggered hero moments and official synchronized Burst cues.",
                "Personal 'where I stood' edits and collectible set memories.",
                "Live Cuts across stages: see what it actually looks like right now.",
                "Artist-approved fan footage pools for recap and social teams.",
            ],
        ),
        (
            "03", "INTEGRATIONS + GTM", VIOLET,
            [
                "Outside Lands app placement with ticket-linked identity and permissions.",
                "JamBase schedule, set, stage, and artist context.",
                "Official livestream integration: crowd perspectives beside the broadcast.",
                "Sponsor moments that reward real contribution instead of screen time.",
            ],
        ),
    ]

    col_y, col_h, gap = 258, 198, 12
    col_w = (732 - (2 * gap)) / 3
    for index, (number, title_value, accent, items) in enumerate(columns):
        x = 30 + index * (col_w + gap)
        rounded_box(c, x, col_y, col_w, col_h, PANEL_2, stroke=LINE, radius=12)
        c.setFillColor(accent)
        c.roundRect(x + 14, col_y + col_h - 39, 29, 24, 6, stroke=0, fill=1)
        text(c, number, x + 28.5, col_y + col_h - 31, size=8.5, color=INK,
             font="Helvetica-Bold", align="center")
        text(c, title_value, x + 53, col_y + col_h - 31, size=9.1, color=WHITE,
             font="Helvetica-Bold")
        c.setStrokeColor(accent)
        c.setLineWidth(1.4)
        c.line(x + 14, col_y + col_h - 50, x + col_w - 14, col_y + col_h - 50)
        bullet_list(c, items, x + 16, col_y + col_h - 70, width_chars=37)

    # Compounding flywheel.
    rounded_box(c, 30, 188, 732, 53, PANEL, stroke=LINE, radius=12)
    text(c, "COMPOUNDING FLYWHEEL", 48, 218, size=7.3, color=ACID, font="Helvetica-Bold")
    stages = ["MORE LIVE ANGLES", "BETTER SHARED FILM", "BETTER PERSONAL CUTS", "MORE SHARING", "MORE CONTRIBUTORS"]
    stage_x = [48, 185, 328, 480, 602]
    for i, label in enumerate(stages):
        text(c, label, stage_x[i], 201, size=7.8, color=WHITE, font="Helvetica-Bold")
        if i < len(stages) - 1:
            c.setStrokeColor([CYAN, PINK, VIOLET, ACID][i])
            c.setLineWidth(1.6)
            c.line(stage_x[i] + 105, 204, stage_x[i + 1] - 10, 204)
            c.line(stage_x[i + 1] - 15, 208, stage_x[i + 1] - 10, 204)
            c.line(stage_x[i + 1] - 15, 200, stage_x[i + 1] - 10, 204)

    # Convex core + validation targets.
    rounded_box(c, 30, 64, 454, 106, PANEL, stroke=ACID, radius=12, width=1.4)
    text(c, "WHY CONVEX REMAINS THE CORE", 48, 144, size=9, color=ACID, font="Helvetica-Bold")
    wrapped(
        c,
        "Convex remains the source of truth for presence, scene revisions, synchronized capture membership, readiness, lifecycle, idempotency, and ownership - while the media and rendering providers can evolve independently.",
        48,
        123,
        78,
        size=9.1,
        leading=13,
        color=WHITE,
    )
    text(c, "REMOVE CONVEX AND THE CROWD STOPS BEHAVING LIKE ONE PRODUCTION.",
         48, 80, size=7.3, color=MUTED, font="Helvetica-Bold")

    rounded_box(c, 496, 64, 266, 106, PANEL, stroke=LINE, radius=12)
    text(c, "NEXT PROOF TARGETS", 514, 144, size=9, color=ACID, font="Helvetica-Bold")
    metric(c, 516, 101, CYAN, "<250 ms", "CONTROL-STATE PROPAGATION")
    metric(c, 637, 101, PINK, "<500 ms", "CAMERA SWITCH")
    metric(c, 516, 68, VIOLET, "T-3 / T+3", "EXACT BURST WINDOW")
    metric(c, 637, 68, ACID, ">95%", "ARTIFACT COMPLETION")

    # Footer.
    text(c, "LIVE", 30, 28, size=6.5, color=ACID, font="Helvetica-Bold")
    text(c, "crowdcut-live.ild.chatgpt.site", 58, 28, size=7.5, color=WHITE)
    text(c, "github.com/ElijahUmana/CrowdCut", 762, 28, size=7.5, color=MUTED, align="right")
    text(c, "ONE PERSON RECORDS A CLIP. A CROWD CREATES THE FILM.", 396, 10,
         size=6.5, color=PINK, font="Helvetica-Bold", align="center")

    c.showPage()
    c.save()
    print(OUTPUT)


if __name__ == "__main__":
    draw_pdf()
