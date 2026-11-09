/**
 * @fileoverview Build Vercel Build Output API v3 (.vercel/output).
 *
 * Steps:
 * 1. Runs `vite build` to produce client-side bundle in `dist/`.
 * 2. Deletes any `*.data` files from `dist/` (prevents >100 MB Vercel upload errors).
 * 3. Prepares `.vercel/output/static` and copies all contents from `dist/`.
 * 4. Prepares `.vercel/output/functions/api/busytex.func/` with `.vc-config.json` and `index.js`
 *    (an Edge Function streaming the .data files from GitHub Releases with full CORS headers).
 * 5. Writes `.vercel/output/config.json` (Build Output API v3 specification) with routing rules.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUTPUT_DIR = path.join(ROOT_DIR, '.vercel', 'output');
const STATIC_DIR = path.join(OUTPUT_DIR, 'static');
const FUNCTIONS_DIR = path.join(OUTPUT_DIR, 'functions');
const BUSYTEX_FUNC_DIR = path.join(FUNCTIONS_DIR, 'api', 'busytex.func');

console.log('[build-vercel-output] Step 1: Running vite build...');
execSync('npx vite build', { cwd: ROOT_DIR, stdio: 'inherit' });

console.log('[build-vercel-output] Step 2: Pruning any *.data files in dist/...');
const pruneDataFiles = (dir) => {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneDataFiles(fullPath);
    } else if (entry.name.endsWith('.data')) {
      console.log(`  -> Removing: ${fullPath}`);
      fs.unlinkSync(fullPath);
    }
  }
};
pruneDataFiles(DIST_DIR);

console.log('[build-vercel-output] Step 3: Setting up .vercel/output/static...');
fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
fs.mkdirSync(STATIC_DIR, { recursive: true });
fs.cpSync(DIST_DIR, STATIC_DIR, { recursive: true });

// Ensure no .data files slipped into static
pruneDataFiles(STATIC_DIR);

console.log('[build-vercel-output] Step 4: Creating Edge Function in .vercel/output/functions/api/busytex.func...');
fs.mkdirSync(BUSYTEX_FUNC_DIR, { recursive: true });

const vcConfig = {
  runtime: 'edge',
  entrypoint: 'index.js',
};
fs.writeFileSync(
  path.join(BUSYTEX_FUNC_DIR, '.vc-config.json'),
  JSON.stringify(vcConfig, null, 2)
);

const edgeFunctionCode = `// Edge Function: Proxy and stream BusyTeX .data binaries from GitHub Releases with CORS
export const config = { runtime: 'edge' };

const ALLOWED_FILES = new Set([
  'biber.data',
  'texlive-basic.data',
  'texlive-recommended.data',
  'texlive-extra.data',
]);

const RELEASE_BASE_URL = 'https://github.com/Giambe835/OpenDriveTex/releases/download/v1.0.0/';

export default async function handler(request) {
  const url = new URL(request.url);
  const fileName = url.searchParams.get('file');

  if (!fileName || !ALLOWED_FILES.has(fileName)) {
    return new Response('Not Found or Disallowed Asset', {
      status: 404,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain',
      },
    });
  }

  const upstreamUrl = RELEASE_BASE_URL + fileName;
  const upstreamHeaders = new Headers();

  const range = request.headers.get('range');
  if (range) {
    upstreamHeaders.set('range', range);
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
    });

    const responseHeaders = new Headers();
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
    responseHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
    responseHeaders.set('Content-Type', 'application/octet-stream');
    responseHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');

    const contentLength = upstreamResponse.headers.get('content-length');
    if (contentLength) {
      responseHeaders.set('Content-Length', contentLength);
    }

    const contentRange = upstreamResponse.headers.get('content-range');
    if (contentRange) {
      responseHeaders.set('Content-Range', contentRange);
    }

    const acceptRanges = upstreamResponse.headers.get('accept-ranges');
    if (acceptRanges) {
      responseHeaders.set('Accept-Ranges', acceptRanges);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response('Gateway Error: ' + err.message, {
      status: 502,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain',
      },
    });
  }
}
`;
fs.writeFileSync(path.join(BUSYTEX_FUNC_DIR, 'index.js'), edgeFunctionCode);

console.log('[build-vercel-output] Step 5: Writing .vercel/output/config.json...');
const outputConfig = {
  version: 3,
  routes: [
    {
      src: '^/core/busytex/(?<file>[^/]+\\.data)$',
      dest: '/api/busytex?file=$file',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    },
    {
      src: '^/(?<file>[^/]+\\.data)$',
      dest: '/api/busytex?file=$file',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    },
    {
      src: '^/core/busytex/(.*)$',
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Access-Control-Allow-Origin': '*',
      },
      continue: true,
    },
    {
      handle: 'filesystem',
    },
    {
      src: '^/((?!assets/|core/|favicon|.*\\..*).*)$',
      dest: '/index.html',
    },
  ],
};
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'config.json'),
  JSON.stringify(outputConfig, null, 2)
);

console.log('[build-vercel-output] ✓ Successfully generated .vercel/output (Build Output API v3)');

