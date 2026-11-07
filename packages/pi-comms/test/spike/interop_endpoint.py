"""Isolated real gateway/Pi endpoint. JSON stdio is control, never gateway traffic.

Used locally or over SSH by interop.py. Only synthetic test results leave this
worker; private fixture bytes arrive via stdin and are never logged.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import shutil
import socket
import subprocess
import sys
import tempfile

if os.environ.get('PI_INTEROP_SOURCE'):
    sys.path.insert(0, str(Path(os.environ['PI_INTEROP_SOURCE']) /
                           'packages/pi-comms/test/spike'))

from offline import HERE, PACKAGE, Journey
from production import ProductionAdapter


def source_hashes():
    """Identify the exact source subset actually exercised, never user content."""
    package = HERE.parents[1]
    root = HERE.parents[3]
    paths = [package / 'index.ts', package / 'gateway/Cargo.toml', package / 'gateway/Cargo.lock',
             root / 'package.json', root / 'package-lock.json']
    for relative in ['adapter', 'state', 'protocol', 'gateway/src']:
        paths.extend(path for path in (package / relative).rglob('*') if path.is_file())
    hashes = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in sorted(paths)}
    return {'files': hashes, 'manifestSha256': hashlib.sha256(
        json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


class Endpoint:
    def __init__(self):
        self.directory = Path(tempfile.mkdtemp(prefix='psc-interop-', dir='/tmp')).resolve()
        self.directory.chmod(0o700)
        self.child = None
        self.gateway = None
        self.gateway_log = None

    def start_gateway(self):
        self.gateway_log = open(self.directory / 'gateway.stderr', 'ab')
        self.gateway = subprocess.Popen(
            [str(self.binary), '--config', str(self.directory / 'gateway.json')],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=self.gateway_log,
            env=self.env)
        ready, _, _ = select.select([self.gateway.stdout], [], [], 12)
        assert ready, 'gateway readiness deadline'
        line = self.gateway.stdout.readline()
        if not line:
            self.gateway_log.flush()
            raise RuntimeError((self.directory / 'gateway.stderr').read_text()[-1000:])
        assert json.loads(line)['event'] == 'ready', 'gateway not ready'

    def start(self, command):
        assert self.child is None
        assert json.loads((PACKAGE / 'package.json').read_text())['version'] == '1.5.0'
        self.binary = Path(command['binary']).resolve(strict=True)
        self.env = {key: os.environ[key] for key in ['PATH'] if key in os.environ}
        self.env.update({'HOME': str(self.directory), 'RAYON_NUM_THREADS': '2',
                         'UV_THREADPOOL_SIZE': '2', 'GOMAXPROCS': '2'})
        machine = command['machine']
        other = 'beta' if machine == 'alpha' else 'alpha'
        for name, encoded in command['credentials'].items():
            assert name in ['root.der', 'alpha.der', 'alpha-key.der', 'beta.der', 'beta-key.der', 'issuer.crl']
            path = self.directory / name
            path.write_bytes(base64.b64decode(encoded, validate=True))
            path.chmod(0o600)
        permissions = ['discover', 'read', 'push', 'interest']
        policy = {'machineId': other, 'scopeId': 'team', 'permissions': permissions}
        common = {'machineId': machine, 'socketPath': str(self.directory / 'gateway.sock'),
                  'scopeIds': ['team'], 'policies': [policy]}
        config = {**common, 'policies': [policy, {**policy, 'direction': 'incoming'}], 'remote': {
            'machineId': other, 'endpoint': command['endpoint'],
            'rootCertificates': [str(self.directory / 'root.der')],
            'certificateChain': [str(self.directory / (machine + '.der'))],
            'privateKey': str(self.directory / (machine + '-key.der')),
            'crls': [str(self.directory / 'issuer.crl')],
            'revocationState': str(self.directory / 'floors.json')}}
        (self.directory / 'gateway.json').write_text(json.dumps(config))
        subprocess.run([str(self.binary), '--initialize-revocation-floor', str(self.directory / 'floors.json')],
                       env=self.env, check=True, capture_output=True, timeout=12)
        self.start_gateway()

        def configure(directory):
            (directory / 'agent/session-communication.json').write_text(json.dumps(
                {**common, 'label': 'Synthetic interop ' + machine}))
        self.child = Journey(label='synthetic real interop ' + machine, setup=configure,
                             extension=HERE / 'production-extension.ts')
        return {'platform': platform.system(), 'architecture': platform.machine(), 'libc': platform.libc_ver(),
                'nodeVersion': subprocess.check_output(['node', '--version'], env=self.env, text=True).strip(),
                'piVersion': '1.5.0', 'source': source_hashes(),
                'controllerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'binarySha256': hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                'fixtureSha256': {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                                  for name in ['offline.py', 'extension.ts', 'production-extension.ts', 'production.py']}}

    def stop_gateway(self):
        if self.gateway is not None:
            if self.gateway.poll() is None:
                self.gateway.terminate()
                try:
                    self.gateway.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.gateway.kill()
                    self.gateway.wait(timeout=5)
                    raise AssertionError('gateway required forced kill')
            assert self.gateway.returncode == 0, 'gateway shutdown failed'
            self.gateway.stdout.close()
            self.gateway_log.close()
            self.gateway = None

    def dispatch(self, command):
        op = command['op']
        if op == 'address':
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                return '127.0.0.1:' + str(reservation.getsockname()[1])
        if op == 'start':
            return self.start(command)
        if op == 'call':
            return ProductionAdapter.call(ProductionAdapter(), self.child, command['name'], command['arguments'])
        if op == 'stats':
            self.child.rpc('get_state')
            return {'requests': len(self.child.events('production_request')),
                    'takes': len(ProductionAdapter.results(self.child, 'session_take')),
                    'notices': sum(event['data'].get('customType') == 'session-communication-wake'
                                   for event in self.child.events('production_message'))}
        if op == 'received':
            marker = command['marker']
            self.child.wait(lambda: any(marker in json.dumps(item) for item in
                            ProductionAdapter.results(self.child, 'session_take')), 'actual production take')
            self.child.wait(lambda: any(
                message.get('role') == 'toolResult' and message.get('toolName') == 'session_take'
                and marker in json.dumps(message)
                for event in self.child.events('production_request')
                for message in event['data']['messages']), 'offline model observed take result')
            matches = [message for item in ProductionAdapter.results(self.child, 'session_take')
                       for message in item['details']['value']['messages'] if marker in json.dumps(message)]
            assert matches
            self.child.wait(lambda: not self.child.rpc('get_state')['isStreaming'], 'receiver idle')
            return {'messages': matches, 'recorderObserved': True}
        if op == 'reload':
            self.child.rpc('prompt', message='/spike-reload')
            self.child.wait(lambda: len(self.child.events('session_start')) >= 2, 'adapter reload')
            return {}
        if op == 'restart_gateway':
            self.stop_gateway()
            self.start_gateway()
            self.child.rpc('prompt', message='/session-communication reconnect')
            return {}
        if op == 'close':
            self.close()
            return {}
        raise AssertionError('unknown endpoint command')

    def close(self):
        try:
            if self.child is not None:
                self.child.close()
                self.child = None
        finally:
            try:
                self.stop_gateway()
            finally:
                shutil.rmtree(self.directory, ignore_errors=True)


def main():
    endpoint = Endpoint()
    try:
        # EOF also tears down every owned process, including on SSH disconnect.
        for line in sys.stdin:
            command = json.loads(line)
            try:
                result = {'ok': True, 'value': endpoint.dispatch(command)}
            except Exception as error:
                # Do not echo commands, credentials, prompts, or captured process output.
                result = {'ok': False, 'error': type(error).__name__, 'operation': command.get('op')}
                if isinstance(error, RuntimeError):
                    result['gatewayError'] = str(error)
                if isinstance(error, subprocess.CalledProcessError):
                    result['processError'] = error.stderr.decode(errors='replace')[-1000:]
            print(json.dumps(result), flush=True)
            if command.get('op') == 'close':
                break
    finally:
        endpoint.close()


if __name__ == '__main__':
    main()
