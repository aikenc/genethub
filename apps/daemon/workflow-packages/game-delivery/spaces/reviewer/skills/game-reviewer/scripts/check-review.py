#!/usr/bin/env python3
"""Validate the package's review coverage, not execution of referenced checks."""
import hashlib
import json
import pathlib
import sys

if not 3 <= len(sys.argv) <= 4:
    raise ValueError('Usage: python3 check-review.py contract.json report.json [previous-contract.json]')
raw = pathlib.Path(sys.argv[1]).read_bytes()
report_raw = pathlib.Path(sys.argv[2]).read_bytes()
contract, report = json.loads(raw), json.loads(report_raw)
errors = []
def digest(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()
def text(value):
    return isinstance(value, str) and bool(value.strip())
def acceptance_digest(value):
    data = {key: value.get(key) for key in ('requirementRevision', 'checklistVersion', 'items')}
    return digest(json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode())
if contract.get('schema') != 'genehub.review-contract.v1' or report.get('schema') != 'genehub.review-report.v1':
    errors.append('unsupported contract/report schema')
for key in ('requirementRevision', 'checklistVersion', 'artifactRevision'):
    if not text(contract.get(key)) or report.get(key) != contract.get(key):
        errors.append('missing or mismatched ' + key)
if report.get('contractDigest') != digest(raw):
    errors.append('contractDigest mismatch')
if len(sys.argv) == 4:
    previous = json.loads(pathlib.Path(sys.argv[3]).read_bytes())
    if acceptance_digest(previous) != acceptance_digest(contract):
        errors.append('acceptance changed between review and re-review')
expected = set()
items = contract.get('items')
if not isinstance(items, list) or not items:
    errors.append('contract needs a finite nonempty checklist')
for item in items if isinstance(items, list) else []:
    item_id = item.get('id')
    if not text(item_id) or not text(item.get('criterion')) or item_id in expected:
        errors.append('invalid or duplicate contract item: ' + str(item_id))
    expected.add(item_id)
covered, approved = set(), True
items = report.get('items')
if not isinstance(items, list):
    errors.append('report.items must be an array')
for item in items if isinstance(items, list) else []:
    item_id, status = item.get('id'), item.get('status')
    if item_id not in expected or item_id in covered:
        errors.append('unknown or duplicate report item: ' + str(item_id))
    covered.add(item_id)
    if status not in ('met', 'partial', 'unmet', 'unverifiable', 'notApplicable'):
        errors.append('invalid status for ' + str(item_id))
    evidence = item.get('evidence')
    valid_evidence = isinstance(evidence, list) and evidence and all(text(e.get('ref')) and text(e.get('observation')) for e in evidence)
    if status == 'met' and not valid_evidence:
        errors.append('met item lacks evidence: ' + str(item_id))
    if status != 'met' and not text(item.get('reason')):
        errors.append('non-met item lacks reason: ' + str(item_id))
    if status not in ('met', 'notApplicable'):
        approved = False
for item_id in expected - covered:
    errors.append('missing checklist item: ' + str(item_id))
print(json.dumps({'schema': 'genehub.review-coverage.v1', 'valid': not errors,
    'verdict': 'invalid' if errors else 'approved' if approved else 'changesRequested',
    'contractDigest': digest(raw), 'reportDigest': digest(report_raw), 'acceptanceDigest': acceptance_digest(contract),
    'artifactRevision': contract.get('artifactRevision'), 'checkedItems': len(covered),
    'errors': errors, 'evidenceExecutionVerified': False}, ensure_ascii=False))
sys.exit(1 if errors else 0)
