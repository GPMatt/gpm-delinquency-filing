import functions_framework
import base64
import os
import requests
from io import BytesIO
import logging

logger = logging.getLogger(__name__)

PDF_URL = "https://courts.michigan.gov/49cc01/siteassets/forms/scao-approved/dc100a.pdf"
GPM_ADDRESS        = "1787 Grand Ridge Ct NE, Suite 200"
GPM_CITY_STATE_ZIP = "Grand Rapids, MI 49525"
GPM_PHONE          = "(866)954-7336"

# Fields that get a drawn signature (Dancing Script) instead of typed text —
# the form has "Signature of owner of premises or agent" twice (once per
# page) plus the Certificate of Service "Signature" line.
SIGNATURE_FIELDS     = {"Signature of owner of premises or agent", "Signature"}
SIGNER_NAME           = "Matthieu Fournier"
SIGNATURE_FONT_NAME   = "Signature"
SIGNATURE_FONT_FILE   = os.path.join(os.path.dirname(__file__), "DancingScript.ttf")
EXPECTED_SIGNATURES   = 3   # owner/agent line on each of the two copies + certificate of service
# Off until Matt approves the drawn signature; the lines stay blank as before.
DRAW_SIGNATURE        = False

# Text-field fitting. The stock form leaves every text field without an
# appearance stream, so each PDF viewer lays the text out itself at a fixed
# 10pt and clips whatever does not fit the box (a long e-service address lost
# its ending this way). We now measure the text, pick a size that fits, and
# write the appearance ourselves so every viewer shows the same thing.
BASE_FONT_SIZE = 10.0
MIN_FONT_SIZE  = 6.0
LINE_HEIGHT    = 1.15   # multiple of font size
PAD_X          = 2.0
METRIC_FONT    = "Helvetica"   # same widths as the form's ArialMT

# Fields that need more than "one line, shrink to fit":
#   anchor top  = block of lines starting at the top of the box
#   wrap        = may break onto more lines at spaces
#   grow_right  = box may extend right to this x (blank space on that line)
#   grow_top    = box may extend up to this y (blank space above that line)
FIELD_LAYOUT = {
    "Tenant's Name And Address":    {"wrap": True, "anchor": "top"},
    "I served this notice on Name": {"wrap": True, "grow_top": 207.0},
    # One line only: the form's own wording sits right on top of this box, so a
    # second line would print over it.
    "electronic service address":   {"grow_right": 570.0},
}

# Values that must never be blank on a notice we send out.
REQUIRED_DATA = {
    "tenant_names":  "No tenant name",
    "served_on":     "No name on the certificate of service",
    "street":        "No street address",
    "city":          "No city",
    "state":         "No state",
    "zip":           "No zip code",
    "landlord_name": "No landlord/owner name (check the Owner column in Delinquency Info)",
    "amount":        "No amount owed",
    "notice_date":   "No notice date",
    "electronic_service_email":
        "No email address on file for anyone named — the notice certifies electronic service",
}

_template_cache = None


def _get_template():
    global _template_cache
    if _template_cache is None:
        resp = requests.get(PDF_URL, timeout=30)
        resp.raise_for_status()
        _template_cache = resp.content
        logger.info("DC 100a template fetched and cached")
    return _template_cache


@functions_framework.http
def fill_delinquency_form(request):
    try:
        req = request.get_json(silent=True)
        if not req or "data" not in req:
            return {"error": "Missing data field"}, 400

        filled_b64, problems = fill_form(req["data"])
        # The PDF is returned even when checks fail so the caller can show the
        # admin what was wrong — the caller must not send it on to a PM.
        return {"filledPdf": filled_b64,
                "checks": {"ok": not problems, "problems": problems}}, 200

    except Exception as e:
        logger.error("Error filling form: %s", e, exc_info=True)
        return {"error": str(e)}, 500


