import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]+$/, "");

export const DEFAULT_FIXTURE_SERVER_PORT = 4173;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface FixtureServerHandle {
  url: string;
  close: () => Promise<void>;
}

export function startFixtureServer(
  port: number = DEFAULT_FIXTURE_SERVER_PORT
): Promise<FixtureServerHandle> {
  const server = http.createServer((req, res) => {
    const requestUrl = req.url ?? "/";
    const pathname = decodeURIComponent(requestUrl.split("?")[0] ?? "/");
    const relativePath = pathname === "/" ? "/jira-issue-old-view.html" : pathname;

    const resolvedPath = path.resolve(FIXTURES_DIR, "." + relativePath);
    const isWithinFixturesDir =
      resolvedPath === FIXTURES_DIR || resolvedPath.startsWith(FIXTURES_DIR + path.sep);

    if (!isWithinFixturesDir) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    fs.readFile(resolvedPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentTypeFor(resolvedPath) });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const close = (): Promise<void> =>
        new Promise((resolveClose, rejectClose) => {
          server.close((closeErr) => {
            if (closeErr) {
              rejectClose(closeErr);
            } else {
              resolveClose();
            }
          });
        });

      resolve({ url: `http://localhost:${port}`, close });
    });
  });
}
