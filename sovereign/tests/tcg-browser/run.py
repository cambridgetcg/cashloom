#!/usr/bin/env python3
"""Offline TCG browser smoke: python3 sovereign/tests/tcg-browser/run.py.

macOS verification runner. Copies exact ui/bun.lock packages from the existing
Bun cache; NEVER installs, modifies dependencies/cache, loads .env, or opens the
operator's wallet. The OS sandbox denies non-loopback networking for builds,
the synthetic Hono server, and Chromium. The browser additionally blocks every
request except the randomly assigned fixture origin. --keep-temp is diagnostic;
remove the printed temporary directory after inspecting its screenshot/logs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SOVEREIGN = HERE.parents[1]
PROFILE = '(version 1)(allow default)(deny network*)(allow network* (local ip "localhost:*") (remote ip "localhost:*"))'


def cache_package(cache, name, version):
    direct = cache / f"{name}@{version}@@@1"
    candidates = [direct]
    scope, leaf = name.rsplit('/', 1) if '/' in name else ('', name)
    root = cache / scope
    if root.is_dir():
        candidates += sorted(p for p in root.iterdir() if p.name.startswith(leaf + '@'))
    for candidate in candidates:
        manifest = candidate / 'package.json'
        if manifest.is_file():
            data = json.loads(manifest.read_text())
            if data.get('name') == name and data.get('version') == version:
                return candidate
    raise RuntimeError(f'Missing cached LOCKED package {name}@{version}; no installation attempted')


def prepare(root, cache):
    workspace = root / 'workspace'
    ui = workspace / 'sovereign' / 'ui'
    ui.mkdir(parents=True)
    # Preserve repo-relative shared-theme imports and its local font paths.
    # The fixture server's established root/ui/dist path stays unchanged.
    (root / 'ui').symlink_to(ui, target_is_directory=True)
    shutil.copytree(SOVEREIGN.parent / 'ui', workspace / 'ui')
    shared_inputs = {str(p.relative_to(workspace / 'ui')): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in (workspace / 'ui').rglob('*') if p.is_file()}
    (root / 'shared-ui-source-sha256.json').write_text(json.dumps(shared_inputs, indent=2))
    # UI imports backend DTOs by type only. Preserve that relative source layout;
    # tsc is --noEmit and the Vite output/cache paths remain in the fixture.
    (ui.parent / 'src').symlink_to(SOVEREIGN / 'src', target_is_directory=True)
    (ui.parent / 'node_modules').symlink_to(SOVEREIGN / 'node_modules', target_is_directory=True)
    for name in ['src', 'public', 'tests', 'index.html', 'package.json', 'bun.lock', 'tsconfig.json', 'vite.config.ts']:
        source = SOVEREIGN / 'ui' / name
        if source.is_dir():
            shutil.copytree(source, ui / name)
        elif source.is_file():
            shutil.copy2(source, ui / name)
    lock = json.loads(re.sub(r',(?=\s*[}\]])', '', (ui / 'bun.lock').read_text()))
    node_modules = ui / 'node_modules'
    node_modules.mkdir()
    versions = {}
    for name, entry in lock['packages'].items():
        metadata = entry[2]
        if metadata.get('os', 'darwin') != 'darwin' or metadata.get('cpu', 'arm64') != 'arm64':
            continue
        version = entry[0].rsplit('@', 1)[1]
        source = cache_package(cache, name, version)
        destination = node_modules / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Copy (not hardlink): build tools cannot mutate operator cache files.
        shutil.copytree(source, destination, symlinks=False, ignore=shutil.ignore_patterns('node_modules', '.cache'))
        versions[name] = version
    (root / 'locked-versions.json').write_text(json.dumps(versions, indent=2))
    inputs = [p for name in ['src', 'public', 'tests'] for p in (ui / name).rglob('*') if p.is_file()]
    inputs += [ui / name for name in ['index.html', 'package.json', 'bun.lock', 'tsconfig.json', 'vite.config.ts'] if (ui / name).is_file()]
    digests = {str(p.relative_to(ui)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(inputs)}
    (root / 'ui-source-sha256.json').write_text(json.dumps(digests, indent=2))
    print(f'Prepared {len(versions)} exact locked packages; no version differences', flush=True)
    return ui


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path.home() / '.bun/install/cache')
    parser.add_argument('--browsers', type=Path, default=Path.home() / 'Library/Caches/ms-playwright')
    parser.add_argument('--keep-temp', action='store_true')
    parser.add_argument('--build-only', action='store_true')
    args = parser.parse_args()
    if os.uname().sysname != 'Darwin' or os.uname().machine != 'arm64':
        raise RuntimeError('This offline fixture currently requires macOS arm64 and sandbox-exec')
    bun, node = shutil.which('bun'), shutil.which('node')
    if not bun or not node or not Path('/usr/bin/sandbox-exec').is_file():
        raise RuntimeError('Installed bun, node, and sandbox-exec required; no installation attempted')
    driver = cache_package(args.cache, 'playwright-core', '1.59.1')
    browser_manifest = json.loads((driver / 'browsers.json').read_text())
    revision = next(b['revision'] for b in browser_manifest['browsers'] if b['name'] == 'chromium-headless-shell')
    chromium = args.browsers / f'chromium_headless_shell-{revision}' / 'chrome-headless-shell-mac-arm64/chrome-headless-shell'
    if not chromium.is_file():
        raise RuntimeError(f'Missing installed Playwright-matched browser {chromium}')
    root = Path(tempfile.mkdtemp(prefix='cashloom-tcg-browser-')).resolve()
    active = None
    def stop(signum, _frame):
        if active and active.poll() is None:
            os.killpg(active.pid, signal.SIGTERM)
        raise KeyboardInterrupt(f'Stopped by signal {signum}')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f'Temporary fixture: {root}', flush=True)
    try:
        for name in ['home', 'data', 'tmp']:
            (root / name).mkdir()
        (root / '.tcg-browser-fixture').write_text('Owned offline synthetic fixture; safe to remove in full.\n')
        ui = prepare(root, args.cache)
        # A second journey exercises the actual node from an isolated source
        # copy, including startup from an unrelated cwd and backup restoration.
        node_repo = root / 'node'
        node_sovereign = node_repo / 'sovereign'
        node_sovereign.mkdir(parents=True)
        shutil.copytree(SOVEREIGN / 'src', node_sovereign / 'src')
        copied_harness = node_sovereign / 'tests' / 'tcg-browser'
        shutil.copytree(HERE, copied_harness, ignore=shutil.ignore_patterns('__pycache__'))
        (node_sovereign / 'node_modules').symlink_to(SOVEREIGN / 'node_modules', target_is_directory=True)
        (node_sovereign / 'ui').symlink_to(ui, target_is_directory=True)
        for name in ['RIGHTS.md', 'rights-adoption.json']:
            shutil.copy2(SOVEREIGN.parent / name, node_repo / name)
        backend_inputs = {str(p.relative_to(node_sovereign / 'src')): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in (node_sovereign / 'src').rglob('*') if p.is_file()}
        harness_inputs = {str(p.relative_to(copied_harness)): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in copied_harness.rglob('*') if p.is_file()}
        env = {
            'HOME': str(root / 'home'), 'CASHLOOM_DATA_DIR': str(root / 'data'),
            'TMPDIR': str(root / 'tmp'), 'PATH': f'{Path(bun).parent}:{Path(node).parent}:/usr/bin:/bin',
            'CI': '1', 'BROWSERSLIST_IGNORE_OLD_DATA': 'true',
            'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1', 'TCG_BROWSER_ROOT': str(root),
            'TCG_BROWSER_BUN': bun, 'TCG_BROWSER_DRIVER': str(driver / 'index.mjs'),
            'TCG_BROWSER_CHROMIUM': str(chromium),
        }
        commands = [
            [bun, '--no-env-file', '--no-install', 'test', 'tests'],
            [node, str(ui / 'node_modules/typescript/bin/tsc'), '--noEmit'],
            [node, str(ui / 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'tcg-smoke'],
        ]
        if not args.build_only:
            commands.append([node, str(copied_harness / 'journeys.mjs')])
            commands.append([node, str(copied_harness / 'agent-access.mjs')])
            commands.append([node, str(copied_harness / 'crypto-watch.mjs')])
            commands.append([node, str(copied_harness / 'browser-wallet.mjs')])
            commands.append([node, str(copied_harness / 'daily-use.mjs')])
            commands.append([node, str(ui / 'tests/browser/money-sources.mjs')])
        for command in commands:
            print('RUN ' + ' '.join(command), flush=True)
            active = subprocess.Popen(['/usr/bin/sandbox-exec', '-p', PROFILE, *command], cwd=ui, env=env, start_new_session=True)
            try:
                status = active.wait(timeout=240)
            except subprocess.TimeoutExpired:
                os.killpg(active.pid, signal.SIGTERM)
                try:
                    active.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(active.pid, signal.SIGKILL)
                    active.wait()
                raise RuntimeError('Harness exceeded 240-second bounded command lifetime')
            if status:
                raise RuntimeError(f'Command failed with exit {status}: {command}')
        inputs = json.loads((root / 'ui-source-sha256.json').read_text())
        current_ui = {str(p.relative_to(SOVEREIGN / 'ui')): hashlib.sha256(p.read_bytes()).hexdigest()
                      for name in ['src', 'public', 'tests'] for p in (SOVEREIGN / 'ui' / name).rglob('*') if p.is_file()}
        for name in ['index.html', 'package.json', 'bun.lock', 'tsconfig.json', 'vite.config.ts']:
            path = SOVEREIGN / 'ui' / name
            if path.is_file():
                current_ui[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        changed = [name for name in inputs.keys() | current_ui.keys() if inputs.get(name) != current_ui.get(name)]
        if changed:
            raise RuntimeError(f'UI source changed during verification; rerun before using this dist: {changed}')
        shared_inputs = json.loads((root / 'shared-ui-source-sha256.json').read_text())
        current_shared = {str(p.relative_to(SOVEREIGN.parent / 'ui')): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in (SOVEREIGN.parent / 'ui').rglob('*') if p.is_file()}
        if shared_inputs != current_shared:
            raise RuntimeError('Shared UI theme changed during verification; rerun')
        current_backend = {str(p.relative_to(SOVEREIGN / 'src')): hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in (SOVEREIGN / 'src').rglob('*') if p.is_file()}
        backend_changed = [name for name in backend_inputs.keys() | current_backend.keys()
                           if backend_inputs.get(name) != current_backend.get(name)]
        if backend_changed:
            raise RuntimeError(f'Node source changed during verification; rerun: {backend_changed}')
        current_harness = {str(p.relative_to(HERE)): hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in HERE.rglob('*') if p.is_file() and '__pycache__' not in p.parts}
        if current_harness != harness_inputs:
            raise RuntimeError('Browser harness changed during verification; rerun')
        built = {str(p.relative_to(ui / 'dist')): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in sorted((ui / 'dist').rglob('*')) if p.is_file()}
        (root / 'ui-build-sha256.json').write_text(json.dumps(built, indent=2))
        print('PASS locked UI tests/typecheck/build' + ('' if args.build_only else ' and loopback browser journeys') + '; source snapshot still current', flush=True)
    finally:
        if active and active.poll() is None:
            os.killpg(active.pid, signal.SIGTERM)
            try:
                active.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(active.pid, signal.SIGKILL)
                active.wait()
        if args.keep_temp:
            print(f'Diagnostic artifacts retained by request: {root}', flush=True)
        else:
            shutil.rmtree(root)
            print('Removed owned temporary fixture', flush=True)


if __name__ == '__main__':
    main()
