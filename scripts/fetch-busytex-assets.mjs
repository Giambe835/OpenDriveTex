/**
 * @fileoverview Build asset verification & downloader script (`fetch-busytex-assets.mjs`).
 *
 * Ensures that all heavy BusyTeX WebAssembly .data packages are present in public/core/busytex/
 * before building (especially in Vercel / CI environments where Git LFS is either disabled or downloads
 * small 130-byte LFS text pointers instead of actual binary packages).
 *
 * Checks:
 *   - biber.data (~21 MB)
 *   - texlive-basic.data (~92 MB)
 *   - texlive-recommended.data (~201 MB)
 *   - texlive-extra.data (~341 MB)
 *
 * If any file does not exist or its size is <= 1024 bytes (Git LFS text pointer),
 * it downloads the binary directly from the GitHub Release assets.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BUSYTEX_DIR = path.join(PROJECT_ROOT, 'public', 'core', 'busytex');

const RELEASE_TAG = process.env.BUSYTEX_RELEASE_TAG || 'v1.0.0';
const GITHUB_REPO = process.env.BUSYTEX_REPO || 'Giambe835/OpenDriveTex';
const BASE_DOWNLOAD_URL = `https://github.com/${GITHUB_REPO}/releases/download/${RELEASE_TAG}`;

const REQUIRED_FILES = [
  'biber.data',
  'texlive-basic.data',
  'texlive-recommended.data',
  'texlive-extra.data',
];

/**
 * Downloads a file following HTTP/HTTPS redirects (e.g. GitHub Releases -> AWS S3).
 *
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const tempPath = `${destPath}.tmp-${Date.now()}`;
    const fileStream = fs.createWriteStream(tempPath);

    function get(currentUrl, redirectCount = 0) {
      if (redirectCount > 10) {
        fileStream.close();
        fs.unlink(tempPath, () => {});
        reject(new Error(`Too many redirects for ${url}`));
        return;
      }

      https
        .get(currentUrl, (response) => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            // Handle redirect
            const redirectUrl = new URL(response.headers.location, currentUrl).href;
            get(redirectUrl, redirectCount + 1);
            return;
          }

          if (response.statusCode !== 200) {
            fileStream.close();
            fs.unlink(tempPath, () => {});
            reject(
              new Error(
                `Failed to download ${currentUrl}: HTTP ${response.statusCode} ${response.statusMessage}`
              )
            );
            return;
          }

          const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
          let downloadedBytes = 0;
          let lastLoggedPercent = 0;

          response.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0) {
              const percent = Math.floor((downloadedBytes / totalBytes) * 100);
              if (percent >= lastLoggedPercent + 20) {
                lastLoggedPercent = percent;
                console.log(`  -> Progress: ${percent}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
              }
            }
          });

          response.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close(() => {
              fs.rename(tempPath, destPath, (err) => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
            });
          });
        })
        .on('error', (err) => {
          fileStream.close();
          fs.unlink(tempPath, () => {});
          reject(err);
        });
    }

    get(url);
  });
}

async function verifyAndFetchAssets() {
  console.log('[fetch-busytex-assets] Checking BusyTeX WebAssembly .data packages in:');
  console.log(`  ${BUSYTEX_DIR}`);

  if (!fs.existsSync(BUSYTEX_DIR)) {
    fs.mkdirSync(BUSYTEX_DIR, { recursive: true });
  }

  for (const fileName of REQUIRED_FILES) {
    const filePath = path.join(BUSYTEX_DIR, fileName);
    let needsDownload = false;

    if (!fs.existsSync(filePath)) {
      console.log(`[fetch-busytex-assets] ⚠️ File missing: ${fileName}`);
      needsDownload = true;
    } else {
      const stats = fs.statSync(filePath);
      // Git LFS text pointer files are typically ~130 bytes
      if (stats.size <= 1024) {
        console.log(`[fetch-busytex-assets] ⚠️ Git LFS text pointer detected for ${fileName} (${stats.size} bytes). Binary payload required.`);
        needsDownload = true;
      } else {
        console.log(`[fetch-busytex-assets] ✓ ${fileName} is present and valid (${(stats.size / 1024 / 1024).toFixed(1)} MB).`);
      }
    }

    if (needsDownload) {
      const downloadUrl = `${BASE_DOWNLOAD_URL}/${fileName}`;
      console.log(`[fetch-busytex-assets] Downloading ${fileName} from GitHub Releases...`);
      console.log(`  URL: ${downloadUrl}`);
      try {
        await downloadFile(downloadUrl, filePath);
        const downloadedStats = fs.statSync(filePath);
        console.log(`[fetch-busytex-assets] ✓ Successfully downloaded ${fileName} (${(downloadedStats.size / 1024 / 1024).toFixed(1)} MB).`);
      } catch (err) {
        console.error(`[fetch-busytex-assets] ❌ Failed to download ${fileName}:`, err.message);
        throw err;
      }
    }
  }

  console.log('[fetch-busytex-assets] All BusyTeX WebAssembly packages verified successfully.');
}

verifyAndFetchAssets().catch((err) => {
  console.error('[fetch-busytex-assets] Asset verification failed:', err);
  process.exit(1);
});

