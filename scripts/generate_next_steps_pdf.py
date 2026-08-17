#!/usr/bin/env python3
"""Generate ManyVue's one-page product opportunity and roadmap PDF."""

from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import landscape, letter
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "ManyVue_Next_Steps.pdf"

INK = HexColor("#050509")
PANEL = HexColor("#10121A")
PANEL_2 = HexColor("#171A24")
PANEL_3 = HexColor("#202331")
WHITE = HexColor("#FAFBFF")
MUTED = HexColor("#AEB4C2")
DIM = HexColor("#737A8A")
ACID = HexColor("#F4FF3F")
PINK = HexColor("#FF367C")
CYAN = HexColor("#68E7FF")
VIOLET = HexColor("#A36BFF")
LINE = HexColor("#323746")


def label(c, value, x, y, size=8, color=WHITE, font="Helvetica-Bold", align="left"):
    c.setFillColor(color)
    c.setFont(font, size)
    if align == "right":
        c.drawRightString(x, y, value)
    elif align == "center":
        c.drawCentredString(x, y, value)
    else:
        c.drawString(x, y, value)


def wrap_lines(value, font, size, max_width):
    words = value.split()
    lines = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if current and stringWidth(candidate, font, size) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def paragraph(c, value, x, y, max_width, size=8.5, leading=11, color=MUTED,
              font="Helvetica", max_lines=None):
    lines = wrap_lines(value, font, size, max_width)
    if max_lines:
        lines = lines[:max_lines]
    for line in lines:
        label(c, line, x, y, size=size, color=color, font=font)
        y -= leading
    return y


def box(c, x, y, w, h, fill=PANEL, stroke=LINE, radius=12, line_width=1):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(line_width)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def section_title(c, kicker, title, x, y, accent=ACID):
    label(c, kicker, x, y, size=6.4, color=accent, font="Helvetica-Bold")
    label(c, title, x, y - 15, size=12, color=WHITE, font="Helvetica-Bold")


def audience_row(c, x, y, w, tag, accent, title, body):
    box(c, x, y, w, 39, fill=PANEL_2, stroke=LINE, radius=8)
    c.setFillColor(accent)
    c.roundRect(x + 9, y + 10, 47, 19, 9, fill=1, stroke=0)
    label(c, tag, x + 32.5, y + 16.1, size=6.2, color=INK, align="center")
    label(c, title, x + 65, y + 23, size=8.4, color=WHITE)
    paragraph(c, body, x + 65, y + 10, w - 77, size=6.9, leading=8.2, color=MUTED, max_lines=2)


def possibility_card(c, x, y, w, h, number, accent, title, body):
    box(c, x, y, w, h, fill=PANEL_2, stroke=LINE, radius=9)
    c.setFillColor(accent)
    c.circle(x + 17, y + h - 17, 9, fill=1, stroke=0)
    label(c, number, x + 17, y + h - 19.4, size=6.4, color=INK, align="center")
    label(c, title, x + 31, y + h - 19.5, size=8.2, color=WHITE)
    paragraph(c, body, x + 11, y + h - 37, w - 22, size=7.1, leading=9, color=MUTED, max_lines=3)


def state_node(c, x, y, w, number, accent, title, body):
    box(c, x, y, w, 43, fill=PANEL_3, stroke=accent, radius=8, line_width=1.1)
    label(c, number, x + 10, y + 27, size=6.5, color=accent)
    label(c, title, x + 27, y + 27, size=7.5, color=WHITE)
    paragraph(c, body, x + 10, y + 13, w - 20, size=6.3, leading=7.2, color=MUTED, max_lines=2)