def _draw_signature(writer, targets):
    """Overlay SIGNER_NAME in a cursive font onto each (page_index, rect)
    target — used for the blank signature lines instead of typed text."""
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from pypdf import PdfReader

    if SIGNATURE_FONT_NAME not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(SIGNATURE_FONT_NAME, SIGNATURE_FONT_FILE))

    for page_index, rect in targets:
        page = writer.pages[page_index]
        page_w = float(page.mediabox.width)
        page_h = float(page.mediabox.height)

        x0, y0, x1, y1 = [float(v) for v in rect]
        box_w, box_h = x1 - x0, y1 - y0

        size = min(box_h * 0.85, 16)
        while size > 6 and pdfmetrics.stringWidth(SIGNER_NAME, SIGNATURE_FONT_NAME, size) > box_w * 0.95:
            size -= 0.5

        buf = BytesIO()
        c = canvas.Canvas(buf, pagesize=(page_w, page_h))
        c.setFont(SIGNATURE_FONT_NAME, size)
        baseline_y = y0 + max(2, (box_h - size) / 2)
        c.drawString(x0 + 2, baseline_y, SIGNER_NAME)
        c.save()
        buf.seek(0)

        page.merge_page(PdfReader(buf).pages[0])


def _text_width(text, size):
    from reportlab.pdfbase import pdfmetrics
    return pdfmetrics.stringWidth(text, METRIC_FONT, size)


def _pdf_text(text):
    """Text as the form font can draw it (WinAnsi). Accents the font lacks are
    reduced to the base letter; returns None if a character still can't be drawn."""
    import unicodedata
    out = []
    for ch in text:
        try:
            ch.encode("cp1252")
            out.append(ch)
        except UnicodeEncodeError:
            base = "".join(c for c in unicodedata.normalize("NFKD", ch)
                           if not unicodedata.combining(c))
            try:
                base.encode("cp1252")
            except UnicodeEncodeError:
                return None
            if not base:
                return None
            out.append(base)
    return "".join(out)


def _wrap(text, size, max_w):
    """Break text into lines no wider than max_w, at spaces only. None if a
    single word (e.g. one email address) is itself too wide."""
    lines = []
    for para in text.split("\n"):
        cur = ""
        for word in para.split(" "):
            trial = word if not cur else cur + " " + word
            if _text_width(trial, size) <= max_w:
                cur = trial
                continue
            if cur:
                lines.append(cur)
            if _text_width(word, size) > max_w:
                return None
            cur = word
        lines.append(cur)
    return lines


def _needed_height(n_lines, size, anchor):
    if anchor == "top":
        return n_lines * size * LINE_HEIGHT + 1
    # last line sits 0.3em above the box bottom; 0.75em covers the tallest glyphs
    return (0.3 + 0.75 + LINE_HEIGHT * (n_lines - 1)) * size


def _layout(text, rect, spec):
    """Largest font size (and box, if this field may grow) at which the whole
    text is visible. Returns (rect, size, lines) or None if it cannot fit."""
    x0, y0, x1, y1 = rect
    sizes = []
    size = BASE_FONT_SIZE
    while size >= MIN_FONT_SIZE:
        sizes.append(size)
        size -= 0.5

    grown = (x0, y0, spec.get("grow_right", x1), spec.get("grow_top", y1))
    if grown != (x0, y0, x1, y1):
        # stock box at the stock size first, so a short value looks like the plain form
        attempts = [((x0, y0, x1, y1), [BASE_FONT_SIZE]), (grown, sizes)]
    else:
        attempts = [((x0, y0, x1, y1), sizes)]

    anchor = spec.get("anchor", "bottom")
    for box, box_sizes in attempts:
        w, h = box[2] - box[0], box[3] - box[1]
        for size in box_sizes:
            if spec.get("wrap"):
                lines = _wrap(text, size, w - 2 * PAD_X)
            else:
                lines = [text] if _text_width(text, size) <= w - 2 * PAD_X else None
            if lines and _needed_height(len(lines), size, anchor) <= h:
                return box, size, lines
    return None


def _appearance_stream(box, size, lines, anchor):
    from pypdf.generic import (DecodedStreamObject, DictionaryObject, NameObject,
                               ArrayObject, FloatObject)
    w, h = box[2] - box[0], box[3] - box[1]
    lead = size * LINE_HEIGHT
    if anchor == "top":
        first_baseline = h - 1 - 0.8 * size
    else:
        first_baseline = 0.3 * size + lead * (len(lines) - 1)

    def esc(line):
        return line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    ops = ["/Tx BMC", "q", "BT", f"/Helv {size:g} Tf", "0 g", f"{lead:.2f} TL",
           f"{PAD_X:g} {first_baseline:.2f} Td"]
    for i, line in enumerate(lines):
        ops.append(("T* " if i else "") + f"({esc(line)}) Tj")
    ops += ["ET", "Q", "EMC"]

    stream = DecodedStreamObject()
    stream.set_data("\n".join(ops).encode("cp1252"))
    stream[NameObject("/Type")]    = NameObject("/XObject")
    stream[NameObject("/Subtype")] = NameObject("/Form")
    stream[NameObject("/BBox")]    = ArrayObject([FloatObject(0), FloatObject(0), FloatObject(w), FloatObject(h)])
    stream[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({
            NameObject("/Helv"): DictionaryObject({
                NameObject("/Type"):     NameObject("/Font"),
                NameObject("/Subtype"):  NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
                NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
            })
        })
    })
    return stream


