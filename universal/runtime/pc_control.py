import base64
import ctypes
import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

from action_store import ActionStore

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'state'
READ_ONLY = {'pc.health', 'window.list', 'window.observe', 'screen.capture', 'file.list',
             'file.read', 'process.list', 'action.outcome'}
MUTATIONS = {'window.activate', 'ui.set_text', 'ui.invoke', 'ui.click', 'ui.keys',
             'ui.scroll', 'process.start', 'shell.run', 'file.write'}


class Rejected(ValueError):
    pass


def clean(value):
    return str(value).encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'replace')


def checked_path(raw):
    if not isinstance(raw, str) or not raw or not Path(raw).is_absolute():
        raise Rejected('ABSOLUTE_PATH_REQUIRED')
    path = Path(raw).resolve()
    normalized = str(path).replace('/', '\\').casefold()
    if normalized == 'e:\\manhwa' or normalized.startswith('e:\\manhwa\\'):
        raise Rejected('PROTECTED_PATH')
    return path


def validate(request):
    if not isinstance(request, dict) or set(request) - {'action', 'params', 'request_id', 'snapshot_id'}:
        raise Rejected('INVALID_REQUEST')
    if request.get('action') not in READ_ONLY | MUTATIONS:
        raise Rejected('UNKNOWN_ACTION')
    if not isinstance(request.get('params', {}), dict):
        raise Rejected('INVALID_PARAMS')
    if request['action'] in MUTATIONS:
        if not isinstance(request.get('request_id'), str) or not re.fullmatch(r'[A-Za-z0-9._-]{8,120}', request['request_id']):
            raise Rejected('STABLE_REQUEST_ID_REQUIRED')