def roadmap_column(c, x, y, w, accent, phase, headline, bullets):
    c.setFillColor(accent)
    c.roundRect(x, y + 69, w, 21, 7, fill=1, stroke=0)
    label(c, phase, x + 10, y + 76, size=6.8, color=INK)
    label(c, headline, x, y + 52, size=8.5, color=WHITE)
    by = y + 38
    for bullet in bullets:
        c.setFillColor(accent)
        c.circle(x + 3, by + 2, 1.5, fill=1, stroke=0)
        paragraph(c, bullet, x + 10, by, w - 10, size=6.4, leading=7.5, color=MUTED, max_lines=2)
        by -= 17


def draw_pdf():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=landscape(letter))
    width, height = landscape(letter)

    c.setTitle("ManyVue Live - Product Opportunity and Next Steps")
    c.setAuthor("ManyVue")
    c.setSubject("How ManyVue changes the live fan experience and grows into festival infrastructure")

    c.setFillColor(INK)
    c.rect(0, 0, width, height, fill=1, stroke=0)

    # Top brand bar.
    c.setLineWidth(3.2)
    c.setStrokeColor(ACID)
    c.circle(42, 576, 10, fill=0, stroke=1)
    c.setStrokeColor(PINK)
    c.arc(31, 565, 53, 587, 300, 82)
    label(c, "MANYVUE", 61, 570, size=17, color=WHITE)
    c.setFillColor(PINK)
    c.roundRect(160, 568, 26, 12, 3, fill=1, stroke=0)
    label(c, "LIVE", 173, 571, size=6.2, color=WHITE, align="center")
    label(c, "PRODUCT OPPORTUNITY + FESTIVAL ROADMAP", 762, 573, size=7.3, color=ACID, align="right")

    # Hero.
    box(c, 30, 487, 732, 63, fill=PANEL, stroke=LINE, radius=14)
    c.setFillColor(PINK)
    c.rect(30, 487, 5, 63, fill=1, stroke=0)
    label(c, "ONE CROWD. EVERY ANGLE. ONE PERSONAL FILM.", 49, 522, size=20.5, color=WHITE)
    paragraph(
        c,
        "ManyVue turns the phones already recording into a live camera network, then gives every fan a synchronized memory no single phone could capture.",
        49,
        501,
        620,
        size=9.2,
        leading=11,
        color=MUTED,
        max_lines=2,
    )
    c.setFillColor(ACID)
    c.roundRect(665, 502, 74, 25, 12, fill=1, stroke=0)
    label(c, "WHY NOW", 702, 510, size=7, color=INK, align="center")

    # Why this is useful.
    section_title(c, "WHO GETS VALUE", "WHY THIS MATTERS", 30, 466, CYAN)
    audience_row(
        c, 30, 393, 352, "FANS", CYAN, "A BETTER MEMORY",
        "Record once, see your angle go live, and keep a multi-angle artifact centered on where you stood.",
    )
    audience_row(
        c, 30, 348, 352, "ARTISTS", PINK, "AUTHENTIC CROWD MEDIA",
        "Turn fan perspectives into the live program, artist-approved recap footage, and shareable moments.",
    )
    audience_row(
        c, 30, 303, 352, "FESTIVALS", ACID, "VISUAL TRUTH, RIGHT NOW",
        "See the front, back, and different stages as they actually look - not only attendance numbers or a heatmap.",
    )

    # What becomes possible.
    section_title(c, "APPLICATIONS", "WHAT MANYVUE UNLOCKS", 398, 466, PINK)
    card_w, card_h, gap = 176, 62, 8
    possibility_card(c, 398, 379, card_w, card_h, "01", CYAN, "LIVE STAGE WINDOWS",
                     "Choose where to go by viewing real crowd video from each stage in the festival app.")
    possibility_card(c, 398 + card_w + gap, 379, card_w, card_h, "02", PINK, "CROWD-DIRECTED SHOW",
                     "Blend front, side, wide, and reaction angles while the performance is happening.")
    possibility_card(c, 398, 307, card_w, card_h, "03", ACID, "PERSONAL BURST",
                     "Preserve T-3 to T+3 across available views, then replay or download the synchronized moment.")
    possibility_card(c, 398 + card_w + gap, 307, card_w, card_h, "04", VIOLET, "REMOTE FAN PRESENCE",
                     "Let livestream viewers step into authentic crowd perspectives fixed cameras cannot provide.")

    # Convex control plane.
    box(c, 30, 194, 732, 91, fill=PANEL, stroke=ACID, radius=12, line_width=1.25)
    label(c, "CONVEX IS THE PRODUCTION CONTROL ROOM", 45, 266, size=8.8, color=ACID)
    label(c, "Guarded transactions plus reactive queries make every client converge on authoritative production state.",
          747, 266, size=7.0, color=MUTED, align="right", font="Helvetica")
    node_y, node_w, node_gap = 210, 158, 18
    nodes = [
        ("01", CYAN, "LEASED PRESENCE", "Hashed capabilities, sequenced heartbeats, and stale-expiry cron."),
        ("02", PINK, "REVISIONED SCENES", "Validated membership, normalized cutAt, atomic scene revision."),
        ("03", ACID, "PRIVATE CAPTURE ANCHOR", "Expected-camera snapshot plus immutable T-3/T+3 signal."),
        ("04", VIOLET, "IDEMPOTENT READINESS", "Provenance, preserved/uploaded state, owner-scoped replay."),
    ]
    for index, node in enumerate(nodes):
        nx = 45 + index * (node_w + node_gap)
        state_node(c, nx, node_y, node_w, *node)
        if index < 3:
            ax = nx + node_w + 5
            c.setStrokeColor(node[1])
            c.setLineWidth(1.4)
            c.line(ax, node_y + 21.5, ax + 8, node_y + 21.5)
            c.line(ax + 4, node_y + 25, ax + 8, node_y + 21.5)
            c.line(ax + 4, node_y + 18, ax + 8, node_y + 21.5)

    # Roadmap.
    box(c, 30, 66, 732, 111, fill=PANEL, stroke=LINE, radius=12)
    label(c, "THE PATH FROM WORKING DEMO TO FESTIVAL PLATFORM", 45, 158, size=8.7, color=WHITE)
    label(c, "Build on the same realtime core - expand reliability, rights, and distribution.",
          747, 158, size=7, color=MUTED, align="right", font="Helvetica")
    roadmap_column(c, 46, 59, 212, CYAN, "NOW - WORKING SYSTEM", "PROVE THE EXPERIENCE", [
        "QR join, live camera wall, 1-5 angle direction, and personal Bursts.",
        "Realtime join, cut, cue, readiness, ownership, and reconnect through Convex.",
    ])
    roadmap_column(c, 290, 59, 212, PINK, "NEXT - FESTIVAL PILOT", "PROVE IT IN THE FIELD", [
        "Official stage rooms, app deep links, adaptive quality, offline queues, and rights controls.",
        "Validate 25-100+ phones, under 250 ms control state, and over 95% artifact completion.",
    ])
    roadmap_column(c, 534, 59, 212, ACID, "THEN - FESTIVAL PLATFORM", "EXPAND THE MEDIUM", [
        "Across-stage live windows, artist-triggered moments, official livestream crowd POVs.",
        "Automated personal edits, schedule context, sponsor activations, and year-round artist use.",
    ])

    # Footer.
    label(c, "ONE PERSON RECORDS A CLIP. A CROWD CREATES THE FILM.", 30, 34, size=7.4, color=PINK)
    label(c, "manyvue-live.ild.chatgpt.site", 394, 34, size=7.1, color=WHITE, align="center", font="Helvetica")
    label(c, "LIVE MULTI-ANGLE PRODUCTION  /  PERSONAL SYNCHRONIZED ARTIFACTS  /  CONVEX-NATIVE REALTIME STATE",
          396, 15, size=6.1, color=DIM, align="center")

    c.showPage()
    c.save()
    print(OUTPUT)


if __name__ == "__main__":
    draw_pdf()
