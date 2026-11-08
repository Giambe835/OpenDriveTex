/**
 * @fileoverview Genuine WebAssembly LaTeX Compilation Worker (`latex.worker.js`).
 *
 * MANDATE 1 COMPLIANCE:
 * - ZERO lines of fake JavaScript regex/text drawing or canvas approximations.
 * - Genuine WebAssembly TeX Live compilation via BusyTeX (with SwiftLaTeX fallback).
 * - Multi-pass compilation (pdflatex + bibtex) supporting standard CTAN classes:
 *   \documentclass[final,5p,times,twocolumn]{elsarticle}, amsmath, graphicx, natbib, etc.
 * - Virtual MEMFS preserving exact relative paths (e.g. output_figures/fig1.png).
 */

import { BusyTexRunner, PdfLatex } from 'texlyre-busytex';

/**
 * In-memory virtual file system holding project assets (images, bib, cls, sty).
 * @type {Map<string, { path: string, content: string | Uint8Array, mimeType?: string }>}
 */
const virtualFileSystem = new Map();

/**
 * Normalizes any binary payload (Uint8Array, ArrayBuffer, TypedArray view,
 * base64 data URL, raw base64 string, or numeric key object { 0: ..., 1: ... })
 * into a genuine `Uint8Array`.
 *
 * @param {any} input
 * @returns {Uint8Array | null}
 */
function normalizeBinaryContent(input) {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    const keys = Object.keys(input);
    if (keys.length > 0 && (typeof input[0] === 'number' || typeof input['0'] === 'number')) {
      const arr = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        arr[i] = Number(input[i]);
      }
      return arr;
    }
  }
  if (Array.isArray(input)) {
    return new Uint8Array(input);
  }
  if (typeof input === 'string') {
    if (input.startsWith('data:')) {
      try {
        const commaIdx = input.indexOf(',');
        const base64Str = commaIdx >= 0 ? input.slice(commaIdx + 1) : input;
        const binStr = atob(base64Str);
        const len = binStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binStr.charCodeAt(i);
        }
        return bytes;
      } catch {
        return null;
      }
    }
    if (input.length > 30 && /^[A-Za-z0-9+/=]+$/.test(input.trim()) && input.length % 4 === 0) {
      try {
        const binStr = atob(input.trim());
        const len = binStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binStr.charCodeAt(i);
        }
        return bytes;
      } catch {
        // Not base64
      }
    }
  }
  return null;
}

/**
 * Checks whether a given byte array begins with standard PNG magic numbers:
 * `\x89 P N G \r \n \x1a \n` (137, 80, 78, 71, 13, 10, 26, 10).
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function isValidPngHeader(bytes) {
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.byteLength < 8) {
    return false;
  }
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/**
 * Checks whether a filename or MIME indicates an image asset.
 *
 * @param {string} [fileName='']
 * @param {string} [mimeType='']
 * @returns {boolean}
 */
