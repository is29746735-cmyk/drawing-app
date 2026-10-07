// PC에서 시험할 때 쓰는 "가짜 Turso". 진짜 Turso와 같은 방식(HTTP pipeline)으로 대답한다.
// 실행: node tools/mock-turso.mjs  →  주소 http://localhost:8787 , 토큰 test
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.TOKEN || 'test';
const sqlite = new DatabaseSync(process.env.DB || ':memory:');

const toJs = (a) => (a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.type === 'float' ? a.value : a.value);
function toHrana(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number' || typeof v === 'bigint') {
    return Number.isInteger(Number(v)) ? { type: 'integer', value: String(v) } : { type: 'float', value: Number(v) };
  }
  return { type: 'text', value: String(v) };
}

function execute(stmt) {
  const st = sqlite.prepare(stmt.sql);
  const args = (stmt.args || []).map(toJs);
  const cols = st.columns();
  if (!cols.length) {
    const r = st.run(...args);
    return { cols: [], rows: [], affected_row_count: Number(r.changes), last_insert_rowid: null };
  }
  const rows = st.all(...args);
  return {
    cols: cols.map((c) => ({ name: c.name, decltype: null })),
    rows: rows.map((row) => cols.map((c) => toHrana(row[c.name]))),
    affected_row_count: 0,
    last_insert_rowid: null,
  };
}

createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.url !== '/v2/pipeline' || req.method !== 'POST') return res.writeHead(404, cors).end();
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401, cors).end('Unauthorized');

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const { requests } = JSON.parse(body);
    const results = requests.map((r) => {
      if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
      try {
        return { type: 'ok', response: { type: 'execute', result: execute(r.stmt) } };
      } catch (e) {
        return { type: 'error', error: { message: e.message, code: 'SQLITE_ERROR' } };
      }
    });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ baton: null, base_url: null, results }));
  });
}).listen(PORT, () => console.log(`가짜 Turso: http://localhost:${PORT} (토큰: ${TOKEN})`));