class Windows:
    def __init__(self, state):
        import psutil
        import uiautomation as auto
        import win32gui
        import win32process
        self.psutil, self.auto, self.gui, self.process = psutil, auto, win32gui, win32process
        ctypes.windll.user32.SetProcessDPIAware()
        auto.SetGlobalSearchTimeout(1)
        self.state = Path(state)
        (self.state / 'observations').mkdir(parents=True, exist_ok=True)

    def identity(self, hwnd):
        if isinstance(hwnd, bool) or not isinstance(hwnd, int) or not self.gui.IsWindow(hwnd):
            raise Rejected('WINDOW_NOT_FOUND')
        pid = self.process.GetWindowThreadProcessId(hwnd)[1]
        process = self.psutil.Process(pid)
        return {'hwnd': hwnd, 'pid': pid, 'process_created': process.create_time(),
                'title': clean(self.gui.GetWindowText(hwnd)), 'rect': list(self.gui.GetWindowRect(hwnd))}

    def windows(self):
        result = []
        def collect(hwnd, _):
            try:
                if self.gui.IsWindowVisible(hwnd) and self.gui.GetWindowText(hwnd):
                    result.append(self.identity(hwnd))
            except (OSError, self.psutil.Error):
                pass
        self.gui.EnumWindows(collect, None)
        return {'windows': result[:200], 'foreground_hwnd': self.gui.GetForegroundWindow()}

    def node(self, control, path, index):
        password = bool(control.IsPassword)
        bounds = control.BoundingRectangle
        value = None
        if control.ControlTypeName == 'EditControl' and not password:
            try:
                value = clean(control.GetValuePattern().Value)[:12000]
            except Exception:
                pass
        return {'index': index, 'path': path, 'name': '' if password else clean(control.Name)[:2000],
                'role': control.ControlTypeName, 'class': control.ClassName,
                'automation_id': control.AutomationId, 'password': password,
                'enabled': bool(control.IsEnabled), 'value': value,
                'rect': [bounds.left, bounds.top, bounds.right, bounds.bottom]}

    def collect(self, hwnd, limit=350):
        nodes, stack = [], [(self.auto.ControlFromHandle(hwnd), [])]
        while stack and len(nodes) < limit:
            control, path = stack.pop()
            try:
                node = self.node(control, path, len(nodes))
                nodes.append(node)
                if len(path) < 14 and not node['password']:
                    children = control.GetChildren()
                    stack.extend((child, path + [i]) for i, child in reversed(list(enumerate(children))))
            except Exception:
                continue
        return nodes, bool(stack)

    def observe(self, hwnd):
        before = self.identity(hwnd)
        nodes, truncated = self.collect(hwnd)
        if before != self.identity(hwnd):
            raise Rejected('WINDOW_CHANGED_REOBSERVE')
        snapshot = {'snapshot_id': uuid.uuid4().hex, 'created': time.time(), 'window': before,
                    'nodes': nodes, 'truncated': truncated}
        path = self.state / 'observations' / (snapshot['snapshot_id'] + '.json')
        path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding='utf-8')
        return snapshot

    def bound(self, snapshot_id):
        if not isinstance(snapshot_id, str) or not re.fullmatch('[a-f0-9]{32}', snapshot_id):
            raise Rejected('SNAPSHOT_REQUIRED')
        path = self.state / 'observations' / (snapshot_id + '.json')
        if not path.is_file():
            raise Rejected('SNAPSHOT_NOT_FOUND')
        observed = json.loads(path.read_text(encoding='utf-8'))
        if time.time() - observed['created'] > 120:
            raise Rejected('SNAPSHOT_EXPIRED')
        if observed['window'] != self.identity(observed['window']['hwnd']):
            raise Rejected('WINDOW_CHANGED_REOBSERVE')
        current_nodes, _ = self.collect(observed['window']['hwnd'])
        if current_nodes != observed['nodes']:
            raise Rejected('UI_CHANGED_REOBSERVE')
        return observed

    def target(self, observed, index):
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(observed['nodes']):
            raise Rejected('INVALID_ELEMENT_INDEX')
        old = observed['nodes'][index]
        control = self.auto.ControlFromHandle(observed['window']['hwnd'])
        for position in old['path']:
            children = control.GetChildren()
            if position >= len(children):
                raise Rejected('ELEMENT_CHANGED_REOBSERVE')
            control = children[position]
        if self.node(control, old['path'], index) != old:
            raise Rejected('ELEMENT_CHANGED_REOBSERVE')
        if old['password'] or not old['enabled']:
            raise Rejected('ELEMENT_DISABLED_OR_SENSITIVE')
        return control, old

    def require_foreground(self, hwnd):
        if self.gui.GetForegroundWindow() != hwnd:
            raise Rejected('TARGET_WINDOW_MUST_BE_FOREGROUND')
        focused = self.auto.GetFocusedControl()
        if not focused or focused.IsPassword:
            raise Rejected('FOCUSED_ELEMENT_SENSITIVE_OR_UNAVAILABLE')

    def capture(self, params):
        from PIL import Image, ImageGrab
        import win32ui
        scope = params.get('scope', 'window')
        if scope == 'desktop':
            image = ImageGrab.grab(all_screens=True)
            identity = None
            origin = [ctypes.windll.user32.GetSystemMetrics(76), ctypes.windll.user32.GetSystemMetrics(77)]
        elif scope == 'window':
            identity = self.identity(params.get('hwnd'))
            hwnd = identity['hwnd']
            left, top, right, bottom = identity['rect']
            width, height = right - left, bottom - top
            if self.gui.IsIconic(hwnd) or not 1 <= width <= 10000 or not 1 <= height <= 10000:
                raise Rejected('WINDOW_CAPTURE_UNAVAILABLE')
            dc_handle = self.gui.GetWindowDC(hwnd)
            source = win32ui.CreateDCFromHandle(dc_handle)
            target = source.CreateCompatibleDC()
            bitmap = win32ui.CreateBitmap()
            bitmap.CreateCompatibleBitmap(source, width, height)
            target.SelectObject(bitmap)
            try:
                if not ctypes.windll.user32.PrintWindow(hwnd, target.GetSafeHdc(), 2):
                    raise Rejected('WINDOW_CAPTURE_UNAVAILABLE')
                image = Image.frombuffer('RGB', (width, height), bitmap.GetBitmapBits(True), 'raw', 'BGRX', 0, 1).copy()
            finally:
                self.gui.DeleteObject(bitmap.GetHandle())
                target.DeleteDC()
                source.DeleteDC()
                self.gui.ReleaseDC(hwnd, dc_handle)
            if identity != self.identity(hwnd):
                raise Rejected('WINDOW_CHANGED_RECAPTURE')
            origin = [left, top]
        else:
            raise Rejected('INVALID_CAPTURE_SCOPE')
        original = list(image.size)
        image.thumbnail((2560, 1600))
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        png = buffer.getvalue()
        if len(png) > 7 * 1024 * 1024:
            raise Rejected('IMAGE_TOO_LARGE')
        path = self.state / 'observations' / (uuid.uuid4().hex + '.png')
        path.write_bytes(png)
        result = {'scope': scope, 'window': identity, 'image_path': str(path), 'origin': origin,
                  'original_size': original, 'image_size': list(image.size),
                  'sha256': hashlib.sha256(png).hexdigest(), 'capture_method': 'PrintWindow' if identity else 'ImageGrab'}
        if params.get('return_image', True):
            result['image_base64'] = base64.b64encode(png).decode('ascii')
        return result


