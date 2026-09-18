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

        filled_b64 = fill_form(req["data"])
        return {"filledPdf": filled_b64}, 200

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


def fill_form(data):
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, create_string_object, ArrayObject, FloatObject

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
                # Text fields: only process once per parent (value lives on parent)
                if own_t is None and not is_new_parent:
                    continue
                if name in text_lookup:
                    value = text_lookup[name]
                    field_obj[NameObject("/V")] = create_string_object(value)
                    for obj in (field_obj, widget):
                        if NameObject("/AP") in obj:
                            del obj[NameObject("/AP")]
                    # SCAO's box for this field is sized for one address (115.7pt @ 10pt
                    # font) and its height leaves no room to wrap a second line before the
                    # Signature line ~5pt below, so multiple e-service addresses get
                    # clipped. Widen rightward into the blank margin on the same line
                    # instead — only when needed, so a single-address filing still matches
                    # the stock form.
                    if name == "electronic service address" and "," in value:
                        rect = widget.get("/Rect")
                        if rect:
                            widget[NameObject("/Rect")] = ArrayObject(
                                [rect[0], rect[1], FloatObject(570), rect[3]]
                            )

            elif ft == "/Btn":
                # Checkboxes: always set /AS on every widget annotation (appearance is per-widget),
                # but only set /V on the field object once per field.
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

    if signature_targets:
        _draw_signature(writer, signature_targets)

    output = BytesIO()
    writer.write(output)
    return base64.b64encode(output.getvalue()).decode("utf-8")
