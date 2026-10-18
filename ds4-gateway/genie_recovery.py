"""Genie's recovery tools.

Recovery evidence is produced by the gateway's own service adapter, not by Genie:
inspection is requested here and read back from recovery_status. A recovery
request carries one fresh evidence ID and returns an operation receipt, never a
claim that the worker is serving again.
"""
import json
import re

from genie_fleet import _request

TOOLSET = 'stargate_recovery'
NAMES = {'recovery_status', 'inspect_worker', 'recover_worker'}

WORKER = re.compile(r'^[A-Za-z0-9][\w-]{0,63}$')
EVIDENCE = re.compile(r'^[a-f0-9]{16,64}$')
MAX_BYTES = 262144
WORKER_FIELDS = (
    'worker_id', 'configured', 'adapter', 'transport', 'reason', 'eligible',
    'evidence_id', 'inspected_at',
)
OP_FIELDS = ('id', 'worker_id', 'actor', 'state', 'service_action', 'created_at', 'updated_at', 'error')


def _compact(worker):
    return {key: worker[key] for key in WORKER_FIELDS if key in worker}


def _operation(value):
    if not isinstance(value, dict):
        return None
    return {key: value[key] for key in OP_FIELDS if key in value}


def recovery_status(socket_path):
    value = _request(socket_path)
    recovery = value.get('recovery') or {}
    workers = recovery.get('workers') or []
    operations = recovery.get('operations') or []
    if not isinstance(workers, list) or not isinstance(operations, list):
        raise ValueError('Unexpected recovery status shape')
    return {
        'policy': {
            'configured': recovery.get('configured'),
            'automatic': recovery.get('automatic'),
            'profile_handback_automatic': recovery.get('profile_handback_automatic'),
            'adapter': recovery.get('adapter'),
        },
        'workers': [_compact(worker) for worker in workers],
        'operations': [_operation(op) for op in operations[:5]],
        'scope': (
            'Eligibility describes the observed fault now, not a promise about the future. '
            'evidence_id is valid only for the inspection shown; request a new inspection '
            'after it goes stale. An accepted operation is a receipt, not proof of recovery.'
        ),
    }


def _worker_id(args):
    worker_id = args.get('worker_id') if isinstance(args, dict) else None
    if not isinstance(worker_id, str) or not WORKER.match(worker_id):
        raise ValueError('Name one worker with a plain ID')
    return worker_id


def inspect_worker(socket_path, args):
    worker_id = _worker_id(args)
    _request(socket_path, '/recovery-inspect', method='POST', body={'worker_id': worker_id})
    return {
        'worker_id': worker_id,
        'state': 'inspecting',
        'next_step': 'Read recovery_status until inspected_at changes, then use that evidence_id.',
    }


def recover_worker(socket_path, args):
    worker_id = _worker_id(args)
    evidence_id = args.get('evidence_id') if isinstance(args, dict) else None
    if not isinstance(evidence_id, str) or not EVIDENCE.match(evidence_id):
        raise ValueError('Use the evidence_id from the current recovery_status')
    operation = _request(
        socket_path,
        '/genie-recover-worker',
        method='POST',
        body={'worker_id': worker_id, 'evidence_id': evidence_id},
        timeout=30,
    )
    compact = _operation(operation)
    return {
        'accepted': True,
        'operation': compact,
        'next_step': (
            'Read recovery_status and follow this operation ID. Never repeat the request while '
            'its outcome is uncertain, and never resume the worker until the gateway says it is verified.'
        ),
    }


def register_recovery(config, emit):
    from tools.registry import registry

    socket_path = config.get('control_socket') if isinstance(config, dict) else None

    def run(name, args):
        event = {'tool': name, 'worker': (args or {}).get('worker_id')}
        emit('recovery', event={**event, 'state': 'reading'})
        try:
            if name == 'recovery_status':
                result = recovery_status(socket_path)
            elif name == 'inspect_worker':
                result = inspect_worker(socket_path, args or {})
            elif name == 'recover_worker':
                result = recover_worker(socket_path, args or {})
            else:
                raise ValueError('Unknown recovery tool')
        except Exception as error:  # noqa: BLE001 - message is gateway text or a category
            message = f'{name} was not completed: {error}'
            emit('recovery', event={**event, 'state': 'failed', 'error': message})
            return json.dumps({'error': message, 'next_step': 'Read recovery_status before deciding anything else. Do not replay an uncertain request.'})
        emit('recovery', event={**event, 'state': 'complete'})
        return json.dumps(result)

    common = {'worker_id': {'type': 'string', 'pattern': '^[A-Za-z0-9][\\w-]{0,63}$', 'description': 'Exact enrolled worker ID.'}}
    registry.register(
        name='recovery_status',
        toolset=TOOLSET,
        schema={
            'name': 'recovery_status',
            'description': (
                'Read recovery policy, per-worker enrollment and eligibility, the newest evidence '
                'IDs and recent operation receipts. Read this before inspecting or recovering, and '
                'after every accepted request. Eligibility now does not promise future eligibility.'
            ),
            'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False},
        },
        handler=lambda args, _name='recovery_status', **kw: run(_name, args),
        max_result_size_chars=MAX_BYTES,
    )
    registry.register(
        name='inspect_worker',
        toolset=TOOLSET,
        schema={
            'name': 'inspect_worker',
            'description': (
                'Ask the gateway to refresh one worker\'s service evidence through its own recovery '
                'adapter. This starts an inspection; it changes no service. Read recovery_status '
                'afterwards for the new inspected_at and evidence_id.'
            ),
            'parameters': {'type': 'object', 'properties': common, 'required': ['worker_id'], 'additionalProperties': False},
        },
        handler=lambda args, _name='inspect_worker', **kw: run(_name, args),
        max_result_size_chars=65536,
    )
    registry.register(
        name='recover_worker',
        toolset=TOOLSET,
        schema={
            'name': 'recover_worker',
            'description': (
                'Request existing recovery for one eligible worker with the exact evidence_id from '
                'the current recovery_status. Cannot enroll services, change settings, run canaries '
                'or cancel active jobs. Returns an operation receipt, not proof of completion. '
                'Never replay an uncertain request.'
            ),
            'parameters': {
                'type': 'object',
                'properties': {
                    **common,
                    'evidence_id': {'type': 'string', 'pattern': '^[a-f0-9]{16,64}$', 'description': 'From the current recovery_status for this worker.'},
                },
                'required': ['worker_id', 'evidence_id'],
                'additionalProperties': False,
            },
        },
        handler=lambda args, _name='recover_worker', **kw: run(_name, args),
        max_result_size_chars=65536,
    )
    return NAMES
