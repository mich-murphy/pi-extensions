"""Actual two-Pi/two-Rust-gateway interop, generated PKI, offline model only.

Local: python3 packages/pi-comms/test/spike/interop.py
Cross-host: add --ssh-host dev-01 --remote-root /tmp/APPROVED_ROOT/source
--ssh-tunnel for an owned narrow loopback tunnel (mTLS remains inside SSH).
Stage interop_endpoint.py at APPROVED_ROOT/interop, outside the immutable source;
node is expected at APPROVED_ROOT/node/bin/node. Without --ssh-tunnel, provide
--connect-address IP:PORT --listen-address IP:PORT and a --transport-label based
on independent direct-network preflight. Neither mode claims deployment.
Only synthetic fixtures/results are written to --evidence; raw Pi logs stay in
private temporary directories and are deleted on shutdown.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
RELATIVE = HERE.relative_to(ROOT)
BINARY = Path('packages/pi-comms/gateway/target/release/pi-gateway')


def run(args, directory):
    subprocess.run(args, cwd=directory, check=True, capture_output=True, timeout=20)


def credentials(directory):
    """Fresh private root, both-role exact DNS leaves, current full numbered CRL."""
    directory.chmod(0o700)
    (directory / 'index').touch()
    (directory / 'serial').write_text('01\n')
    (directory / 'crlnumber').write_text('01\n')
    config = '''[req]
distinguished_name=dn
[dn]
commonName=Synthetic Interop CA
[ca]
default_ca=issuer
[issuer]
dir=.
database=$dir/index
new_certs_dir=$dir
certificate=$dir/root.pem
private_key=$dir/root.key
serial=$dir/serial
crlnumber=$dir/crlnumber
default_md=sha256
default_days=2
default_crl_days=1
policy=policy
crl_extensions=crl
[policy]
commonName=supplied
[root]
basicConstraints=critical,CA:true
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
[crl]
authorityKeyIdentifier=keyid:always
'''
    (directory / 'ca.cnf').write_text(config)
    run(['openssl', 'req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
         '-subj', '/CN=Synthetic Interop CA', '-keyout', 'root.key', '-out', 'root.pem',
         '-config', 'ca.cnf', '-extensions', 'root'], directory)
    run(['openssl', 'x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der'], directory)
    for machine in ['alpha', 'beta']:
        extension = directory / (machine + '.cnf')
        extension.write_text('[leaf]\nbasicConstraints=critical,CA:false\n'
                             'keyUsage=critical,digitalSignature,keyEncipherment\n'
                             'extendedKeyUsage=serverAuth,clientAuth\n'
                             'subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n'
                             'subjectAltName=DNS:gateway.' + machine + '.pi.internal\n')
        run(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=' + machine,
             '-keyout', machine + '.key', '-out', machine + '.csr'], directory)
        run(['openssl', 'ca', '-batch', '-config', 'ca.cnf', '-in', machine + '.csr',
             '-out', machine + '.pem', '-extensions', 'leaf', '-extfile', machine + '.cnf'], directory)
        run(['openssl', 'x509', '-in', machine + '.pem', '-outform', 'DER', '-out', machine + '.der'], directory)
        run(['openssl', 'pkcs8', '-topk8', '-nocrypt', '-in', machine + '.key', '-outform', 'DER',
             '-out', machine + '-key.der'], directory)
    run(['openssl', 'ca', '-gencrl', '-config', 'ca.cnf', '-out', 'issuer.pem'], directory)
    run(['openssl', 'crl', '-in', 'issuer.pem', '-outform', 'DER', '-out', 'issuer.crl'], directory)
    for path in directory.iterdir():
        if path.is_file():
            path.chmod(0o600)
    return {name: base64.b64encode((directory / name).read_bytes()).decode('ascii')
            for name in ['root.der', 'alpha.der', 'alpha-key.der', 'beta.der', 'beta-key.der', 'issuer.crl']}


SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
               '-o', 'ConnectTimeout=10']


class Tunnel:
    """One foreground SSH process, one loopback -L, no authentication substitution."""
    def __init__(self, host, remote_address):
        self.directory = Path(tempfile.mkdtemp(prefix='psc-interop-tunnel-', dir='/tmp')).resolve()
        self.directory.chmod(0o700)
        self.control = self.directory / 'master.sock'
        self.host = host
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        self.address = '127.0.0.1:' + str(port)
        effective = subprocess.check_output(['ssh', *SSH_OPTIONS, '-G', host], text=True,
                                            stderr=subprocess.DEVNULL, timeout=12)
        assert not any(line.split(' ', 1)[0] in ['localforward', 'remoteforward', 'dynamicforward']
                       for line in effective.splitlines()), 'configured SSH forwards forbidden for isolated tunnel'
        self.log = open(self.directory / 'ssh.stderr', 'wb')
        self.process = subprocess.Popen(
            ['ssh', *SSH_OPTIONS, '-o', 'ExitOnForwardFailure=yes', '-o', 'RequestTTY=no',
             '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-S', str(self.control),
             '-N', '-L', self.address + ':' + remote_address, host],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=self.log)
        try:
            deadline = time.monotonic() + 15
            while not self.control.exists():
                assert self.process.poll() is None, 'SSH tunnel exited before readiness'
                assert time.monotonic() < deadline, 'SSH tunnel readiness deadline'
                time.sleep(0.02)
            subprocess.run(['ssh', *SSH_OPTIONS, '-S', str(self.control), '-O', 'check', host],
                           stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=5)
        except BaseException:
            self.close()
            raise

    def close(self):
        try:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
                    raise AssertionError('SSH tunnel required forced kill')
        finally:
            self.log.close()
            shutil.rmtree(self.directory)


class Controller:
    def __init__(self, host=None, root=ROOT):
        self.directory = Path(tempfile.mkdtemp(prefix='psc-interop-controller-', dir='/tmp')).resolve()
        self.directory.chmod(0o700)
        home = self.directory / 'home'
        home.mkdir(mode=0o700)
        environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(home),
                       'TMPDIR': '/tmp', 'TMP': '/tmp', 'TEMP': '/tmp',
                       'RAYON_NUM_THREADS': '2', 'UV_THREADPOOL_SIZE': '2', 'GOMAXPROCS': '2'}
        script = Path(root) / RELATIVE / 'interop_endpoint.py'
        if host:
            # Fixed executable/path arguments only; messages/fixtures use stdin JSON.
            script = Path(root).parent / 'interop/interop_endpoint.py'
            remote_home = Path(root).parent / 'interop/home'
            command = ('umask 077; mkdir -p ' + shlex.quote(str(remote_home)) + '; exec env -i ' +
                       shlex.quote('PI_INTEROP_SOURCE=' + str(root)) + ' ' +
                       shlex.quote('HOME=' + str(remote_home)) + ' ' +
                       shlex.quote('PATH=' + str(Path(root).parent / 'node/bin') + ':/usr/bin:/bin') +
                       ' TMPDIR=/tmp TMP=/tmp TEMP=/tmp RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 GOMAXPROCS=2' +
                       ' python3 ' + shlex.quote(str(script)))
            args = ['ssh', *SSH_OPTIONS, '-T', '-o', 'ClearAllForwardings=yes', host,
                    'sh -c ' + shlex.quote(command)]
        else:
            args = [sys.executable, str(script)]
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL,
                                        env=None if host else environment)

    def ask(self, op, **fields):
        self.process.stdin.write((json.dumps({'op': op, **fields}) + '\n').encode())
        self.process.stdin.flush()
        ready, _, _ = select.select([self.process.stdout], [], [], 45)
        assert ready, 'endpoint command deadline: ' + op
        line = self.process.stdout.readline()
        assert line, 'endpoint exited during ' + op
        response = json.loads(line)
        assert response['ok'], response
        return response['value']

    def call(self, name, **arguments):
        return self.ask('call', name=name, arguments=arguments)

    def close(self):
        try:
            if self.process.poll() is None:
                self.ask('close')
        finally:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=8)
            self.process.stdout.close()
            shutil.rmtree(self.directory)
        assert self.process.returncode == 0, 'endpoint failed shutdown'


def peers(endpoint):
    return endpoint.call('session_peers', scopeIds=['team'])['peers']


def await_peer(endpoint, machine, excluded=None):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        for descriptor in peers(endpoint):
            peer = descriptor['peer']
            if peer['machineId'] == machine and peer != excluded:
                return peer
        time.sleep(0.05)
    raise AssertionError('real tool discovery deadline: ' + machine)


def received(endpoint, marker, sender, correlation):
    result = endpoint.ask('received', marker=marker)
    delivery = result['messages'][-1]
    assert delivery['provenance']['sender'] == sender, delivery
    assert delivery['provenance']['correlation'] == correlation, delivery
    assert delivery['provenance']['scopeId'] == 'team', delivery
    assert delivery['provenance']['messageId'] == delivery['message']['id'], delivery
    assert result['recorderObserved']
    return delivery


def publication(title, **extra):
    return {'category': 'context', 'title': title, 'summary': title, 'format': 'text',
            'preparation': 'authored', **extra}


def journey(alpha, beta):
    a = await_peer(beta, 'alpha')
    b = await_peer(alpha, 'beta')
    checks = ['bidirectional actual production-tool discovery']
    request = alpha.call('session_send', to=b, scopeId='team', message={
        'kind': 'request', 'format': 'text', 'content': 'SYNTHETIC_INTEROP_REQUEST'})['outcome']
    assert request['tag'] == 'admitted', request
    delivery = received(beta, 'SYNTHETIC_INTEROP_REQUEST', a, 'none')
    message_id = request['binding']['messageId']
    assert delivery['message']['id'] == message_id
    checks.append('request: bound receiver admission AND separate take/model observation')
    reply = beta.call('session_send', to=a, scopeId='team', message={
        'kind': 'reply', 'format': 'text', 'content': 'SYNTHETIC_INTEROP_REPLY',
        'replyTo': {'sender': a, 'messageId': message_id}})['outcome']
    assert reply['tag'] == 'admitted' and reply['correlation'] == 'verified', reply
    received(alpha, 'SYNTHETIC_INTEROP_REPLY', b, 'verified')
    checks.append('reverse reply: verified correlation and authenticated take provenance')
    reverse = beta.call('session_send', to=a, scopeId='team', message={
        'kind': 'request', 'format': 'text', 'content': 'SYNTHETIC_INTEROP_REVERSE_REQUEST'})['outcome']
    assert reverse['tag'] == 'admitted', reverse
    received(alpha, 'SYNTHETIC_INTEROP_REVERSE_REQUEST', b, 'none')
    reverse_reply = alpha.call('session_send', to=b, scopeId='team', message={
        'kind': 'reply', 'format': 'text', 'content': 'SYNTHETIC_INTEROP_REVERSE_REPLY',
        'replyTo': {'sender': b, 'messageId': reverse['binding']['messageId']}})['outcome']
    assert reverse_reply['tag'] == 'admitted' and reverse_reply['correlation'] == 'verified', reverse_reply
    received(beta, 'SYNTHETIC_INTEROP_REVERSE_REPLY', a, 'verified')
    checks.append('both machines originate requests and verified replies; both take/model-observe')

    before_alpha = alpha.ask('stats')
    beta.call('session_state', action='put', scopeId='team', key='context', record=publication('Synthetic context'))
    assert alpha.ask('stats') == before_alpha, 'publication must not wake subscriber'
    before_beta = beta.ask('stats')
    listing = alpha.call('session_state', action='list', publisher=b, scopeId='team')
    assert listing['tag'] == 'ok' and listing['value']['items'][0]['key'] == 'context', listing
    read = alpha.call('session_state', action='get', publisher=b, scopeId='team', key='context')
    assert read['tag'] == 'ok' and read['value']['publication']['title'] == 'Synthetic context', read
    assert beta.ask('stats') == before_beta, 'reads must not wake publisher'
    checks.append('publication and cross-host list/get: no unsolicited peer model wake')
    before_beta = beta.ask('stats')
    alpha.call('session_state', action='put', scopeId='team', key='reverse_context',
               record=publication('Synthetic reverse context'))
    assert beta.ask('stats') == before_beta
    before_alpha = alpha.ask('stats')
    reverse_read = beta.call('session_state', action='get', publisher=a, scopeId='team', key='reverse_context')
    assert reverse_read['tag'] == 'ok'
    assert reverse_read['value']['publication']['title'] == 'Synthetic reverse context'
    assert alpha.ask('stats') == before_alpha
    checks.append('reverse publication/read also no publisher or subscriber wake')

    work = {'kind': 'publication', 'publisher': b, 'key': 'work'}
    record = publication('Synthetic planned work', category='work', work=work, status='planned')
    beta.call('session_state', action='put', scopeId='team', key='work', record=record)
    before_beta = beta.ask('stats')
    interest = alpha.call('session_interest', action='add', publisher=b, scopeId='team', work=work)
    assert interest['tag'] == 'ok' and interest['value']['active'], interest
    assert beta.ask('stats') == before_beta, 'interest must not wake publisher'
    for status, title in [('in_progress', 'SYNTHETIC_INTEROP_PROGRESS'), ('completed', 'SYNTHETIC_INTEROP_TERMINAL')]:
        report = beta.call('session_report', scopeId='team', key='work',
                           record={**record, 'title': title, 'summary': title, 'status': status}, notify='interested')
        assert report['tag'] == 'ok', report
        assert len(report['value']['pushes']) == 1, report
        assert report['value']['pushes'][0]['outcome']['tag'] == 'admitted', report
        assert report['value']['publication']['status'] == status, report
        received(alpha, title, b, 'none')
    before_beta = beta.ask('stats')
    terminal = alpha.call('session_interest', action='add', publisher=b, scopeId='team', work=work)
    assert terminal['tag'] == 'ok' and not terminal['value']['active'], terminal
    assert terminal['value']['current']['status'] == 'completed', terminal
    assert beta.ask('stats') == before_beta
    checks.append('interest add no wake; progress+terminal reports observed; terminal interest inactive')

    beta.ask('restart_gateway')
    same_b = await_peer(alpha, 'beta')
    assert same_b == b, 'gateway restart must preserve surviving Pi identity'
    reconnect = alpha.call('session_send', to=b, scopeId='team', message={
        'kind': 'update', 'format': 'text', 'content': 'SYNTHETIC_INTEROP_RECONNECT'})['outcome']
    assert reconnect['tag'] == 'admitted', reconnect
    received(beta, 'SYNTHETIC_INTEROP_RECONNECT', a, 'none')
    restored = alpha.call('session_state', action='get', publisher=b, scopeId='team', key='work')
    assert restored['tag'] == 'ok' and restored['value']['publication']['status'] == 'completed', restored
    checks.append('controlled gateway restart, reconnect, unchanged adapter identity and retained publication')
    beta.ask('reload')
    replacement = await_peer(alpha, 'beta', excluded=b)
    assert replacement['runtimeNonce'] != b['runtimeNonce']
    before_beta = beta.ask('stats')
    fenced = alpha.call('session_send', to=b, scopeId='team', message={
        'kind': 'update', 'format': 'text', 'content': 'SYNTHETIC_STALE_RUNTIME'})['outcome']
    assert fenced['tag'] == 'not_admitted' and fenced['code'] == 'no_route', fenced
    assert beta.ask('stats') == before_beta, 'stale-runtime rejection must not wake replacement'
    fresh = alpha.call('session_send', to=replacement, scopeId='team', message={
        'kind': 'update', 'format': 'text', 'content': 'SYNTHETIC_NEW_RUNTIME'})['outcome']
    assert fresh['tag'] == 'admitted', fresh
    received(beta, 'SYNTHETIC_NEW_RUNTIME', a, 'none')
    checks.append('Pi reload runtime fencing: old no_route, new runtime admitted/observed')
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh-host')
    parser.add_argument('--remote-root', type=Path)
    parser.add_argument('--ssh-tunnel', action='store_true')
    parser.add_argument('--connect-address')
    parser.add_argument('--listen-address')
    parser.add_argument('--transport-label', default='direct loopback TCP')
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    if args.ssh_host:
        assert args.remote_root
        if args.ssh_tunnel:
            assert not args.connect_address and not args.listen_address
            args.transport_label = 'cross-host gateway TLS 1.3 mTLS inside owned narrow loopback SSH -L; direct reachability NOT established'
        else:
            assert args.connect_address and args.listen_address
            assert args.transport_label != 'direct loopback TCP', 'label real direct network explicitly'
    else:
        assert not args.ssh_tunnel
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        address = '127.0.0.1:' + str(reservation.getsockname()[1])
    alpha = Controller()
    beta = Controller(args.ssh_host, args.remote_root or ROOT)
    tunnel = None
    summary = None
    try:
        if args.ssh_tunnel:
            args.listen_address = beta.ask('address')
            tunnel = Tunnel(args.ssh_host, args.listen_address)
            args.connect_address = tunnel.address
        with tempfile.TemporaryDirectory(prefix='psc-interop-pki-', dir='/tmp') as directory:
            bundle = credentials(Path(directory))
            beta_meta = beta.ask('start', machine='beta', binary=str((args.remote_root or ROOT) / BINARY),
                                 endpoint={'mode': 'listen', 'address': args.listen_address or address}, credentials=bundle)
            alpha_meta = alpha.ask('start', machine='alpha', binary=str(ROOT / BINARY),
                                   endpoint={'mode': 'connect', 'address': args.connect_address or address}, credentials=bundle)
        assert alpha_meta['source']['manifestSha256'] == beta_meta['source']['manifestSha256'], 'endpoint source mismatch'
        assert alpha_meta['fixtureSha256'] == beta_meta['fixtureSha256'], 'endpoint fixture mismatch'
        assert alpha_meta['controllerSha256'] == beta_meta['controllerSha256'], 'endpoint controller mismatch'
        checks = journey(alpha, beta)
        summary = {'success': True, 'transport': args.transport_label, 'alpha': alpha_meta, 'beta': beta_meta,
                   'opensslVersion': subprocess.check_output(['openssl', 'version'], text=True).strip(),
                   'credentialProfile': 'Fresh private CA; gateway.alpha.pi.internal / gateway.beta.pi.internal single DNS SAN; both server/client EKU; full current numbered issuer CRL with AKI; private DER; explicit CLI floor initialization',
                   'checks': checks, 'harnessSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   'boundary': 'Synthetic private PKI/offline recorder only. Admission and recorder observation separately asserted. No provider, production deployment, benchmark or permanent exactly-once claim.'}
    finally:
        try:
            try:
                alpha.close()
            finally:
                beta.close()
        finally:
            if tunnel is not None:
                tunnel.close()
    assert summary is not None
    summary['cleanup'] = 'Both Pi clients and gateways exited0; endpoint workers and owned SSH tunnel terminated; private runtime/PKI directories deleted.'
    if args.evidence:
        args.evidence.write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
