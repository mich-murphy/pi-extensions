"""Production adapter over real pinned offline Pi; simulated transport is explicitly not a gateway attestation."""
import json
import shutil
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from offline import HERE, Journey


class Gateway:
    def __init__(self):
        self.directory = Path(tempfile.mkdtemp(prefix='psc-gateway-', dir='/tmp'))
        self.path = self.directory / 'gateway.sock'
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(self.path))
        self.listener.listen(4)
        self.listener.settimeout(0.1)
        self.stop = False
        self.current = None
        self.peer = None
        self.requests = []
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def configure(self, directory):
        (directory / 'agent/session-communication.json').write_text(json.dumps({
            'machineId': 'alpha', 'socketPath': str(self.path), 'scopeIds': ['team'], 'label': 'isolated offline adapter',
            'policies': [{'machineId': 'beta', 'scopeId': 'team', 'permissions': ['discover', 'read', 'push', 'interest']}],
        }))

    @staticmethod
    def frame(value):
        body = json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()
        return len(body).to_bytes(4, 'big') + body

    def write(self, value):
        with self.lock:
            assert self.current is not None
            self.current.sendall(self.frame(value))

    def answer(self, request):
        value = None
        op = request['op']
        if op == 'register':
            self.peer = {'machineId': 'alpha', 'sessionId': request['sessionId'], 'runtimeNonce': request['runtimeNonce']}
            value = {'peer': self.peer, 'scopeIds': ['team']}
        elif op == 'discover':
            value = {'peers': [{'peer': OTHER, 'label': 'offline beta', 'scopeIds': ['team']}], 'watching': request['watch']}
        elif op == 'state.list':
            value = {'publisher': request['publisher'], 'scopeId': request['scopeId'], 'revision': 0, 'items': []}
        elif op == 'send':
            return {'v': 1, 'op': 'result', 'rid': request['rid'], 'forOp': op,
                    'outcome': {'tag': 'admitted', 'binding': {'messageId': request['message']['id'], 'sender': self.peer, 'recipient': request['to'], 'scopeId': request['scopeId']}, 'correlation': 'none'}}
        if value is not None:
            return {'v': 1, 'op': 'result', 'rid': request['rid'], 'forOp': op, 'outcome': {'tag': 'ok', 'value': value}}
        return None

    def serve(self):
        while not self.stop:
            try:
                connection, _ = self.listener.accept()
            except (TimeoutError, OSError):
                continue
            self.current = connection
            buffer = b''
            try:
                while not self.stop:
                    chunk = connection.recv(65536)
                    if not chunk:
                        break
                    buffer += chunk
                    while len(buffer) >= 4 and len(buffer) >= int.from_bytes(buffer[:4], 'big') + 4:
                        total = int.from_bytes(buffer[:4], 'big') + 4
                        request = json.loads(buffer[4:total])
                        buffer = buffer[total:]
                        self.requests.append(request)
                        reply = self.answer(request)
                        if reply is not None:
                            self.write(reply)
            except OSError:
                pass
            finally:
                connection.close()
                self.current = None

    def deliver(self, identity, sender=None):
        rid = f'{identity + 10000:032x}'
        self.write({'v': 1, 'op': 'deliver', 'rid': rid, 'from': sender or OTHER,
                    'to': self.peer, 'scopeId': 'team',
                    'message': {'id': f'{identity:032x}', 'kind': 'update', 'format': 'text', 'content': f'PRODUCTION_PEER: {identity}'}})
        return rid

    def close(self):
        self.stop = True
        if self.current is not None:
            try:
                self.current.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.listener.close()
        self.thread.join(timeout=3)
        assert not self.thread.is_alive(), 'Simulated gateway thread leaked'
        shutil.rmtree(self.directory)


OTHER = {'machineId': 'beta', 'sessionId': 'offline-peer', 'runtimeNonce': 'b' * 32}


