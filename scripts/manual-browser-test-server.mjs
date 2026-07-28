// ponytail: throwaway script for manual agent-browser testing, not part of the build.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(ROOT, '..', 'tests', 'fixtures');
const DIST_DIR = path.join(ROOT, '..', 'dist');
const PORT = 4173;

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serveFixture(relativePath, res) {
  const resolvedPath = path.resolve(FIXTURES_DIR, '.' + relativePath);
  if (!(resolvedPath === FIXTURES_DIR || resolvedPath.startsWith(FIXTURES_DIR + path.sep))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(resolvedPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(resolvedPath).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const [rawPathname, query] = (req.url ?? '/').split('?');
  const pathname = decodeURIComponent(rawPathname ?? '/');
  if (pathname.startsWith('/browse/')) {
    const fixtureFile = new URLSearchParams(query ?? '').get('fixture');
    serveFixture(fixtureFile ? `/${fixtureFile}` : '/jira-issue-old-view.html', res);
    return;
  }
  serveFixture(pathname === '/' ? '/jira-issue-old-view.html' : pathname, res);
}).listen(PORT, () => {
  const fixtureOrigin = `http://localhost:${PORT}`;

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfv-ext-manual-'));
  for (const name of fs.readdirSync(DIST_DIR)) {
    fs.cpSync(path.join(DIST_DIR, name), path.join(testDir, name), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(testDir, 'manifest.json'), 'utf-8'));
  manifest.host_permissions = [...manifest.host_permissions, `${fixtureOrigin}/*`];
  manifest.content_scripts[0].matches = [...manifest.content_scripts[0].matches, `${fixtureOrigin}/*`];
  delete manifest.icons;
  fs.writeFileSync(path.join(testDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`SERVER ${fixtureOrigin}`);
  console.log(`EXTENSION_DIR ${testDir}`);
});