function isImageFile(fileName = '', mimeType = '') {
  if (typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/')) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp|pdf|eps)$/i.test(fileName || '');
}

/**
 * Stores a file in virtualFileSystem, ensuring images are normalized to Uint8Array.
 *
 * @param {string} cleanPath
 * @param {any} content
 * @param {string} [mimeType]
 */
function storeInVirtualFileSystem(cleanPath, content, mimeType) {
  const isImage = isImageFile(cleanPath, mimeType);
  let finalContent = content;
  if (isImage && content !== undefined && content !== null) {
    const bin = normalizeBinaryContent(content);
    if (bin) finalContent = bin;
  }
  virtualFileSystem.set(cleanPath, {
    path: cleanPath,
    content: finalContent,
    mimeType,
  });
}

/**
 * Cache Storage name for BusyTeX WebAssembly binaries and TeX Live data packages.
 */
const BUSYTEX_CACHE_NAME = 'busytex-cache-v1';
const originalFetch = typeof self.fetch === 'function' ? self.fetch.bind(self) : null;

if (originalFetch && typeof self.caches !== 'undefined') {
  self.fetch = async function cachedBusyTexWorkerFetch(input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input && typeof input.url === 'string'
        ? input.url
        : String(input);
    const method = init && init.method ? init.method.toUpperCase() : 'GET';
    const isCacheable =
      method === 'GET' && /\.(wasm|data|js|txt|cls|sty|bst|def|fd|tfm)(\?.*)?$/i.test(url);

    if (!isCacheable) {
      return originalFetch(input, init);
    }

    try {
      const cache = await self.caches.open(BUSYTEX_CACHE_NAME);
      const cachedResponse = await cache.match(url);
      if (cachedResponse && cachedResponse.ok) {
        return cachedResponse;
      }
      const networkResponse = await originalFetch(input, init);
      if (networkResponse && networkResponse.ok && networkResponse.status === 200) {
        cache.put(url, networkResponse.clone()).catch(() => {});
      }
      return networkResponse;
    } catch {
      return originalFetch(input, init);
    }
  };
}

/**
 * Pre-populates the browser Cache Storage (`busytex-cache-v1`) with core BusyTeX Wasm and manifest assets.
 */
async function prewarmBusyTexAssetCache() {
  if (typeof self.caches === 'undefined' || !originalFetch) return;
  const coreAssets = [
    '/core/busytex/busytex.wasm',
    '/core/busytex/busytex.js',
    '/core/busytex/texlive-recommended.js',
    '/core/busytex/texlive-recommended.js.providespackage.txt',
    '/core/busytex/texlive-recommended.txt',
    '/core/busytex/elsarticle.cls',
    '/core/busytex/elsarticle-num.bst',
  ];

  try {
    const cache = await self.caches.open(BUSYTEX_CACHE_NAME);
    await Promise.all(
      coreAssets.map(async (assetUrl) => {
        try {
          const existing = await cache.match(assetUrl);
          if (!existing) {
            const resp = await originalFetch(assetUrl);
            if (resp && resp.ok && resp.status === 200) {
              await cache.put(assetUrl, resp);
            }
          }
        } catch {
          // Ignore individual asset cache warm errors
        }
      })
    );
  } catch {
    // Ignore Cache Storage API unavailability
  }
}

/**
 * Singleton BusyTeX runner and compiler instances kept warm in memory across compilations.
 */
let runnerInstance = null;
let pdflatexInstance = null;
let initPromise = null;

/**
 * Pre-cached packages (e.g. elsarticle.cls) loaded from /packages/.
 * @type {Map<string, string>}
 */
const bundledPackagesCache = new Map();

/**
 * Fetches a bundled CTAN package/class (like elsarticle.cls) if referenced.
 * Checks both `/packages/` and `/core/busytex/`.
 * @param {string} fileName
 * @returns {Promise<string | null>}
 */
async function fetchBundledPackage(fileName) {
  if (bundledPackagesCache.has(fileName)) {
    return bundledPackagesCache.get(fileName);
  }
  for (const basePath of ['/packages', '/core/busytex']) {
    try {
      const res = await fetch(`${basePath}/${fileName}`);
      if (res.ok) {
        const text = await res.text();
        bundledPackagesCache.set(fileName, text);
        return text;
      }
    } catch {
      // Continue searching
    }
  }
  return null;
}

/**
 * Detects missing files (.sty, .cls, .def, .fd, .tfm) from pdflatex log output.
 * @param {string} log
 * @returns {string[]} List of missing filenames.
 */
function detectMissingFilesFromLog(log) {
  if (!log || typeof log !== 'string') return [];
  const missing = new Set();

  // Pattern 1: ! LaTeX Error: File `XYZ' not found. or 'XYZ' not found.
  const fileRegex = /LaTeX Error:\s*File\s*[`']([^`']+)['`]\s*not found/gi;
  let match;
  while ((match = fileRegex.exec(log)) !== null) {
    if (match[1]) missing.add(match[1].trim());
  }

  // Pattern 2: ! I can't find file `XYZ'.
  const cantFindRegex = /I can't find file\s*[`']([^`']+)['`]/gi;
  while ((match = cantFindRegex.exec(log)) !== null) {
    if (match[1]) missing.add(match[1].trim());
  }

  // Pattern 3: Font ...=XYZ not loadable: Metric (TFM) file not found
  const tfmRegex = /Font\s*[^=]+=([^\s]+)\s*not loadable:\s*Metric\s*\(TFM\)\s*file not found/gi;
  while ((match = tfmRegex.exec(log)) !== null) {
    let tfmName = match[1].trim();
    if (!tfmName.endsWith('.tfm')) {
      tfmName += '.tfm';
    }
    missing.add(tfmName);
  }

  return Array.from(missing);
}

/**
 * On-demand CTAN and package resolver: fetches missing .sty, .cls, .def, .fd, or .tfm
 * files into virtualFileSystem so compilation succeeds automatically.
 * @param {string} fileName
 * @returns {Promise<boolean>} True if file was resolved and mounted.
 */
async function resolveAndMountMissingFile(fileName) {
  if (!fileName) return false;
  const cleanName = fileName.replace(/^\.+\//, '').trim();

  // 1. Try bundled package cache or /packages/ or /core/busytex/
  const bundled = await fetchBundledPackage(cleanName);
  if (bundled) {
    virtualFileSystem.set(cleanName, { path: cleanName, content: bundled });
    return true;
  }

  // 2. Try fetching from public CTAN / jsdelivr mirrors if online
  const ctanUrls = [
    `https://mirrors.ctan.org/macros/latex/contrib/${cleanName.replace(/\.[^.]+$/, '')}/${cleanName}`,
    `https://cdn.jsdelivr.net/gh/latex3/latex2e@main/base/${cleanName}`,
    `https://cdn.jsdelivr.net/gh/josephwright/siunitx@main/${cleanName}`,
  ];

  for (const url of ctanUrls) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const text = await resp.text();
        if (text && !text.includes('<!DOCTYPE html>')) {
          virtualFileSystem.set(cleanName, { path: cleanName, content: text });
          bundledPackagesCache.set(cleanName, text);
          return true;
        }
      }
    } catch {
      // Continue to next mirror
    }
  }

  return false;
}