class ProductionAdapter(unittest.TestCase):
    def setUp(self):
        self.children = []
        self.gateways = []

    def tearDown(self):
        for child in self.children:
            child.close()
        for gateway in self.gateways:
            gateway.close()

    def start(self, tui=False, enabled=True):
        gateway = Gateway()
        self.gateways.append(gateway)
        child = Journey(tui, self._testMethodName, setup=gateway.configure if enabled else None,
                        extension=HERE / 'production-extension.ts')
        self.children.append(child)
        if enabled:
            child.wait(lambda: gateway.peer is not None, 'production adapter registration')
        return child, gateway

    @staticmethod
    def results(child, tool):
        return [event['data'] for event in child.events('production_message')
                if event['data']['role'] == 'toolResult' and event['data']['toolName'] == tool]

    def call(self, child, name, arguments):
        before = len(child.events('settled_last'))
        count = len(self.results(child, name))
        child.rpc('prompt', message='ADAPTER_CALL:' + json.dumps({'name': name, 'arguments': arguments}))
        child.settled(before)
        child.wait(lambda: len(self.results(child, name)) > count, name)
        result = self.results(child, name)[-1]
        self.assertFalse(result['isError'], result)
        return result['details']['value']

    def test_rpc_tools_and_config_opt_in(self):
        inert, disconnected = self.start(enabled=False)
        inert.rpc('prompt', message='/session-communication status')
        self.assertFalse(disconnected.requests)
        self.assertFalse(inert.events('production_request'))
        j, gateway = self.start()
        peers = self.call(j, 'session_peers', {'scopeIds': ['team']})
        self.assertEqual(peers['peers'][0]['peer'], OTHER)
        result = self.call(j, 'session_send', {'to': OTHER, 'scopeId': 'team', 'message': {'kind': 'request', 'format': 'text', 'content': 'authored request'}})
        self.assertEqual(result['outcome']['tag'], 'admitted')
        requests = [request for request in gateway.requests if request['op'] == 'send']
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(requests[0]['message']['id']), 32)
        publication = {'category': 'context', 'title': 'title', 'summary': 'summary', 'format': 'text', 'preparation': 'authored'}
        result = self.call(j, 'session_state', {'action': 'put', 'scopeId': 'team', 'key': 'notes', 'record': publication})
        self.assertEqual(result['tag'], 'ok')
        result = self.call(j, 'session_state', {'action': 'list', 'publisher': OTHER, 'scopeId': 'team'})
        self.assertEqual(result['tag'], 'ok')
        before = len(j.events('settled_last'))
        rid = gateway.deliver(1)
        j.wait(lambda: any(request.get('rid') == rid for request in gateway.requests), 'production admitted receipt')
        j.settled(before)
        take = self.results(j, 'session_take')[-1]['details']['value']
        self.assertEqual(take['messages'][0]['provenance']['sender'], OTHER)
        self.assertEqual(take['messages'][0]['message']['content'], 'PRODUCTION_PEER: 1')
        before = len(j.events('production_request'))
        gateway.deliver(1)
        j.rpc('get_state')
        self.assertEqual(len(j.events('production_request')), before, 'duplicate and state read do not wake')
        old = gateway.peer['runtimeNonce']
        j.rpc('prompt', message='/spike-reload')
        j.wait(lambda: gateway.peer['runtimeNonce'] != old, 'production reload registration')
        self.assertNotEqual(gateway.peer['runtimeNonce'], old)

    def test_tui_abort_fresh_push_and_take_cycles(self):
        import os
        j, gateway = self.start(tui=True)
        for cycle in range(3):
            j.control('mode', mode='hold')
            count = len(j.events('production_request'))
            before = len(j.events('settled_last'))
            gateway.deliver(cycle * 10 + 1)
            j.wait(lambda: len(j.events('production_request')) > count, 'production idle notice hold')
            gateway.deliver(cycle * 10 + 2)
            aborts = len(j.events('production_abort'))
            os.write(j.master, b'\x1b')
            j.wait(lambda: len(j.events('production_abort')) > aborts, 'production native abort')
            gateway.deliver(cycle * 10 + 3)
            j.control('mode', mode='success')
            j.settled(before)
            self.assertEqual(len(self.results(j, 'session_take')), cycle)
            count = len(j.events('production_request'))
            gateway.deliver(cycle * 10 + 3)
            self.assertEqual(len(j.events('production_request')), count)
            before = len(j.events('settled_last'))
            gateway.deliver(cycle * 10 + 4)
            j.settled(before)
            j.wait(lambda: len(self.results(j, 'session_take')) == cycle + 1, 'production explicit take')
            self.assertEqual(len(self.results(j, 'session_take')[-1]['details']['value']['messages']), 4)
        notices = [event for event in j.events('production_message') if event['data'].get('customType') == 'session-communication-wake']
        self.assertEqual(len(notices), 6, 'one identified idle notice per initial/fresh wake; no busy or abort re-notice')


if __name__ == '__main__':
    unittest.main(verbosity=2)