class Controller:
    def __init__(self, state=STATE, windows_factory=Windows):
        self.state = Path(state)
        self.state.mkdir(parents=True, exist_ok=True)
        self.store = ActionStore(self.state)
        self.windows_factory, self._windows = windows_factory, None
        self.dispatched = False

    @property
    def windows(self):
        if self._windows is None:
            self._windows = self.windows_factory(self.state)
        return self._windows

    def effect(self, call):
        self.dispatched = True
        return call()

    def execute(self, request):
        validate(request)
        action, p = request['action'], request.get('params', {})
        mutation = action in MUTATIONS
        self.dispatched = False
        if mutation:
            cached = self.store.existing(request)
            if cached:
                return cached
            if (self.state / 'PAUSED').exists():
                raise Rejected('PC_CONTROL_PAUSED_BY_OWNER')
            self.store.start(request)
        try:
            data = self.dispatch(action, p, request)
            result = {'ok': True, 'status': 'completed', 'action': action, 'data': data}
            if mutation:
                result['request_id'] = request['request_id']
                self.store.finish(request['request_id'], 'completed', result)
            return result
        except Exception as error:
            uncertain = mutation and self.dispatched
            result = {'ok': False, 'status': 'needs_reconciliation' if uncertain else 'rejected',
                      'action': action, 'error': str(error)[:1000], 'automatic_replay': False}
            if mutation:
                result['request_id'] = request['request_id']
                self.store.finish(request['request_id'], 'unknown' if uncertain else 'completed', result)
            return result

    def dispatch(self, action, p, request):
        if action == 'pc.health':
            return {'version': '0.4.0', 'computer': os.environ.get('COMPUTERNAME', 'Windows'),
                    'paused': (self.state / 'PAUSED').exists(), 'actions': sorted(READ_ONLY | MUTATIONS),
                    'transport': 'local_worker', 'secrets_required_for_local_actions': False}
        if action == 'action.outcome':
            target = p.get('request_id')
            if not isinstance(target, str) or not re.fullmatch(r'[A-Za-z0-9._-]{8,120}', target):
                raise Rejected('INVALID_REQUEST_ID')
            return self.store.lookup(target)
        if action == 'window.list':
            return self.windows.windows()
        if action == 'window.observe':
            return self.windows.observe(p.get('hwnd'))
        if action == 'screen.capture':
            return self.windows.capture(p)
        if action.startswith('ui.') or action == 'window.activate':
            observed = self.windows.bound(request.get('snapshot_id'))
            hwnd = observed['window']['hwnd']
            if action == 'window.activate':
                def activate():
                    self.windows.gui.ShowWindow(hwnd, 9)
                    self.windows.gui.SetForegroundWindow(hwnd)
                    self.windows.require_foreground(hwnd)
                    return {'hwnd': hwnd}
                return self.effect(activate)
            if action in {'ui.set_text', 'ui.invoke'}:
                control, node = self.windows.target(observed, p.get('index'))
                if action == 'ui.set_text':
                    text = p.get('text')
                    if not isinstance(text, str) or len(text.encode('utf-16-le')) > 24000:
                        raise Rejected('INVALID_TEXT')
                    if node['value'] and not p.get('replace_existing', False):
                        raise Rejected('EXISTING_TEXT_REQUIRES_REPLACE_EXISTING')
                    pattern = control.GetValuePattern()
                    if not pattern or pattern.IsReadOnly:
                        raise Rejected('EDITABLE_VALUE_PATTERN_REQUIRED')
                    self.effect(lambda: pattern.SetValue(text))
                    if clean(pattern.Value) != text:
                        raise RuntimeError('TEXT_VERIFICATION_FAILED')
                    return {'hwnd': hwnd, 'index': node['index'], 'text_verified': True}
                try:
                    pattern = control.GetInvokePattern()
                except Exception:
                    pattern = None
                if pattern:
                    self.effect(pattern.Invoke)
                else:
                    legacy = control.GetLegacyIAccessiblePattern()
                    if not legacy or not legacy.DefaultAction:
                        raise Rejected('INVOKABLE_ELEMENT_REQUIRED')
                    self.effect(legacy.DoDefaultAction)
                return {'hwnd': hwnd, 'index': node['index'], 'invoked': True, 'application_effect_requires_observation': True}
            self.windows.require_foreground(hwnd)
            import pyautogui
            pyautogui.FAILSAFE = True
            if action == 'ui.click':
                x, y = p.get('x'), p.get('y')
                left, top, right, bottom = observed['window']['rect']
                if any(isinstance(v, bool) or not isinstance(v, int) for v in (x, y)) or not left <= x < right or not top <= y < bottom:
                    raise Rejected('POINT_OUTSIDE_OBSERVED_WINDOW')
                button = p.get('button', 'left')
                if button not in {'left', 'right', 'middle'}:
                    raise Rejected('INVALID_MOUSE_BUTTON')
                self.effect(lambda: pyautogui.click(x, y, button=button))
            elif action == 'ui.keys':
                keys = p.get('keys')
                if not isinstance(keys, list) or not 1 <= len(keys) <= 4 or any(k not in pyautogui.KEYBOARD_KEYS for k in keys):
                    raise Rejected('INVALID_KEYS')
                self.effect(lambda: pyautogui.hotkey(*keys))
            elif action == 'ui.scroll':
                amount = p.get('clicks')
                if isinstance(amount, bool) or not isinstance(amount, int) or not -12 <= amount <= 12 or amount == 0:
                    raise Rejected('INVALID_SCROLL')
                # Scroll only at a freshly verified point in the intended window.
                x, y = pyautogui.position()
                left, top, right, bottom = observed['window']['rect']
                if not left <= x < right or not top <= y < bottom:
                    raise Rejected('POINTER_OUTSIDE_TARGET_WINDOW')
                self.effect(lambda: pyautogui.scroll(amount))
            return {'hwnd': hwnd, 'input_dispatched': True, 'requires_observation': True}
        if action == 'file.list':
            path = checked_path(p.get('path'))
            entries = []
            for item in path.iterdir():
                if len(entries) >= 200:
                    break
                # Never descend into or stat a protected child.
                try:
                    safe = checked_path(str(item))
                    entries.append({'name': item.name, 'directory': safe.is_dir()})
                except Rejected:
                    continue
            return {'path': str(path), 'entries': entries, 'limit': 200}
        if action == 'file.read':
            path = checked_path(p.get('path'))
            if path.stat().st_size > 65536:
                raise Rejected('FILE_TOO_LARGE_USE_BOUNDED_SHELL_READ')
            raw = path.read_bytes()
            return {'path': str(path), 'text': raw.decode('utf-8-sig'), 'sha256': hashlib.sha256(raw).hexdigest()}
        if action == 'file.write':
            path = checked_path(p.get('path'))
            text = p.get('text')
            if not isinstance(text, str) or len(text.encode('utf-8')) > 65536:
                raise Rejected('INVALID_TEXT')
            if path.exists():
                if path.stat().st_size > 65536 or hashlib.sha256(path.read_bytes()).hexdigest() != p.get('expected_sha256'):
                    raise Rejected('CURRENT_FILE_HASH_REQUIRED')
            elif p.get('expected_sha256'):
                raise Rejected('FILE_DISAPPEARED')
            mode = p.get('mode', 'replace')
            if mode not in {'replace', 'append'}:
                raise Rejected('INVALID_WRITE_MODE')
            raw = text.encode('utf-8')
            def write():
                with path.open('ab' if mode == 'append' else 'wb') as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                return {'path': str(path), 'bytes_written': len(raw), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            return self.effect(write)
        if action == 'process.list':
            import psutil
            processes = []
            for process in psutil.process_iter(['pid', 'name', 'create_time']):
                try:
                    processes.append(process.info)
                except psutil.Error:
                    continue
            return {'processes': processes[:300]}
        if action == 'process.start':
            import psutil
            executable = checked_path(p.get('executable'))
            args = p.get('args', [])
            if executable.suffix.lower() != '.exe' or not executable.is_file() or not isinstance(args, list) or len(args) > 80 or any(not isinstance(a, str) for a in args):
                raise Rejected('EXECUTABLE_AND_ARGUMENT_ARRAY_REQUIRED')
            for arg in args:
                if 'e:\\manhwa' in arg.replace('/', '\\').casefold():
                    raise Rejected('PROTECTED_PATH')
            cwd = checked_path(p['cwd']) if p.get('cwd') else executable.parent
            process = self.effect(lambda: subprocess.Popen([str(executable), *args], cwd=cwd,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  creationflags=subprocess.CREATE_NO_WINDOW if p.get('hidden', True) else 0))
            return {'pid': process.pid, 'created': psutil.Process(process.pid).create_time(), 'executable': str(executable)}
        if action == 'shell.run':
            sys.path.insert(0, r'E:\pc-github-relay\src')
            from pc_executor.executor import Executor
            from pc_executor.models import ActionRequest
            from pc_executor.outcome_journal import OutcomeJournal
            from pc_executor.shell import SafeShellAdapter
            from pc_executor.safety import DEFAULT_SAFE_EXECUTABLES
            timeout = p.get('timeout_seconds', 20)
            if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 25:
                raise Rejected('TIMEOUT_MUST_BE_1_TO_25_SECONDS')
            argv = p.get('argv')
            if not isinstance(argv, list) or not argv or any(not isinstance(a, str) for a in argv):
                raise Rejected('ARGV_ARRAY_REQUIRED')
            shell = SafeShellAdapter(allow_executables=set(DEFAULT_SAFE_EXECUTABLES) | {'powershell.exe', 'pwsh.exe', 'cmd.exe', 'node.exe'}, timeout_seconds=timeout)
            shell.validate(argv, cwd=p.get('cwd'))
            executor = Executor(shell=shell, outcome_journal=OutcomeJournal(str(self.state / 'executor-outcomes.jsonl')), dry_run=False, operation_timeout_seconds=timeout)
            result = self.effect(lambda: executor.execute(ActionRequest(action='shell.run', params={'argv': argv, 'cwd': p.get('cwd')}, request_id=request['request_id'], dry_run=False, timeout_ms=timeout * 1000))).to_dict()
            if not result['ok']:
                raise RuntimeError('EXECUTOR_' + str(result.get('error_kind')) + ': ' + str(result.get('error')))
            data = result['data']
            for key in ('stdout', 'stderr'):
                if isinstance(data.get(key), str) and len(data[key]) > 24000:
                    data[key] = data[key][:24000]
                    data['output_truncated'] = True
            return data
        raise Rejected('UNKNOWN_ACTION')


def main():
    controller = None
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--request-file':
            path = Path(sys.argv[2]).resolve()
            if path.parent != (STATE / 'requests').resolve() or not re.fullmatch(r'[A-Za-z0-9._-]{1,120}\.json', path.name):
                raise Rejected('PRIVATE_REQUEST_FILE_REQUIRED')
            raw = path.read_bytes()
        elif len(sys.argv) == 1:
            raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        else:
            raise Rejected('INVALID_ARGUMENTS')
        if len(raw) > 1024 * 1024:
            raise Rejected('REQUEST_TOO_LARGE')
        request = json.loads(raw.decode('utf-8-sig'))
        # Some Windows accessibility providers print diagnostics to stdout.
        # Keep the worker's one-JSON response independent of those providers.
        with contextlib.redirect_stdout(sys.stderr):
            controller = Controller()
            result = controller.execute(request)
    except Exception as error:
        result = {'ok': False, 'status': 'rejected', 'error': str(error)[:1000], 'automatic_replay': False}
    finally:
        if controller:
            controller.store.close()
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + '\n')


if __name__ == '__main__':
    main()