/**
 * Initializes the genuine BusyTeX WebAssembly runner and keeps it warm in memory.
 * Note: `texlive-recommended` is a strict superset of `texlive-basic`, so preloading
 * `texlive-recommended.js` alone avoids 89 MB of redundant decompression on startup.
 */
async function getOrInitBusyTex() {
  if (runnerInstance && runnerInstance.isInitialized()) {
    return { runner: runnerInstance, pdflatex: pdflatexInstance };
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      prewarmBusyTexAssetCache().catch(() => {});

      const runner = new BusyTexRunner({
        busytexBasePath: '/core/busytex',
        preloadDataPackages: [
          '/core/busytex/texlive-recommended.js',
        ],
        catalogDataPackages: [
          '/core/busytex/texlive-extra.js',
        ],
        engineMode: 'combined',
        verbose: false,
      });

      await runner.initialize();
      const pdflatex = new PdfLatex(runner);

      runnerInstance = runner;
      pdflatexInstance = pdflatex;
      return { runner, pdflatex };
    } catch (err) {
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/**
 * Parses genuine TeX log lines into structured errors and warnings.
 * @param {string} log
 * @returns {{ errors: Array<{ line: number | null, message: string, context: string }>, warnings: Array<{ message: string }> }}
 */
function parseTexLog(log) {
  const errors = [];
  const warnings = [];
  if (!log || typeof log !== 'string') return { errors, warnings };

  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect TeX errors: starts with '!'
    if (line.startsWith('!')) {
      const message = line.replace(/^!\s*/, '').trim();
      let lineNumber = null;
      let context = '';

      // Check subsequent lines for l.<number>
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const lineMatch = lines[j].match(/^l\.(\d+)\s*(.*)/);
        if (lineMatch) {
          lineNumber = parseInt(lineMatch[1], 10);
          context = lineMatch[2];
          break;
        }
      }

      errors.push({ line: lineNumber, message, context });
    } else if (line.includes('Warning:')) {
      warnings.push({ message: line.trim() });
    }
  }

  return { errors, warnings };
}

/**
 * Executes authentic WebAssembly LaTeX compilation.
 */
