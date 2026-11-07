"""Real pinned CLI journeys; standard library only, no providers or profile access."""
import json
import os
import hashlib
import re
from pathlib import Path
import pty
import select
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest

HERE = Path(__file__).resolve().parent
PACKAGE = Path(os.environ.get('PI_SPIKE_PACKAGE', str(HERE.parents[3] / 'node_modules/@earendil-works/pi-coding-agent')))
EXTENSION = Path(os.environ.get('PI_SPIKE_EXTENSION', str(HERE / 'extension.ts')))
EVIDENCE = []


class Journey:
    def __init__(self, tui=False, label="journey", setup=None, extension=None):
        # Never inherit a caller's project-local TMPDIR or its ancestor resources.
        self.directory = Path(tempfile.mkdtemp(prefix='pi-admission-spike-', dir='/tmp')).resolve()
        self.log = self.directory / 'events.jsonl'
        self.socket = self.directory / 'control.sock'
        self.records = []
        self.output = bytearray()
        self.errors = bytearray()
        self.tui = tui
        self.closed = False
        self.label = label
        self.lock = threading.Lock()
        for name in ['home', 'agent', 'cwd', 'sessions']:
            (self.directory / name).mkdir()
        (self.directory / 'agent/settings.json').write_text(json.dumps({
            'packages': [], 'extensions': [], 'skills': [], 'promptTemplates': [],
            'defaultProvider': 'spike', 'defaultModel': 'recorder',
            'compaction': {'enabled': True, 'keepRecentTokens': 32, 'reserveTokens': 1024},
            'retry': {'enabled': True, 'maxRetries': 1, 'baseDelayMs': 10},
            'defaultProjectTrust': 'never', 'quietStartup': True,
        }))
        if setup is not None:
            setup(self.directory)
        env = {
            'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
            'HOME': str(self.directory / 'home'),
            'XDG_CONFIG_HOME': str(self.directory / 'home/config'),
            'PI_CODING_AGENT_DIR': str(self.directory / 'agent'),
            'PI_CODING_AGENT_SESSION_DIR': str(self.directory / 'sessions'),
            'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0',
            'PI_SPIKE_SOCKET': str(self.socket), 'PI_SPIKE_LOG': str(self.log),
            'TERM': 'xterm-256color', 'RAYON_NUM_THREADS': '2',
            'UV_THREADPOOL_SIZE': '2', 'GOMAXPROCS': '2',
        }
        args = [shutil.which('node'), str(PACKAGE / 'dist/cli.js'),
                '--no-session', '--no-skills', '--no-prompt-templates',
                '--no-extensions', '--no-context-files', '--no-approve',
                '--no-builtin-tools', '--provider', 'spike', '--model', 'recorder',
                '-e', str(extension or EXTENSION)]
        self.master = None
        if tui:
            master, slave = pty.openpty()
            self.master = master
            self.process = subprocess.Popen(args, cwd=self.directory / 'cwd', env=env,
                                            stdin=slave, stdout=slave, stderr=slave)
            os.close(slave)
            self.reader = threading.Thread(target=self.drain_tui, daemon=True)
        else:
            args += ['--mode', 'rpc']
            self.process = subprocess.Popen(args, cwd=self.directory / 'cwd', env=env,
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE)
            self.reader = threading.Thread(target=self.drain_rpc, daemon=True)
            self.error_reader = threading.Thread(target=self.drain_errors, daemon=True)
            self.error_reader.start()
        self.reader.start()
        try:
            self.wait(lambda: self.socket.exists(), 'socket startup')
            self.control('state')
        except BaseException:
            self.close()
            raise

    def drain_tui(self):
        try:
            while True:
                chunk = os.read(self.master, 65536)
                if not chunk:
                    return
                self.output.extend(chunk)
        except OSError:
            return

    def drain_rpc(self):
        while True:
            line = self.process.stdout.readline()
            if not line:
                return
            self.output.extend(line)
            with self.lock:
                self.records.append(json.loads(line))

    def drain_errors(self):
        self.errors.extend(self.process.stderr.read())

    def events(self, kind=None):
        if not self.log.exists():
            return []
        lines = self.log.read_text().split('\n')
        records = [json.loads(line) for line in lines[:-1] if line]
        return [event for event in records if kind is None or event['type'] == kind]

    def wait(self, predicate, description, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            if self.process.poll() is not None:
                raise AssertionError(f'CLI exited {self.process.returncode}: {self.output[-4000:]!r} {self.errors[-2000:]!r}')
            time.sleep(0.01)
        raise AssertionError(f'Timed out: {description}; events={self.events()[-8:]}; output={self.output[-2500:]!r}')

    def control(self, op, **fields):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(5)
            client.connect(str(self.socket))
            client.sendall((json.dumps({'op': op, **fields}) + '\n').encode())
            result = b''
            while not result.endswith(b'\n'):
                chunk = client.recv(65536)
                if not chunk:
                    raise AssertionError('Control socket closed without result')
                result += chunk
            return json.loads(result)

    def begin_rpc(self, kind, **fields):
        identity = f'cmd-{len(self.records)}-{time.monotonic_ns()}'
        self.process.stdin.write((json.dumps({'type': kind, 'id': identity, **fields}) + '\n').encode())
        self.process.stdin.flush()
        return identity

    def rpc_result(self, identity, allow_failure=False):
        self.wait(lambda: any(record.get('id') == identity for record in self.records), identity)
        record = next(record for record in self.records if record.get('id') == identity)
        if not allow_failure:
            assert record['success'], record
        return record if allow_failure else record.get('data')

    def rpc(self, kind, allow_failure=False, **fields):
        return self.rpc_result(self.begin_rpc(kind, **fields), allow_failure)

    def settled(self, previous):
        self.wait(lambda: len(self.events('settled_last')) > previous, 'settled')

    def push(self, identity):
        return self.control('push', id=identity, content=f'PEER: {identity}')

    def request_count(self):
        return len(self.events('request'))

    def request_contains(self, text):
        return any(text in json.dumps(event['data']['messages']) for event in self.events('request'))

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.process.poll() is None:
                # Startup may fail before the fixture creates its control socket.
                # Releasing a held recorder is best-effort; reaping the CLI is not.
                try:
                    self.control('release')
                except (OSError, ValueError, AssertionError):
                    pass
                if self.tui:
                    self.process.terminate()
                else:
                    self.process.stdin.close()
                try:
                    self.process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
                    raise AssertionError('CLI required forced kill')
            self.reader.join(timeout=3)
            if not self.tui:
                self.error_reader.join(timeout=3)
                self.process.stdout.close()
                self.process.stderr.close()
            else:
                os.close(self.master)
            assert self.process.returncode == 0, f'CLI failed shutdown: {self.process.returncode}'
            assert self.events('session_shutdown')[-1]['data']['reason'] == 'quit'
            assert not self.reader.is_alive(), 'Output reader leaked'
            EVIDENCE.append({'test': self.label, 'mode': 'tui' if self.tui else 'rpc',
                             'events': self.events(), 'exit': self.process.returncode})
        finally:
            shutil.rmtree(self.directory)


class PublicLifecycle(unittest.TestCase):
    def setUp(self):
        self.children = []

    def tearDown(self):
        for child in reversed(self.children):
            child.close()

    def start(self, tui=False):
        child = Journey(tui, self._testMethodName)
        self.children.append(child)
        return child

    def test_rpc_admission_lifecycle(self):
        j = self.start()
        before = len(j.events('settled_last'))
        self.assertEqual(j.push('idle')['tag'], 'admitted')
        j.settled(before)
        self.assertTrue(j.request_contains('PEER: idle'))
        self.assertEqual(j.control('state')['outstanding'], [])
        self.assertEqual(j.events('submitted')[0]['data']['returnType'], 'undefined')
        count = j.request_count()
        self.assertEqual(j.push('idle')['tag'], 'duplicate_admitted')
        self.assertEqual(j.control('push', id='idle', content='changed')['tag'], 'id_conflict')
        j.rpc('get_state')
        j.rpc('get_messages')
        self.assertEqual(j.request_count(), count, 'state and duplicates must not wake')

        j.control('mode', mode='hold')
        j.rpc('prompt', message='busy baseline')
        j.wait(lambda: j.request_count() > count, 'held request')
        self.assertEqual(j.push('busy')['tag'], 'admitted')
        self.assertIn('busy', j.control('state')['outstanding'])
        self.assertFalse(j.control('state')['pending'], 'public pending misses custom native queue')
        before = len(j.events('settled_last'))
        j.control('mode', mode='success')
        j.control('release')
        j.settled(before)
        self.assertTrue(j.request_contains('PEER: busy'))

        # Context hooks may remove an observed custom message before the offline model sees it.
        j.control('mode', mode='success', filter=True)
        before = len(j.events('settled_last'))
        j.push('filtered')
        j.settled(before)
        self.assertTrue(any(event['data']['id'] == 'filtered' for event in j.events('host_observed')))
        self.assertFalse(j.request_contains('PEER: filtered'))
        j.control('mode', mode='success')

        # Retry creates two low-level endings but one final settled boundary.
        j.control('mode', mode='retry-once')
        before = len(j.events('settled_last'))
        ends = len(j.events('agent_end'))
        j.push('retry')
        j.settled(before)
        self.assertGreaterEqual(len(j.events('agent_end')) - ends, 2)
        self.assertTrue(any(record['type'] == 'auto_retry_start' for record in j.records))
        j.control('mode', mode='error')
        before = len(j.events('settled_last'))
        j.push('error')
        j.settled(before)
        self.assertEqual(j.control('state')['outstanding'], [])

        j.control('mode', mode='success')
        j.control('mode', mode='overflow-once')
        before = len(j.events('settled_last'))
        j.push('overflow')
        j.settled(before)
        self.assertTrue(any(event['data']['reason'] == 'overflow' for event in j.events('before_compact')))
        self.assertTrue(any(event['data']['reason'] == 'overflow' for event in j.events('compacted')))
        # Add fresh eligible context after overflow before testing manual compaction.
        before = len(j.events('settled_last'))
        j.rpc('prompt', message='fresh context ' * 100)
        j.settled(before)
        j.rpc('compact')
        self.assertTrue(any(event['data']['reason'] == 'manual' for event in j.events('compacted')))

        # The default compactor must surface an offline model failure truthfully.
        before = len(j.events('settled_last'))
        j.rpc('prompt', message='eligible failure context ' * 100)
        j.settled(before)
        j.control('mode', mode='compact-fail')
        result = j.rpc('compact', allow_failure=True)
        self.assertFalse(result['success'])
        self.assertTrue(j.events('compact_failed'))
        j.control('mode', mode='success')

        # Work requested in settled is deferred until all settled handlers finish.
        j.control('settle-push')
        before = len(j.events('settled_last'))
        j.push('boundary')
        j.wait(lambda: len(j.events('settled_last')) >= before + 2, 'deferred settled push')
        events = j.events()
        submission = next(index for index, event in enumerate(events)
                          if event['type'] == 'submitted' and event['data']['id'] == 'settled-push')
        self.assertEqual(events[submission + 1]['type'], 'settled_last')
        self.assertEqual(events[submission + 2]['type'], 'agent_start')

        old = j.control('state')['nonce']
        j.rpc('prompt', message='/spike-reload')
        j.wait(lambda: len(j.events('session_start')) >= 2, 'reload replacement')
        self.assertNotEqual(j.control('state')['nonce'], old)
        self.assertEqual(j.control('state')['receipts'], 0)
        self.assertEqual(j.events('session_shutdown')[-1]['data']['reason'], 'reload')
        old = j.control('state')['nonce']
        j.rpc('new_session')
        self.assertNotEqual(j.control('state')['nonce'], old)
        self.assertEqual(j.events('session_start')[-1]['data']['reason'], 'new')

    def test_coalesced_wake_explicit_inbox_take(self):
        j = self.start()
        j.control('inbox-delivery')
        j.control('mode', mode='hold')
        j.rpc('prompt', message='hold before inbox admissions')
        j.wait(lambda: j.request_count() == 1, 'inbox baseline')
        for identity in ['inbox-a', 'inbox-b', 'inbox-c', 'inbox-d']:
            self.assertEqual(j.push(identity)['tag'], 'admitted')
        self.assertEqual(len(j.events('notice_submitted')), 0, 'busy pushes never enter native queue')
        self.assertEqual(j.push('inbox-e')['tag'], 'overloaded')
        self.assertEqual(j.push('inbox-a')['tag'], 'duplicate_admitted')
        # Public RPC Escape sequence clears notice, not adapter-owned inbox bodies.
        j.rpc('clear_queue')
        before = len(j.events('settled_last'))
        j.control('mode', mode='success')
        j.rpc('abort')
        j.settled(before)
        self.assertEqual(len(j.control('state')['outstanding']), 4)
        self.assertFalse(j.events('inbox_taken'))
        # Explicit take is available on a later deliberate human turn; no background replay.
        before = len(j.events('settled_last'))
        j.rpc('prompt', message='deliberately retrieve inbox')
        j.settled(before)
        self.assertEqual(j.events('inbox_taken')[0]['data']['messages'][0]['id'], 'inbox-a')
        self.assertEqual(j.control('state')['outstanding'], [])
        before = len(j.events('settled_last'))
        self.assertEqual(j.push('future-authorized')['tag'], 'admitted')
        j.settled(before)
        self.assertEqual(len(j.events('inbox_taken')), 2)
        self.assertEqual(j.push('inbox-a')['tag'], 'duplicate_admitted')

    def test_inbox_busy_boundary_and_native_escape(self):
        j = self.start(tui=True)
        j.control('inbox-delivery')
        j.control('mode', mode='hold')
        os.write(j.master, b'held inbox baseline\r')
        j.wait(lambda: j.request_count() == 1, 'inbox held request')
        j.push('before-inbox-escape')
        before = len(j.events('settled_last'))
        os.write(j.master, b'\x1b')
        j.wait(lambda: bool(j.events('abort_seen')), 'inbox native abort')
        j.push('during-inbox-abort')
        j.control('mode', mode='success')
        j.settled(before)
        self.assertFalse(j.events('notice_submitted'))
        self.assertFalse(j.events('notice_boundary'))
        self.assertFalse(j.events('inbox_taken'))
        self.assertEqual(len(j.control('state')['outstanding']), 2)
        count = j.request_count()
        self.assertEqual(j.push('before-inbox-escape')['tag'], 'duplicate_admitted')
        self.assertEqual(j.request_count(), count)
        before = len(j.events('settled_last'))
        j.push('fresh-inbox-push')
        j.settled(before)
        self.assertEqual(len(j.events('notice_submitted')), 1)
        self.assertEqual(len(j.events('inbox_taken')[0]['data']['messages']), 3)
        self.assertEqual(j.control('state')['outstanding'], [])

        # Busy normal arrival uses an actionable public boundary, not native steer.
        j.control('mode', mode='hold')
        count = j.request_count()
        os.write(j.master, b'held normal inbox baseline\r')
        j.wait(lambda: j.request_count() > count, 'inbox normal baseline')
        for identity in ['busy-inbox-a', 'busy-inbox-b']:
            j.push(identity)
        before = len(j.events('settled_last'))
        j.control('mode', mode='success')
        j.control('release')
        j.settled(before)
        self.assertEqual(len(j.events('notice_submitted')), 1)
        self.assertEqual(len(j.events('notice_boundary')), 1)
        self.assertEqual(len(j.events('inbox_taken')), 2)
        self.assertEqual(j.control('state')['outstanding'], [])

    def test_repeated_inbox_abort_take_cycles_bound_notices(self):
        j = self.start(tui=True)
        j.control('inbox-delivery')
        for cycle in range(8):
            j.control('mode', mode='hold')
            count = j.request_count()
            before = len(j.events('settled_last'))
            # The sole native notice starts from idle and is host-observed before model hold.
            self.assertEqual(j.push(f'cycle-{cycle}-idle')['tag'], 'admitted')
            j.wait(lambda: j.request_count() > count, 'cycle idle notice request')
            self.assertNotIn('idleNoticeInFlight', j.control('state'))
            self.assertEqual(j.push(f'cycle-{cycle}-busy')['tag'], 'admitted')
            aborted = len(j.events('abort_seen'))
            os.write(j.master, b'\x1b')
            j.wait(lambda: len(j.events('abort_seen')) > aborted, 'cycle abort window')
            self.assertEqual(j.push(f'cycle-{cycle}-during')['tag'], 'admitted')
            j.control('mode', mode='success')
            j.settled(before)
            self.assertEqual(len(j.control('state')['outstanding']), 3)
            self.assertEqual(len(j.events('notice_submitted')), cycle * 2 + 1)
            self.assertEqual(len(j.events('notice_observed')), cycle * 2 + 1)
            self.assertFalse(j.events('notice_boundary'), 'abort must not reissue old wake intents')
            count = j.request_count()
            self.assertEqual(j.push(f'cycle-{cycle}-during')['tag'], 'duplicate_admitted')
            j.control('state')
            self.assertEqual(j.request_count(), count)
            before = len(j.events('settled_last'))
            self.assertEqual(j.push(f'cycle-{cycle}-fresh')['tag'], 'admitted')
            j.settled(before)
            self.assertEqual(j.control('state')['outstanding'], [])
            self.assertEqual(len(j.events('inbox_taken')), cycle + 1)
            self.assertEqual(len(j.events('inbox_taken')[-1]['data']['messages']), 4)
            self.assertEqual(len(j.events('notice_submitted')), (cycle + 1) * 2)
            self.assertEqual(len(j.events('notice_observed')), (cycle + 1) * 2)
        # Payload take never resets or manufactures notice accounting.
        active = 0
        maximum = 0
        for event in j.events():
            if event['type'] == 'notice_submitted':
                active += 1
                maximum = max(maximum, active)
            elif event['type'] == 'notice_observed':
                active -= 1
            self.assertGreaterEqual(active, 0)
        self.assertEqual(maximum, 1)
        self.assertEqual(active, 0)

    def test_settled_arrivals_share_one_deferred_idle_notice(self):
        j = self.start()
        j.control('inbox-delivery')
        j.control('hold-settled')
        j.rpc('prompt', message='reach settled handler gate')
        j.wait(lambda: bool(j.events('settled_gate')), 'settled handler gate')
        before = len(j.events('settled_last'))
        for identity in ['settle-a', 'settle-b', 'settle-c']:
            self.assertEqual(j.push(identity)['tag'], 'admitted')
        self.assertEqual(len(j.events('notice_submitted')), 1)
        self.assertFalse(j.events('notice_observed'), 'deferred notice waits for all settled hooks')
        self.assertIn('idleNoticeInFlight', j.control('state'))
        j.control('release')
        j.wait(lambda: len(j.events('settled_last')) >= before + 2, 'deferred notice and final settle')
        self.assertEqual(len(j.events('notice_observed')), 1)
        self.assertEqual(len(j.events('inbox_taken')), 1)
        self.assertEqual(j.control('state')['outstanding'], [])
        events = j.events()
        observation = next(index for index, event in enumerate(events) if event['type'] == 'notice_observed')
        first_settled = next(index for index, event in enumerate(events) if event['type'] == 'settled_last')
        self.assertGreater(observation, first_settled)

    def test_inbox_push_during_manual_compaction_and_failure(self):
        j = self.start()
        j.control('inbox-delivery')
        before = len(j.events('settled_last'))
        j.rpc('prompt', message='eligible manual compaction baseline ' * 100)
        j.settled(before)
        for span in range(4):
            before = len(j.events('settled_last'))
            j.rpc('prompt', message=f'eligible span {span} for a compaction cut')
            j.settled(before)
        j.control('mode', mode='compact-hold')
        identity = j.begin_rpc('compact')
        j.wait(lambda: len(j.events('compact_gate')) == 1, 'manual compact gate')
        self.assertFalse(j.control('state')['idle'])
        j.push('during-manual-compact')
        self.assertFalse(j.events('notice_submitted'))
        before = len(j.events('settled_last'))
        j.control('mode', mode='success')
        j.control('release')
        j.rpc_result(identity)
        j.settled(before)
        self.assertFalse(j.events('compacted')[-1]['data']['idle'])
        self.assertEqual(j.control('state')['outstanding'], [])
        self.assertEqual(len(j.events('notice_submitted')), 1)
        self.assertEqual(len(j.events('notice_observed')), 1)
        self.assertEqual(len(j.events('inbox_taken')), 1)

        before = len(j.events('settled_last'))
        j.rpc('prompt', message='eligible failing compaction baseline ' * 100)
        j.settled(before)
        for span in range(4):
            before = len(j.events('settled_last'))
            j.rpc('prompt', message=f'eligible span {span} for a compaction cut')
            j.settled(before)
        j.control('mode', mode='compact-hold')
        identity = j.begin_rpc('compact')
        j.wait(lambda: len(j.events('compact_gate')) == 2, 'failing compact gate')
        j.push('during-failing-compact')
        before = len(j.events('settled_last'))
        j.control('mode', mode='compact-fail')
        j.control('release')
        result = j.rpc_result(identity, allow_failure=True)
        self.assertFalse(result['success'])
        j.settled(before)
        self.assertTrue(j.events('compact_failed'))
        self.assertEqual(len(j.events('notice_submitted')), 2)
        self.assertEqual(len(j.events('notice_observed')), 2)
        self.assertEqual(j.control('state')['outstanding'], ['during-failing-compact'])
        before = len(j.events('settled_last'))
        j.control('mode', mode='success')
        j.push('after-failing-compact')
        j.settled(before)
        self.assertEqual(j.control('state')['outstanding'], [])
        self.assertEqual(len(j.events('inbox_taken')), 2)

    def test_native_escape_and_ambiguous_capacity(self):
        j = self.start(tui=True)
        j.control('mode', mode='hold')
        os.write(j.master, b'held human prompt\r')
        j.wait(lambda: j.request_count() == 1, 'TUI held request')
        self.assertEqual(j.push('before-escape')['tag'], 'admitted')
        before = len(j.events('settled_last'))
        os.write(j.master, b'\x1b')
        j.wait(lambda: bool(j.events('abort_seen')), 'native Escape reached model abort')
        self.assertEqual(j.push('during-abort')['tag'], 'admitted')
        j.control('mode', mode='success')
        j.settled(before)
        self.assertTrue(j.events('settled_first')[before]['data']['aborted'])
        self.assertFalse(j.request_contains('PEER: before-escape'))
        self.assertIn('before-escape', j.control('state')['outstanding'])
        self.assertEqual(j.push('before-escape')['tag'], 'duplicate_admitted')
        before = len(j.events('settled_last'))
        self.assertEqual(j.push('after-abort')['tag'], 'admitted')
        j.settled(before)
        self.assertTrue(j.request_contains('PEER: after-abort'))
        self.assertFalse(j.request_contains('PEER: before-escape'), 'new push must not replay native-cleared text')
        self.assertTrue(j.request_contains('PEER: during-abort'), 'settled cannot prove that native custom queue is empty')
        self.assertNotIn(b'PEER: before-escape', j.output, 'custom queue text must not be restored to editor')

        # Fill all four submitted-unobserved slots, with no timeout-based retirement.
        j.control('mode', mode='hold')
        count = j.request_count()
        os.write(j.master, b'capacity hold\r')
        j.wait(lambda: j.request_count() > count, 'capacity request')
        state = j.control('state')
        missing = 4 - len(state['outstanding'])
        for index in range(missing):
            self.assertEqual(j.push(f'capacity-{index}')['tag'], 'admitted')
        self.assertEqual(len(j.control('state')['outstanding']), 4)
        self.assertEqual(j.push('overflow-capacity')['tag'], 'overloaded')
        self.assertEqual(j.push('before-escape')['tag'], 'duplicate_admitted')
        self.assertEqual(j.control('push', id='byte-excess', content='x' * 4097)['tag'], 'overloaded')
        os.write(j.master, b'\x1b')
        j.control('mode', mode='success')


def evidence_summary(result):
    journeys = []
    for journey in EVIDENCE:
        events = []
        for event in journey['events']:
            if event['type'] in ['control', 'context']:
                continue
            if event['type'] == 'request':
                data = event['data']
                event = {**event, 'data': {
                    'index': data['index'], 'selected': data['selected'],
                    'roles': [message['role'] for message in data['messages']],
                    'peerMarkers': sorted(set(re.findall(r'PEER: [a-z0-9-]+', json.dumps(data['messages'])))),
                }}
            events.append(event)
        journeys.append({**journey, 'events': events})
    return {
        'piVersion': '1.5.0',
        'evidenceKind': 'Derived lifecycle trace; raw system prompts and repeated payloads omitted',
        'testsRun': result.testsRun,
        'success': result.wasSuccessful(),
        'failures': len(result.failures), 'errors': len(result.errors),
        'fixtureSha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in [HERE / 'extension.ts', HERE / 'offline.py']},
        'journeys': journeys,
    }


if __name__ == '__main__':
    assert json.loads((PACKAGE / 'package.json').read_text())['version'] == '1.5.0'
    program = unittest.main(verbosity=2, exit=False)
    destination = os.environ.get('PI_SPIKE_EVIDENCE')
    if destination:
        Path(destination).write_text(json.dumps(evidence_summary(program.result), indent=2) + '\n')
    raise SystemExit(not program.result.wasSuccessful())
