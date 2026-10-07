"""Fills the real DC 100a with awkward values and checks that nothing is cut
off silently: every value either prints in full or is reported as a problem.

    python3 test/form_checks.py [path/to/dc100a.pdf]

Downloads the form from courts.michigan.gov when no path is given. Writes the
filled PDFs to test/out/ so they can be opened and looked at. Exits 1 on any
failure. Run before deploying a change to cloud_function/main.py.
"""
import base64, os, sys, types
from io import BytesIO

HERE = os.path.dirname(os.path.abspath(__file__))
sys.modules.setdefault("functions_framework", types.SimpleNamespace(http=lambda f: f))
sys.path.insert(0, os.path.join(HERE, "..", "cloud_function"))
import main  # noqa: E402
from pypdf import PdfReader  # noqa: E402

if len(sys.argv) > 1:
    main._template_cache = open(sys.argv[1], "rb").read()

OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

BASE = {"street": "900 Leonard St NW", "unit": "316", "city": "Grand Rapids", "state": "MI",
        "zip": "49504", "landlord_name": "900 W Leonard LLC", "amount": "1,200.00",
        "notice_date": "10/06/2026"}


def fill(label, names, emails):
    data = dict(BASE, tenant_names=names, served_on=names, electronic_service_email=emails)
    b64, problems = main.fill_form(data)
    pdf = base64.b64decode(b64)
    open(os.path.join(OUT, label + ".pdf"), "wb").write(pdf)
    return pdf, problems


def drawn(pdf, field):
    """Text the form actually draws for a field on page 1, lines joined by ' '."""
    import re
    for annot in PdfReader(BytesIO(pdf)).pages[0]["/Annots"]:
        w = annot.get_object()
        if str(w.get("/T", "")).strip() == field and "/AP" in w:
            stream = w["/AP"]["/N"].get_data().decode("cp1252")
            return " ".join(re.findall(r"\((.*?)\) Tj", stream))
    return None


failed = 0
def check(label, ok, detail=""):
    global failed
    if not ok:
        failed += 1
    print(("ok   " if ok else "FAIL ") + label + ("" if ok else "\n     " + str(detail)))


# The notice from 2026-10-06 that was cut off at "brookelynnpaige14@iclo".
pdf, problems = fill("one_long_email", "Brookelynn P. Bouwens", "brookelynnpaige14@icloud.com")
check("one long email passes", problems == [], problems)
check("one long email prints in full",
      drawn(pdf, "electronic service address") == "brookelynnpaige14@icloud.com",
      drawn(pdf, "electronic service address"))

four_names  = "Christopher A. Chocko, Tiffany Jameson, Brookelynn P. Bouwens, Maria José Hernández-Villanueva"
four_emails = "chrischocko@gmail.com, tjamesonedm@gmail.com, brookelynnpaige14@icloud.com, mariajose.hernandez@outlook.com"
pdf, problems = fill("four_people", four_names, four_emails)
check("four people pass", problems == [], problems)
check("four emails print in full", drawn(pdf, "electronic service address") == four_emails,
      drawn(pdf, "electronic service address"))
check("four names print in full on the certificate",
      drawn(pdf, "I served this notice on Name") == four_names + " and all other occupants",
      drawn(pdf, "I served this notice on Name"))

_, problems = fill("too_many_emails", four_names, four_emails + ", robert.chocko.senior@yahoo.com, another.long.address@example.com")
check("emails that cannot fit are reported, not clipped",
      any("too long to print" in p for p in problems), problems)

_, problems = fill("no_email", "A Tenant", "")
check("blank e-service email is reported", any("No email address" in p for p in problems), problems)

_, problems = fill("unprintable", "Łukasz 名前", "a@example.com")
check("a name the form cannot print is reported", any("cannot print" in p for p in problems), problems)

print("\n%d FAILED" % failed if failed else "\nall passed")
sys.exit(1 if failed else 0)
