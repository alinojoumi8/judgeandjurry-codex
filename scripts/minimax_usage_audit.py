"""Read saved courtroom HTTP evidence; never dispatch inference requests.

The since filter deliberately bounds discovery to recent live/probe directories.
Completed exchange metadata is cached; cumulative usage.json files are not summed.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re


def epoch(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def evidence_path(value):
    path = Path(value).resolve()
    # Path.rglob can silently skip deep Windows evidence directories without this.
    if os.name == 'nt' and not str(path).startswith('\\\\?\\'):
        path = Path('\\\\?\\' + str(path))
    return path


def discover(project, since):
    parents = list((project / 'tmp/qa/courtroom').glob('jury-v*-current-comparison'))
    parents += list((project / 'tmp/qa/courtroom').glob('jury-v*-provider-retry'))
    parents += list((project / 'tmp/qa/courtroom').glob('jury-v*-focused'))
    parents += list((project / 'tmp/qa/courtroom').glob('jury-v*-fresh-followup'))
    parents += [project / 'tmp/qa/courtroom/full-jury']
    parents += [p / 'tmp/qa/courtroom/full-jury'
                for p in (project / 'tmp/qa').glob('jury-contract-matrix-v*')]
    roots = set()
    for directory in (project / 'tmp/qa/courtroom').glob('browser-v*-*'):
        match = re.search(r'-(\d{13})$', directory.name)
        if directory.is_dir() and match and int(match[1]) / 1000 >= since:
            roots.add(directory)
    for parent in parents:
        if not parent.is_dir():
            continue
        for directory in parent.iterdir():
            match = re.search(r'-(\d{13})$', directory.name)
            if (directory.is_dir() and directory.name.startswith(('live-', 'probe-'))
                    and match and int(match[1]) / 1000 >= since):
                roots.add(directory)
    return sorted(roots)


def read_exchange(file, project):
    data = json.loads(file.read_text(encoding='utf-8'))
    recovered = False
    pending = file.with_name(file.name + '.writing')
    # A failed atomic rename can leave a complete receipt next to an older
    # streaming snapshot. Count the request once and recover usage only when
    # the request identity, response bytes and numeric receipt agree exactly.
    if data.get('state') != 'received' and pending.exists():
        try:
            candidate = json.loads(pending.read_text(encoding='utf-8'))
            raw = (file.parent / 'response-body.raw').read_bytes()
            if (candidate.get('state') == 'received'
                    and candidate.get('startedAt') == data.get('startedAt')
                    and candidate.get('requestHash') == data.get('requestHash')
                    and candidate.get('responseHash') == hashlib.sha256(raw).hexdigest()
                    and candidate.get('reportedUsage') == json.loads(raw).get('usage')):
                data, recovered = candidate, True
        except (OSError, ValueError):
            pass  # In-flight or invalid receipt remains unknown, never zero.
    started = data.get('startedAt')
    if not started:
        raise ValueError('missing start time')
    row = {k: data.get(k) for k in ('startedAt', 'finishedAt', 'state', 'httpStatus',
                                    'requestHash', 'requestCharacters', 'requestRole', 'caseId')}
    row['path'] = file.relative_to(project).as_posix()
    row['run'] = next((p for p in file.parts if p.startswith(('live-', 'probe-'))), 'unknown')
    row['usage'] = data.get('reportedUsage')
    if recovered:
        row['recoveredFromPendingMetadataCommit'] = True
    row['integrityErrors'] = []
    request_file = file.parent / 'request-body.txt'
    if request_file.exists():
        raw_request = request_file.read_bytes()
        if hashlib.sha256(raw_request).hexdigest() != data.get('requestHash'):
            row['integrityErrors'].append('request hash mismatch')
        request = json.loads(raw_request)
        row['model'] = request.get('model')
        row['reasoningEffort'] = request.get('reasoning_effort')
        row['maxCompletionTokens'] = request.get('max_completion_tokens', request.get('max_tokens'))
        row['messages'] = [{'role': m.get('role'), 'characters': len(str(m.get('content', ''))),
                            'hash': hashlib.sha256(str(m.get('content', '')).encode()).hexdigest()}
                           for m in request.get('messages', [])]
    if data.get('state') == 'received':
        response = (file.parent / 'response-body.raw').read_bytes()
        if hashlib.sha256(response).hexdigest() != data.get('responseHash'):
            row['integrityErrors'].append('response hash mismatch')
        parsed = json.loads(response)
        if parsed.get('usage') != data.get('reportedUsage'):
            row['integrityErrors'].append('response usage mismatch')
        row['returnedModel'] = parsed.get('model')
        # Store only the numeric provider error suffix, never response text/reasoning.
        message = str((parsed.get('error') or {}).get('message', ''))
        code = re.search(r'\((\d+)\)\s*$', message)
        row['providerErrorCode'] = code[1] if code else None
    return row


def aggregate(rows):
    counts = Counter()
    status = Counter()
    models = Counter()
    efforts = Counter()
    messages = defaultdict(Counter)
    systems = Counter()
    for row in rows:
        if row.get('state') == 'prepared':
            counts['preparedNotDispatched'] += 1
            continue
        counts['calls'] += 1
        status[str(row.get('httpStatus', 'unknown'))] += 1
        models[str(row.get('model'))] += 1
        efforts[str(row.get('reasoningEffort'))] += 1
        usage = row.get('usage')
        if not isinstance(usage, dict) or not isinstance(usage.get('total_tokens'), (int, float)):
            counts['callsWithoutReportedUsage'] += 1
        else:
            counts['reportedTotalTokens'] += usage['total_tokens']
            for source, target in [('prompt_tokens', 'inputTokens'), ('completion_tokens', 'outputTokens')]:
                if isinstance(usage.get(source), (int, float)):
                    counts[target] += usage[source]
                else:
                    counts[target + 'MissingCalls'] += 1
            for source, field, target in [('prompt_tokens_details', 'cached_tokens', 'cachedInputTokens'),
                                          ('completion_tokens_details', 'reasoning_tokens', 'reasoningOutputTokens')]:
                value = (usage.get(source) or {}).get(field)
                if isinstance(value, (int, float)):
                    counts[target] += value
                else:
                    counts[target + 'MissingCalls'] += 1
        counts['requestCharacters'] += row.get('requestCharacters') or 0
        counts['integrityErrors'] += len(row.get('integrityErrors', []))
        counts['quotaRefusals2056'] += row.get('providerErrorCode') == '2056'
        for message in row.get('messages', []):
            role = str(message.get('role'))
            messages[role]['calls'] += 1
            messages[role]['characters'] += message['characters']
            if role == 'system':
                systems[(message['hash'], message['characters'])] += 1
    result = dict(counts)
    result.update(httpStatus=dict(status), requestedModels=dict(models), reasoningEffort=dict(efforts),
                  messageCharacters={role: {**values, 'mean': round(values['characters'] / values['calls'], 2)}
                                     for role, values in messages.items()},
                  commonSystemMessages=[{'sha256': key[0], 'characters': key[1], 'calls': number}
                                        for key, number in systems.most_common(8)])
    # Cache and reasoning counts are SUBSETS, not extra usage added to total.
    result['uncachedInputTokens'] = (counts['inputTokens'] - counts['cachedInputTokens']
                                    if not counts['cachedInputTokensMissingCalls'] and not counts['inputTokensMissingCalls'] else None)
    result['actualCost'] = None
    return result


def report(rows, since, until=None):
    selected = sorted((r for r in rows if epoch(r['startedAt']) >= since
                       and (until is None or epoch(r['startedAt']) < until)), key=lambda r: r['startedAt'])
    groups, roles, buckets = defaultdict(list), defaultdict(list), defaultdict(list)
    hashes, duplicate_rows = set(), []
    for row in selected:
        groups[row['run']].append(row)
        roles[row.get('requestRole') or 'unknown'].append(row)
        bucket = int(epoch(row['startedAt']) // 600) * 600
        buckets[datetime.fromtimestamp(bucket, timezone.utc).isoformat()].append(row)
        request_hash = row.get('requestHash')
        if request_hash and request_hash in hashes:
            duplicate_rows.append(row)
        hashes.add(request_hash)
    total = aggregate(selected)
    return {'totals': total, 'firstCallAt': selected[0]['startedAt'] if selected else None,
            'lastCallAt': selected[-1]['startedAt'] if selected else None,
            'byRun': {key: aggregate(value) for key, value in groups.items()},
            'byRole': {key: aggregate(value) for key, value in roles.items()},
            'tenMinuteBuckets': {key: aggregate(value) for key, value in buckets.items()},
            'exactRepeatedRequestsBeyondFirst': aggregate(duplicate_rows),
            'limitations': ['Only saved courtroom live/probe evidence in this checkout; other apps/account traffic is unknown.',
                            'Directory start timestamps must be on or after --since; older in-flight runs need explicit --root.',
                            'Reported totals include cached input; reasoning tokens are included in output, not added again.',
                            'Missing usage is unknown, never assumed zero. Token totals are not provider quota units or money.']}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.writing')
    temp.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path.cwd())
    parser.add_argument('--since', required=True)
    parser.add_argument('--until')
    parser.add_argument('--root', action='append', type=Path, default=[])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True)
    args = parser.parse_args()
    project = evidence_path(args.project)
    since, until = epoch(args.since), epoch(args.until) if args.until else None
    roots = set(discover(project, since)) | {evidence_path(root) for root in args.root}
    previous = json.loads(args.state.read_text(encoding='utf-8')) if args.state.exists() else {}
    cache = previous.get('exchanges', {})
    rows, errors, new_reads = [], [], 0
    for root in sorted(roots):
        root = root.resolve()
        if not root.is_relative_to(project):
            raise ValueError('Evidence root outside project')
        for file in root.rglob('exchange.json'):
            key = file.relative_to(project).as_posix()
            stat = file.stat()
            fingerprint = [stat.st_size, stat.st_mtime_ns]
            cached = cache.get(key)
            if (cached and cached['fingerprint'] == fingerprint and cached['row'].get('state') == 'received'
                    and not cached['row'].get('recoveredFromPendingMetadataCommit')):
                row = cached['row']
            else:
                try:
                    row = read_exchange(file, project)
                    new_reads += 1
                except (OSError, ValueError, KeyError, TypeError):
                    errors.append(key)
                    continue
                cache[key] = {'fingerprint': fingerprint, 'row': row}
            rows.append(row)
    result = report(rows, since, until)
    now = datetime.now(timezone.utc).isoformat()
    old_totals = previous.get('lastTotals', {}) if previous.get('since') == args.since else {}
    total = result['totals']
    result.update(checkedAt=now, since=args.since, until=args.until, project=str(project),
                  evidenceRoots=[str(root.relative_to(project)) for root in sorted(roots)],
                  unreadableOrInFlightMetadata=errors, freshlyReadExchanges=new_reads,
                  baselineCreated=not bool(old_totals), previousCheckedAt=previous.get('checkedAt'),
                  deltaSincePrevious={key: total.get(key, 0) - old_totals.get(key, 0)
                                      for key in ('calls', 'reportedTotalTokens', 'quotaRefusals2056')}  # Non-secret counter names. gitleaks:allow
                  if old_totals else None)
    write_json(args.output, result)
    write_json(args.state, {'project': str(project), 'since': args.since, 'checkedAt': now,
                            'lastTotals': total, 'exchanges': cache})
    print(json.dumps({key: result[key] for key in ('checkedAt', 'firstCallAt', 'lastCallAt', 'totals',
                                                  'baselineCreated', 'deltaSincePrevious', 'freshlyReadExchanges')}, indent=2))


if __name__ == '__main__':
    main()
