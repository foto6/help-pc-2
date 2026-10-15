import hashlib
import json
import msvcrt
import re
import sqlite3
import time
from pathlib import Path


class ActionStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock_file = (self.directory / 'controller.lock').open('a+b')
        self.lock_file.seek(0, 2)
        if self.lock_file.tell() == 0:
            self.lock_file.write(b'0')
            self.lock_file.flush()
        self.lock_file.seek(0)
        try:
            msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            self.lock_file.close()
            raise RuntimeError('CONTROLLER_BUSY') from None
        self.db = sqlite3.connect(self.directory / 'actions.sqlite3')
        self.db.execute('CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated REAL NOT NULL)')
        self.db.commit()

    def close(self):
        self.db.close()
        self.lock_file.seek(0)
        msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        self.lock_file.close()

    def lookup(self, request_id):
        row = self.db.execute('SELECT state,result,updated FROM actions WHERE id=?', (request_id,)).fetchone()
        if not row:
            return {'state': 'not_found', 'request_id': request_id}
        return {'state': row[0], 'request_id': request_id, 'updated': row[2], 'result': json.loads(row[1]) if row[1] else None}

    def existing(self, request):
        request_id = request.get('request_id')
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9._-]{8,120}', request_id):
            raise ValueError('INVALID_REQUEST_ID')
        fingerprint = hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        row = self.db.execute('SELECT fingerprint,state,result FROM actions WHERE id=?', (request_id,)).fetchone()
        if not row:
            return None
        if row[0] != fingerprint:
            raise ValueError('REQUEST_ID_CONFLICT')
        if row[1] == 'completed':
            return json.loads(row[2]) | {'duplicate': True}
        return {'ok': False, 'status': 'needs_reconciliation', 'request_id': request_id, 'prior': self.lookup(request_id)}

    def start(self, request):
        fingerprint = hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.db.execute('INSERT INTO actions VALUES(?,?,?,?,?)', (request['request_id'], fingerprint, 'started', None, time.time()))
        self.db.commit()

    def finish(self, request_id, state, result):
        self.db.execute('UPDATE actions SET state=?,result=?,updated=? WHERE id=?',
                        (state, json.dumps(result, ensure_ascii=False), time.time(), request_id))
        self.db.commit()
