"""Validates the SDK's sample invoices against the official artefacts:
  - Facturae 3.2.2 XSD (Ministerio de Hacienda, copy in OCA/l10n-spain);
  - UBL 2.1 XSD (OASIS, copy in phax/ph-ubl);
  - EN 16931 and Peppol BIS Billing 3.0 Schematron rules, compiled to XSLT
    (OpenPEPPOL 2026.5, copy in phax/phive-rules), run with Saxon-HE.

  python3 scripts/validate-invoices.py <samples-dir> <artefacts-dir>

Exits non-zero on any schema error or any Schematron error (`fatal`).
Warnings are printed but do not fail.
"""
import glob
import os
import shutil
import sys
import tempfile

from lxml import etree
from saxonche import PySaxonProcessor

samples, art = sys.argv[1], sys.argv[2]
facturae_xsd = os.path.join(art, "oca-es/l10n_es_facturae/data/Facturaev3_2_2.xsd")


def ubl_schema_dir():
    """ph-ubl strips the schemaLocation of the four non-UBL imports (it resolves them with a
    catalogue); put the files beside the UBL ones and point the imports at them."""
    d = tempfile.mkdtemp()
    shutil.copytree(os.path.join(art, "ph-ubl/ph-ubl21/src/main/resources/external/schemas/ubl21"), os.path.join(d, "ubl21"))
    extra = {
        "urn:un:unece:uncefact:data:specification:CoreComponentTypeSchemaModule:2": "ph-xsds/ph-xsds-ccts-cct-schemamodule/src/main/resources/schemas/CCTS_CCT_SchemaModule.xsd",
        "http://www.w3.org/2000/09/xmldsig#": "ph-xsds/ph-xsds-xmldsig/src/main/resources/schemas/xmldsig-core-schema.xsd",
        "http://uri.etsi.org/01903/v1.3.2#": "ph-xsds/ph-xsds-xades132/src/main/resources/schemas/XAdES01903v132-201601.xsd",
        "http://uri.etsi.org/01903/v1.4.1#": "ph-xsds/ph-xsds-xades141/src/main/resources/schemas/XAdES01903v141-201601.xsd",
    }
    common = os.path.join(d, "ubl21", "common")
    for ns, src in extra.items():
        shutil.copy(os.path.join(art, src), common)
    for f in glob.glob(os.path.join(common, "*.xsd")):
        text = open(f, encoding="utf-8").read()
        for ns, src in extra.items():
            text = text.replace(f'<xsd:import namespace="{ns}" />', f'<xsd:import namespace="{ns}" schemaLocation="{os.path.basename(src)}"/>')
            text = text.replace(f'<xsd:import namespace="{ns}"/>', f'<xsd:import namespace="{ns}" schemaLocation="{os.path.basename(src)}"/>')
        open(f, "w", encoding="utf-8").write(text)
    return d


ubl_xsd = os.path.join(ubl_schema_dir(), "ubl21/maindoc/UBL-Invoice-2.1.xsd")
xslt_dir = os.path.join(art, "phive/phive-rules-peppol/src/main/resources/external/schematron/openpeppol/2026.5/xslt")
SVRL = "{http://purl.oclc.org/dsdl/svrl}"
failed = False


def xsd(path):
    return etree.XMLSchema(etree.parse(path))


def check_xsd(schema, doc, name):
    global failed
    if schema.validate(etree.parse(doc)):
        print(f"  XSD ok")
    else:
        failed = True
        for e in schema.error_log:
            print(f"  XSD ERROR line {e.line}: {e.message}")


facturae, ubl = xsd(facturae_xsd), xsd(ubl_xsd)
with PySaxonProcessor(license=False) as proc:
    x = proc.new_xslt30_processor()
    rules = {n: x.compile_stylesheet(stylesheet_file=os.path.join(xslt_dir, f"{n}.xslt")) for n in ("CEN-EN16931-UBL", "PEPPOL-EN16931-UBL")}
    for doc in sorted(glob.glob(os.path.join(samples, "*.xml"))):
        name = os.path.basename(doc)
        print(name)
        if name.startswith("facturae"):
            check_xsd(facturae, doc, name)
            continue
        check_xsd(ubl, doc, name)
        for rule, exe in rules.items():
            svrl = etree.fromstring(exe.transform_to_string(source_file=doc).encode())
            asserts = svrl.findall(f".//{SVRL}failed-assert")
            errors = [a for a in asserts if a.get("flag") in ("fatal", "error")]
            for a in asserts:
                text = " ".join(a.findtext(f"{SVRL}text", "").split())
                print(f"  {rule} {a.get('flag')} {a.get('id')}: {text[:160]}")
            if errors:
                failed = True
            else:
                print(f"  {rule} ok ({len(asserts)} warnings)")
sys.exit(1 if failed else 0)
