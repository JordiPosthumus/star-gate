"""Genie's maintenance tools: drain and resume one enrolled worker.

Each call is a POST to the existing operator control socket, followed by a fresh
read, so the answer is the observed state rather than an acknowledgement. Draining
the last healthy worker is refused unless the caller says so explicitly.
"""
import json
import re

from genie_fleet import _request

TOOLSET = 'stargate_actions'
NAMES = {'drain_worker', 'resume_worker'}

WORKER = re.compile(r'^[A-Za-z0-9][\w-]{0,63}$')
MAX_REASON = 200


def _snapshot(socket_path):
    value = _request(socket_path)
    workers = value.get('workers') or []
    if not isinstance(workers, list):
        raise ValueError('Unexpected fleet status shape')
    return value, workers


def _find(workers, worker_id):
    for worker in workers:
        if worker.get('id') == worker_id:
            return worker
    return None


def _healthy(workers):
    return [w for w in workers if w.get('is_healthy') is True and w.get('drained') is not True]


def _observe(worker):
    if not worker:
        return {'present': False}
    return {
        'present': True,
        'drained': worker.get('drained'),
        'operator_paused': worker.get('operator_paused'),
        'is_healthy': worker.get('is_healthy'),
        'quarantine': worker.get('quarantine'),
        'holds': worker.get('holds'),
        'maintenance_locks': worker.get('maintenance_locks'),
    }


def _checked_worker_id(args):
    worker_id = args.get('worker_id') if isinstance(args, dict) else None
    if not isinstance(worker_id, str) or not WORKER.match(worker_id):
        raise ValueError('Name one worker with a plain ID')
    return worker_id


def drain_worker(socket_path, args):
    worker_id = _checked_worker_id(args)
    reason = args.get('reason', '')
    if reason is not None and (not isinstance(reason, str) or len(reason) > MAX_REASON):
        raise ValueError('A drain reason is at most 200 characters')
    allow_last = args.get('allow_last_worker') is True

    value, workers = _snapshot(socket_path)
    target = _find(workers, worker_id)
    if target is None:
        raise ValueError('Unknown worker')
    if target.get('drained') is True:
        return {'worker': worker_id, 'drained': True, 'already': True, 'observed': _observe(target)}
    healthy = _healthy(workers)
    if target.get('is_healthy') is True and len(healthy) <= 1 and not allow_last:
        raise ValueError(
            'That is the last healthy worker. Draining it would stop the fleet serving. '
            'Set allow_last_worker only when the owner has accepted that outage.'
        )
    _request(socket_path, '/drain-workers', method='POST', body={'workers': [worker_id]})
    _, after = _snapshot(socket_path)
    current = _find(after, worker_id)
    return {
        'worker': worker_id,
        'drained': bool(current and current.get('drained') is True),
        'reason': reason or None,
        'observed': _observe(current),
        'fleet': {'healthy': len(_healthy(after)), 'workers': len(after)},
    }


def resume_worker(socket_path, args):
    worker_id = _checked_worker_id(args)
    _, workers = _snapshot(socket_path)
    target = _find(workers, worker_id)
    if target is None:
        raise ValueError('Unknown worker')
    if target.get('drained') is not True:
        return {'worker': worker_id, 'drained': False, 'already': True, 'observed': _observe(target)}
    if target.get('quarantine'):
        return {
            'worker': worker_id,
            'drained': True,
            'refused': 'quarantined',
            'detail': 'This worker needs verified readmission, not a resume. Inspect its quarantine reason.',
            'observed': _observe(target),
        }
    try:
        _request(socket_path, '/resume-workers', method='POST', body={'workers': [worker_id]}, timeout=90)
    except ValueError as error:
        _, after = _snapshot(socket_path)
        return {
            'worker': worker_id,
            'drained': True,
            'failed': str(error),
            'observed': _observe(_find(after, worker_id)),
        }
    _, after = _snapshot(socket_path)
    current = _find(after, worker_id)
    return {
        'worker': worker_id,
        'drained': bool(current and current.get('drained') is True),
        'observed': _observe(current),
        'fleet': {'healthy': len(_healthy(after)), 'workers': len(after)},
    }


def register_actions(config, emit):
    from tools.registry import registry

    socket_path = config.get('control_socket') if isinstance(config, dict) else None

    def run(name, args):
        event = {'tool': name, 'at': None, 'worker': (args or {}).get('worker_id')}
        emit('operation', event={**event, 'state': 'running'})
        try:
            if name == 'drain_worker':
                result = drain_worker(socket_path, args or {})
            elif name == 'resume_worker':
                result = resume_worker(socket_path, args or {})
            else:
                raise ValueError('Unknown maintenance tool')
        except Exception as error:  # noqa: BLE001 - category only
            message = f'{name} was not completed: {error}'
            emit('operation', event={**event, 'state': 'failed', 'error': message})
            return json.dumps({'error': message, 'next_step': 'Read genie_fleet_status before deciding anything else.'})
        emit('operation', event={**event, 'state': 'complete', 'drained': result.get('drained')})
        return json.dumps(result)

    common = {'worker_id': {'type': 'string', 'pattern': '^[A-Za-z0-9][\\w-]{0,63}$', 'description': 'Exact enrolled worker ID.'}}
    registry.register(
        name='drain_worker',
        toolset=TOOLSET,
        schema={
            'name': 'drain_worker',
            'description': (
                'Stop routing new work to one worker while its active requests finish. Use this only '
                'when the owner asked for maintenance or a worker must be taken out of service. It '
                'never cancels running work. Refuses to drain the last healthy worker unless '
                'allow_last_worker is explicitly true. Report the observed state, not just success.'
            ),
            'parameters': {
                'type': 'object',
                'properties': {
                    **common,
                    'reason': {'type': 'string', 'maxLength': MAX_REASON, 'description': 'Why, in a few words.'},
                    'allow_last_worker': {'type': 'boolean', 'description': 'Only with explicit owner acceptance of an outage.'},
                },
                'required': ['worker_id'],
                'additionalProperties': False,
            },
        },
        handler=lambda args, _name='drain_worker', **kw: run(_name, args),
        max_result_size_chars=65536,
    )
    registry.register(
        name='resume_worker',
        toolset=TOOLSET,
        schema={
            'name': 'resume_worker',
            'description': (
                'Enable routing to one drained worker after maintenance. The gateway runs its own '
                'fresh compatibility probe and may refuse. A quarantined worker is not resumed here; '
                'it needs verified readmission. Report the observed state afterwards.'
            ),
            'parameters': {
                'type': 'object',
                'properties': common,
                'required': ['worker_id'],
                'additionalProperties': False,
            },
        },
        handler=lambda args, _name='resume_worker', **kw: run(_name, args),
        max_result_size_chars=65536,
    )
    return NAMES
