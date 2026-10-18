"""Genie's read-only fleet tools.

Every call goes back to the gateway over its private Unix control socket. Nothing
here holds state, and nothing here can change the fleet: the module only exposes
`genie_fleet_status`. Authority to act lives on the Node side, not in the prompt.
"""
import json
import socket

TOOLSET = 'stargate_fleet'
NAMES = {'genie_fleet_status'}

MAX_BYTES = 262144
WORKER_FIELDS = (
    'id', 'model', 'backend', 'context_length', 'is_healthy', 'drained',
    'active', 'queued', 'load', 'max_concurrent_requests', 'quarantine',
    'operator_paused', 'holds', 'maintenance_locks', 'last_failure_class',
    'transport_failures', 'inference_failures',
)


def _request(socket_path, path='/workers', method='GET', body=None, timeout=15):
    """One bounded request over the operator socket. Never a network address."""
    if not isinstance(socket_path, str) or not socket_path.startswith('/'):
        raise ValueError('The fleet tool needs an absolute control socket path')
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(socket_path)
        payload = b'' if body is None else json.dumps(body).encode()
        head = (
            f'{method} {path} HTTP/1.1\r\n'
            'Host: localhost\r\n'
            'Content-Type: application/json\r\n'
            f'Content-Length: {len(payload)}\r\n'
            'Connection: close\r\n\r\n'
        ).encode()
        client.sendall(head + payload)
        chunks, total = [], 0
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                raise ValueError('Fleet status is larger than the tool allowance')
            chunks.append(chunk)
    finally:
        client.close()
    raw = b''.join(chunks)
    header, _, body_bytes = raw.partition(b'\r\n\r\n')
    status = int(header.split(b' ')[1]) if header else 0
    if b'transfer-encoding: chunked' in header.lower():
        body_bytes = _dechunk(body_bytes)
    try:
        parsed = json.loads(body_bytes)
    except ValueError:
        if status >= 400:
            raise ValueError(f'The gateway refused the request ({status})') from None
        raise
    if status >= 400:
        detail = parsed.get('error') if isinstance(parsed, dict) else None
        raise ValueError(detail or f'The gateway refused the request ({status})')
    return parsed


def _dechunk(body):
    """Decode a chunked body. Node answers control-socket requests this way."""
    out, rest = [], body
    while True:
        line, _, rest = rest.partition(b'\r\n')
        if not line:
            break
        try:
            size = int(line.split(b';')[0], 16)
        except ValueError:
            raise ValueError('Malformed chunked fleet response') from None
        if size == 0:
            break
        out.append(rest[:size])
        rest = rest[size + 2:]
    return b''.join(out)


def _compact(value):
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in WORKER_FIELDS if key in value}


def fleet_status(socket_path):
    """A bounded snapshot: counts, per-worker state and any blocking reason."""
    value = _request(socket_path)
    workers = value.get('workers') or []
    if not isinstance(workers, list):
        raise ValueError('Unexpected fleet status shape')
    rows = [_compact(worker) for worker in workers]
    healthy = [row for row in rows if row.get('is_healthy') is True and row.get('drained') is not True]
    return {
        'observed_at': value.get('time') or None,
        'model': value.get('model'),
        'context_length': value.get('context_length'),
        'draining': value.get('draining'),
        'queued_relocation': {
            'automatic': (value.get('queued_relocation') or {}).get('automatic'),
            'offers': len((value.get('queued_relocation') or {}).get('offers') or []),
        },
        'recovery': {
            'configured': (value.get('recovery') or {}).get('configured'),
            'automatic': (value.get('recovery') or {}).get('automatic'),
        },
        'counts': {
            'workers': len(rows),
            'healthy': len(healthy),
            'active': sum(int(row.get('active') or 0) for row in rows),
            'queued': sum(int(row.get('queued') or 0) for row in rows),
        },
        'workers': rows,
        'scope': (
            'Observed gateway state only. A worker that is alive is not proof that it '
            'is serving; quarantine and pause reasons are reported as recorded.'
        ),
    }


def register_fleet(config, emit):
    from tools.registry import registry

    socket_path = config.get('control_socket') if isinstance(config, dict) else None

    def run(name, args):
        if name != 'genie_fleet_status':
            raise ValueError('Unknown fleet tool')
        if args:
            raise ValueError('genie_fleet_status takes no arguments')
        emit('inspection', event={'tool': name, 'state': 'reading'})
        try:
            result = fleet_status(socket_path)
        except Exception as error:  # noqa: BLE001 - report the category, never a path
            message = f'Fleet status could not be read: {error}'
            emit('inspection', event={'tool': name, 'state': 'failed', 'error': message})
            return json.dumps({'error': message, 'next_step': 'Do not invent fleet state. Say the status is unavailable.'})
        emit('inspection', event={'tool': name, 'state': 'complete', 'counts': result['counts']})
        return json.dumps(result)

    registry.register(
        name='genie_fleet_status',
        toolset=TOOLSET,
        schema={
            'name': 'genie_fleet_status',
            'description': (
                'Read the current gateway fleet: per-worker health, pause and quarantine '
                'state, active and queued counts, recovery policy and queued offers. '
                'Read-only. Call it before answering any question about current state.'
            ),
            'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False},
        },
        handler=lambda args, _name='genie_fleet_status', **kw: run(_name, args),
        max_result_size_chars=MAX_BYTES,
    )
    return NAMES