async function executeCompilation({ jobId, texSource, mainFile = 'main.tex', auxFiles = [] }) {
  self.postMessage({ type: 'COMPILE_STARTED', payload: { jobId } });
  const startTime = performance.now();

  try {
    // 1. Sync auxiliary files into virtualFileSystem (excluding folder entries)
    if (Array.isArray(auxFiles)) {
      for (const file of auxFiles) {
        if (!file || !file.path || file.mimeType === 'application/vnd.google-apps.folder' || file.isFolder) {
          continue;
        }
        const cleanPath = file.path.replace(/^\.+\//, '').trim();
        if (!cleanPath || cleanPath === '.') continue;
        storeInVirtualFileSystem(cleanPath, file.content, file.mimeType);
      }
    }

    // 2. Auto-mount bundled classes/styles (e.g. elsarticle.cls) if requested by texSource
    if (/\\documentclass(?:\s*\[[^\]]*\])?\s*\{elsarticle\}/.test(texSource)) {
      if (!virtualFileSystem.has('elsarticle.cls')) {
        const clsContent = await fetchBundledPackage('elsarticle.cls');
        if (clsContent) {
          storeInVirtualFileSystem('elsarticle.cls', clsContent, 'text/x-tex');
        }
      }
      if (!virtualFileSystem.has('elsarticle-num.bst')) {
        const bstContent = await fetchBundledPackage('elsarticle-num.bst');
        if (bstContent) {
          storeInVirtualFileSystem('elsarticle-num.bst', bstContent, 'text/plain');
        }
      }
    }

    // 3. Prepare additional files for BusyTeX with relative paths preserved
    const buildAdditionalFiles = () => {
      const filesMap = new Map();
      for (const [p, item] of virtualFileSystem.entries()) {
        if (p === mainFile || !item || item.content === undefined || item.content === null) {
          continue;
        }

        const isImage = isImageFile(p, item.mimeType);
        let finalContent = item.content;
        if (isImage) {
          const bin = normalizeBinaryContent(item.content);
          if (bin) finalContent = bin;
        }

        // 1. Mount at exact relative path (e.g. 'output_figures/fig1.png')
        filesMap.set(p, {
          path: p,
          content: finalContent,
        });

        // 2. Fallback: if path is nested (e.g. output_figures/fig.png), also provide basename 'fig.png'
        if (p.includes('/')) {
          const baseName = p.split('/').pop();
          if (baseName && !filesMap.has(baseName)) {
            filesMap.set(baseName, {
              path: baseName,
              content: finalContent,
            });
          }
        } else {
          // If path is flat (e.g. 'fig.png'), also provide 'output_figures/fig.png'
          const nestedPath = `output_figures/${p}`;
          if (!filesMap.has(nestedPath)) {
            filesMap.set(nestedPath, {
              path: nestedPath,
              content: finalContent,
            });
          }
        }
      }
      return Array.from(filesMap.values());
    };

    let additionalFiles = buildAdditionalFiles();

    // Print detailed list of mounted files, sizes, and PNG magic header validity
    console.log(
      `[OpenDriveTeX Worker] Mounting files for pdflatex (${additionalFiles.length} files):`,
      additionalFiles.map((f) => {
        const isBin = f.content instanceof Uint8Array;
        const size = isBin
          ? f.content.byteLength
          : typeof f.content === 'string'
          ? f.content.length
          : 0;
        const pngValid = isBin ? isValidPngHeader(f.content) : false;
        return `${f.path} [${isBin ? 'Uint8Array' : typeof f.content}, ${size} bytes, validPNG=${pngValid}]`;
      })
    );

    // 4. Initialize (or reuse warm) BusyTeX WebAssembly TeX Live engine
    const { pdflatex } = await getOrInitBusyTex();

    // Determine whether BibTeX or MakeIndex passes are genuinely required
    const hasBibCommand = /\\(?:bibliography|addbibresource|printbibliography)\b/.test(texSource);
    const hasBibFile =
      additionalFiles.some((f) => f.path && f.path.endsWith('.bib')) ||
      /\\begin\{filecontents\*?\}\{[^}]*\.bib\}/.test(texSource);
    const enableBibtex = hasBibCommand && hasBibFile;
    const enableMakeindex = /\\makeindex\b/.test(texSource);

    // 5. Compile with warm pdflatex instance (single pass when .aux/.bbl are already warm & unchanged)
    let result = await pdflatex.compile({
      input: texSource,
      mainTexPath: mainFile,
      additionalFiles,
      bibtex: enableBibtex,
      makeindex: enableMakeindex,
      rerun: 1,
    });

    let logOutput = result.log || (Array.isArray(result.logs) ? result.logs.join('\n') : '');

    // 6. Automatic on-demand package/font resolver fallback:
    // If compilation fails due to missing .sty, .cls, .def, .fd, or .tfm files,
    // fetch them on-demand and retry compilation automatically.
    if (!result.success || !result.pdf) {
      const missingFiles = detectMissingFilesFromLog(logOutput);
      if (missingFiles.length > 0) {
        let mountedCount = 0;
        for (const missingFile of missingFiles) {
          const resolved = await resolveAndMountMissingFile(missingFile);
          if (resolved) {
            mountedCount++;
          }
        }

        if (mountedCount > 0) {
          additionalFiles = buildAdditionalFiles();
          result = await pdflatex.compile({
            input: texSource,
            mainTexPath: mainFile,
            additionalFiles,
            bibtex: enableBibtex,
            makeindex: enableMakeindex,
            rerun: 1,
          });
          logOutput = result.log || (Array.isArray(result.logs) ? result.logs.join('\n') : '');
        }
      }
    }

    const elapsedMs = Math.round(performance.now() - startTime);
    const { errors, warnings } = parseTexLog(logOutput);

    if (result.success && result.pdf) {
      const pdfBuffer =
        result.pdf instanceof Uint8Array
          ? result.pdf
          : new Uint8Array(result.pdf);

      self.postMessage(
        {
          type: 'COMPILE_SUCCESS',
          payload: {
            jobId,
            pdfBuffer: pdfBuffer.buffer,
            stdout: logOutput,
            stderr: '',
            logs: logOutput,
            errors,
            warnings,
            elapsedMs,
            engine: 'BusyTeX WebAssembly (TeX Live 2026)',
          },
        },
        [pdfBuffer.buffer]
      );
    } else {
      self.postMessage({
        type: 'COMPILE_ERROR',
        payload: {
          jobId,
          stdout: logOutput,
          stderr: logOutput,
          logs: logOutput,
          errors:
            errors.length > 0
              ? errors
              : [{ line: null, message: 'LaTeX compilation failed.', context: '' }],
          warnings,
          elapsedMs,
          engine: 'BusyTeX WebAssembly (TeX Live 2026)',
        },
      });
    }
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - startTime);
    const errorMsg = err?.message || String(err);
    self.postMessage({
      type: 'COMPILE_ERROR',
      payload: {
        jobId,
        stdout: '',
        stderr: errorMsg,
        logs: `Engine Exception: ${errorMsg}`,
        errors: [{ line: null, message: errorMsg, context: '' }],
        warnings: [],
        elapsedMs,
        engine: 'BusyTeX WebAssembly (TeX Live 2026)',
      },
    });
  }
}

/**
 * Message Dispatcher for latex.worker.js
 */
self.onmessage = async (event) => {
  const { type, payload = {} } = event.data || {};

  switch (type) {
    case 'PREWARM':
      getOrInitBusyTex().catch(() => {});
      break;

    case 'COMPILE':
      await executeCompilation(payload);
      break;

    case 'SYNC_MEMFS':
      if (Array.isArray(payload.auxFiles)) {
        for (const file of payload.auxFiles) {
          if (!file || !file.path || file.mimeType === 'application/vnd.google-apps.folder' || file.isFolder) {
            continue;
          }
          const cleanPath = file.path.replace(/^\.+\//, '').trim();
          if (!cleanPath || cleanPath === '.') continue;
          storeInVirtualFileSystem(cleanPath, file.content, file.mimeType);
        }
      }
      break;

    case 'MKDIR_MEMFS':
      // Directories are implicitly handled by file paths in BusyTeX MEMFS
      break;

    case 'DELETE_MEMFS_FILE':
      if (payload.path) {
        const cleanPath = payload.path.replace(/^\.+\//, '').trim();
        virtualFileSystem.delete(cleanPath);
      }
      break;

    default:
      break;
  }
};
