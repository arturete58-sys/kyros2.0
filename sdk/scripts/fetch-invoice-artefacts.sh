#!/usr/bin/env bash
# Fetches the schemas and rules the invoice validator uses, from public copies
# on GitHub (sparse clones, a few MB): Facturae 3.2.2 XSD (OCA/l10n-spain),
# UBL 2.1 XSD (phax/ph-ubl, phax/ph-xsds) and the OpenPEPPOL 2026.5 rules
# compiled to XSLT (phax/phive-rules).
#   bash scripts/fetch-invoice-artefacts.sh <dir>
set -euo pipefail
dir="${1:-invoice-artefacts}"
mkdir -p "$dir"
cd "$dir"
sparse() {
  local repo="$1" name="$2"; shift 2
  rm -rf "$name"
  git clone --quiet --depth 1 --filter=blob:none --no-checkout "https://github.com/$repo.git" "$name"
  git -C "$name" sparse-checkout init --no-cone
  git -C "$name" sparse-checkout set "$@"
  git -C "$name" checkout --quiet
}
sparse OCA/l10n-spain oca-es "l10n_es_facturae/data/Facturaev3_2_2.xsd" "l10n_es_facturae/data/xmldsig-core-schema.xsd"
sparse phax/ph-ubl ph-ubl "ph-ubl21/src/main/resources/external/schemas/ubl21/"
sparse phax/ph-xsds ph-xsds \
  "ph-xsds-ccts-cct-schemamodule/src/main/resources/schemas/" \
  "ph-xsds-xmldsig/src/main/resources/schemas/" \
  "ph-xsds-xades132/src/main/resources/schemas/" \
  "ph-xsds-xades141/src/main/resources/schemas/"
sparse phax/phive-rules phive \
  "phive-rules-peppol/src/main/resources/external/schematron/openpeppol/2026.5/xslt/CEN-EN16931-UBL.xslt" \
  "phive-rules-peppol/src/main/resources/external/schematron/openpeppol/2026.5/xslt/PEPPOL-EN16931-UBL.xslt"
echo "artefacts in $dir"