def _verify_output(pdf_bytes, expected_text, on_names, off_names):
    """Re-open the finished PDF and confirm it holds what we meant to write."""
    from pypdf import PdfReader
    problems = []
    fields = {k.strip(): v for k, v in (PdfReader(BytesIO(pdf_bytes)).get_fields() or {}).items()}
    for name, value in expected_text.items():
        got = fields.get(name, {}).get("/V")
        if (got or "") != value:
            problems.append(f'"{name}" reads "{got}" in the finished PDF, expected "{value}"')
    for name in on_names:
        if fields.get(name, {}).get("/V") != "/Yes":
            problems.append(f'checkbox "{name}" is not checked in the finished PDF')
    for name in off_names:
        if fields.get(name, {}).get("/V") not in ("/Off", None):
            problems.append(f'checkbox "{name}" is checked in the finished PDF and should not be')
    return problems


def fill_form(data):
    """Fill the DC 100a. Returns (base64 pdf, problems) — problems is a list of
    plain-language reasons this notice must not go out; empty means it passed."""
    import re
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import (NameObject, create_string_object, ArrayObject, FloatObject,
                               DictionaryObject, TextStringObject)

    problems = [msg for key, msg in REQUIRED_DATA.items() if not str(data.get(key, "")).strip()]

    reader = PdfReader(BytesIO(_get_template()))
    writer = PdfWriter()
    writer.append(reader)

    # --- Field A: tenant address block ---
    names    = data.get("tenant_names", "")
    street   = data.get("street", "")
    unit     = data.get("unit", "")
    city     = data.get("city", "")
    state    = data.get("state", "")
    zip_code = data.get("zip", "")

    served_on = data.get("served_on", "")

    unit_line     = f"Unit {unit}" if unit else ""
    address_block = "\n".join(
        part for part in [
            f"{names} and all other occupants",
            street,
            unit_line,
            f"{city}, {state} {zip_code}",
        ] if part
    )

    # Confirmed AcroForm field names (courts.michigan.gov dc100a.pdf)
    TEXT = {
        "Tenant's Name And Address":  address_block,
        "First Middle and Last Name": data.get("landlord_name", ""),
        "says that you owe In Dollars for rent": data.get("amount", ""),
        "Address or description of premises rented (if different from mailing address)": "",
        "OTHER NUMBER OF DAYS":                  "",
        "Date":                                  data.get("notice_date", ""),
        "Signature of owner of premises or agent": "",
        "Address":                               GPM_ADDRESS,
        "City  State  Zip":                      GPM_CITY_STATE_ZIP,
        "Telephone Number":                      GPM_PHONE,
        "Date of Certificate Of Service":        data.get("notice_date", ""),
        "I served this notice on Name":          f"{served_on} and all other occupants" if served_on else "",
        "electronic service address":            data.get("electronic_service_email", ""),
        "Signature":                             "",
    }
    CHECKBOX_ON = {
        "7 days",
        "electronic service to the person in possession who has consented in writing to such service",
    }
    CHECKBOX_OFF = {
        "Other Number of days",
        "delivering it personally to the person in possession",
        "delivering it on the premises to a member of his/her family or household or an employee",
        "first class mail addressed to the person in possession",
    }

    # Normalize keys to strip trailing whitespace in PDF field names
    text_lookup = {k.strip(): v for k, v in TEXT.items()}
    on_lookup   = {k.strip() for k in CHECKBOX_ON}
    off_lookup  = {k.strip() for k in CHECKBOX_OFF}

    seen_parent_ids  = set()
    signature_targets = []  # (page_index, rect) for each blank signature line
    written_text      = set()  # text fields actually found on the form
    seen_boxes        = set()  # checkboxes actually found on the form

    for page_index, page in enumerate(writer.pages):
        for annot_ref in page.get("/Annots", []):
            widget = annot_ref.get_object()
            own_t  = widget.get("/T")

            if own_t is not None:
                # Named widget — FT and value live on itself
                name          = str(own_t).strip()
                ft            = str(widget.get("/FT", ""))
                field_obj     = widget
                is_new_parent = True
            else:
                # Anonymous widget — FT and value live on parent
                parent_ref = widget.get("/Parent")
                if parent_ref is None:
                    continue
                parent = parent_ref.get_object()
                pt = parent.get("/T")
                if pt is None:
                    continue
                name = str(pt).strip()
                ft   = str(parent.get("/FT", ""))
                pid = id(parent)
                is_new_parent = pid not in seen_parent_ids
                if is_new_parent:
                    seen_parent_ids.add(pid)
                field_obj = parent

            if ft == "/Tx":
                # Every widget annotation has its own /Rect even when several widgets
                # share one field (e.g. "Signature of owner..." appears once per copy
                # of the form) — collect a target for each one, before the
                # once-per-parent guard below skips repeat widgets.
                if name in SIGNATURE_FIELDS:
                    rect = widget.get("/Rect")
                    if rect:
                        signature_targets.append((page_index, rect))
                if name not in text_lookup:
                    continue
                value = text_lookup[name]
                written_text.add(name)
                # The value lives on the field (once per parent); the appearance
                # is per widget, because each copy of the form has its own box.
                if own_t is not None or is_new_parent:
                    field_obj[NameObject("/V")] = create_string_object(value)
                if NameObject("/AP") in widget:
                    del widget[NameObject("/AP")]
                if not value:
                    continue

                drawable = _pdf_text(value)
                if drawable is None:
                    problems.append(f'"{name}" has a character the form cannot print: {value}')
                    continue
                rect = [float(v) for v in widget.get("/Rect")]
                spec = FIELD_LAYOUT.get(name, {})
                fit  = _layout(drawable, rect, spec)
                if fit is None:
                    problems.append(f'"{name}" is too long to print in full on the form: {value}')
                    continue
                box, size, lines = fit
                if list(box) != rect:
                    widget[NameObject("/Rect")] = ArrayObject([FloatObject(v) for v in box])
                stream_ref = writer._add_object(
                    _appearance_stream(box, size, lines, spec.get("anchor", "bottom")))
                widget[NameObject("/AP")] = DictionaryObject({NameObject("/N"): stream_ref})
                # Keep the field's own font size in step, for viewers that
                # redraw fields themselves instead of using the appearance.
                if size != BASE_FONT_SIZE:
                    da = str(widget.get("/DA") or field_obj.get("/DA") or "/Helv 10 Tf 0 g")
                    widget[NameObject("/DA")] = TextStringObject(
                        re.sub(r"[\d.]+\s+Tf", f"{size:g} Tf", da))

            elif ft == "/Btn":
                # Checkboxes: always set /AS on every widget annotation (appearance is per-widget),
                # but only set /V on the field object once per field.
                if name in on_lookup or name in off_lookup:
                    seen_boxes.add(name)
                if name in on_lookup:
                    widget[NameObject("/AS")] = NameObject("/Yes")
                    if own_t is None and not is_new_parent:
                        continue
                    field_obj[NameObject("/V")] = NameObject("/Yes")
                elif name in off_lookup:
                    widget[NameObject("/AS")] = NameObject("/Off")
                    if own_t is None and not is_new_parent:
                        continue
                    field_obj[NameObject("/V")] = NameObject("/Off")

    if DRAW_SIGNATURE and signature_targets:
        _draw_signature(writer, signature_targets)

    # If SCAO revises the form and renames a field, it would silently stay blank.
    for name in text_lookup:
        if name not in written_text:
            problems.append(f'the court form no longer has a "{name}" field')
    for name in on_lookup | off_lookup:
        if name not in seen_boxes:
            problems.append(f'the court form no longer has a "{name}" checkbox')
    if len(signature_targets) != EXPECTED_SIGNATURES:
        problems.append(f"signed {len(signature_targets)} signature line(s), expected {EXPECTED_SIGNATURES}")

    output = BytesIO()
    writer.write(output)
    pdf_bytes = output.getvalue()
    problems += _verify_output(pdf_bytes, text_lookup, on_lookup, off_lookup)
    problems = list(dict.fromkeys(problems))  # both copies of the form report the same issue
    return base64.b64encode(pdf_bytes).decode("utf-8"), problems
