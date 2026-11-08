/**
 * @fileoverview Google Identity Services (GIS) OAuth 2.0, Google Picker API,
 * Google UserInfo, and Google Drive REST API v3 Service.
 *
 * CRITICAL ARCHITECTURAL RULES:
 * 1. Uses Google Identity Services (`https://accounts.google.com/gsi/client`)
 *    via `google.accounts.oauth2.initTokenClient` with scopes:
 *    `https://www.googleapis.com/auth/drive.file openid profile email`.
 * 2. Immediately after receiving `access_token`, fetches
 *    `https://www.googleapis.com/oauth2/v3/userinfo` to retrieve the user's real
 *    Google profile (`name`, `email`, `picture`).
 * 3. Uses the official Google Picker API (`google.picker.PickerBuilder`) so users and
 *    collaborators can visually select folders and shared files ("Shared with me"),
 *    automatically granting `drive.file` scope access without 404 errors.
 * 4. Strictly validates `folderId` and `fileId` so invalid values like `'.'` are never
 *    passed to the Google Drive REST API.
 * 5. Supports Google Drive "Open With" URL integration (`?state={"ids":[...],"action":"open"}`).
 */

/**
 * Required Google OAuth 2.0 scopes:
 * - `drive.file`: Per-file/folder access to items created or opened via Google Picker / OpenDriveTeX.
 * - `openid profile email`: Authenticated researcher's real name, email, and avatar picture.
 * @type {string}
 */
export const GOOGLE_OAUTH_SCOPES =
  'https://www.googleapis.com/auth/drive.file openid profile email';

/**
 * Official Google Identity Services client script URL.
 * @type {string}
 */
const GIS_CLIENT_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/**
 * Official Google API loader script URL (used solely for `gapi.load('picker')`, never `gapi.auth2`).
 * @type {string}
 */
const GAPI_PICKER_SCRIPT_URL = 'https://apis.google.com/js/api.js';

/**
 * Google OAuth2 v3 UserInfo endpoint.
 * @type {string}
 */
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * Base URLs for the Google Drive REST API v3.
 */
const DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_BASE_URL = 'https://www.googleapis.com/upload/drive/v3/files';

/**
 * Session storage keys for persisting active OAuth access token and user profile within a tab.
 */
const TOKEN_STORAGE_KEY = 'opendrivetex_gis_token_v2';
const USER_PROFILE_STORAGE_KEY = 'opendrivetex_google_user_profile_v1';
const CLIENT_ID_STORAGE_KEY = 'opendrivetex_google_client_id';
const API_KEY_STORAGE_KEY = 'opendrivetex_google_api_key';

/**
 * In-memory active token record.
 * @type {{ accessToken: string, expiresAt: number, isSimulated?: boolean } | null}
 */
let currentTokenRecord = null;

/**
 * In-memory authenticated Google user profile (`{ name, email, picture, sub }`).
 * @type {{ name: string, email: string, picture: string, sub?: string } | null}
 */
let currentUserProfile = null;

/**
 * Tracks whether the Google Picker API library has been loaded.
 * @type {boolean}
 */
let isPickerLoaded = false;

/**
 * Default starter BibTeX content seeded into newly created project folders.
 * @type {string}
 */
export const DEFAULT_BIBTEX_CONTENT = `@article{einstein1935can,
  author  = {Einstein, Albert and Podolsky, Boris and Rosen, Nathan},
  title   = {Can Quantum-Mechanical Description of Physical Reality Be Considered Complete?},
  journal = {Physical Review},
  volume  = {47},
  number  = {10},
  pages   = {777--780},
  year    = {1935}
}

@inproceedings{shapiro2011crdt,
  author    = {Shapiro, Marc and Pregui{\\c{c}}a, Nuno and Baquero, Carlos and Zawirski, Marek},
  title     = {Conflict-Free Replicated Data Types},
  booktitle = {Symposium on Self-Stabilizing Systems (SSS)},
  pages     = {386--400},
  year      = {2011}
}

@book{lamport1994latex,
  author    = {Lamport, Leslie},
  title     = {LaTeX: A Document Preparation System},
  publisher = {Addison-Wesley},
  edition   = {2nd},
  year      = {1994}
}
`;

/**
 * Minimal clean starter `.tex` template used ONLY when creating a brand-new `.tex` file
 * inside a newly created Google Drive folder.
 * @type {string}
 */
export const NEW_PROJECT_MAIN_TEX_TEMPLATE = `\\documentclass[11pt,a4paper]{article}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{geometry}
\\geometry{margin=1in}

\\title{Untitled Manuscript}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Write your abstract here. You can cite entries from \\texttt{references.bib} such as \\cite{lamport1994latex}.
\\end{abstract}

\\section{Introduction}
Start writing your manuscript here.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`;

/**
 * Validates a Google Drive `fileId` or `folderId` to prevent invalid paths such as `'.'`, `'/'`,
 * or empty strings from ever being sent to the Google Drive REST API.
 *
 * @param {string | null | undefined} id - Candidate Drive ID.
 * @returns {boolean} True if the ID is a valid non-dot Drive identifier.
 */
export function isValidDriveId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed === '/') {
    return false;
  }
  return /^[a-zA-Z0-9_-]{3,}$/.test(trimmed);
}

/**
 * Resolves the configured Google OAuth 2.0 Client ID from `import.meta.env.VITE_GOOGLE_CLIENT_ID`
 * or a runtime override stored in `localStorage`.
 *
 * @returns {string}
 */
export function getConfiguredGoogleClientId() {
  const envClientId = import.meta.env?.VITE_GOOGLE_CLIENT_ID;
  if (
    typeof envClientId === 'string' &&
    envClientId.trim() &&
    !envClientId.includes('your_client_id_here')
  ) {
    return envClientId.trim();
  }

  try {
    const stored = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  } catch {
    // Ignore storage read errors
  }

  return '';
}

/**
 * Resolves the configured Google Cloud API Key (used by Google Picker API)
 * from `import.meta.env.VITE_GOOGLE_API_KEY` or `localStorage`.
 *
 * @returns {string}
 */
export function getConfiguredGoogleApiKey() {
  const envApiKey = import.meta.env?.VITE_GOOGLE_API_KEY;
  if (
    typeof envApiKey === 'string' &&
    envApiKey.trim() &&
    !envApiKey.includes('your_api_key_here')
  ) {
    return envApiKey.trim();
  }

  try {
    const stored = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  } catch {
    // Ignore storage read errors
  }

  return '';
}

/**
 * Saves runtime Google OAuth Client ID and optional API Key overrides to `localStorage`.
 *
 * @param {string} clientId - Google Cloud OAuth 2.0 Web Client ID.
 * @param {string} [apiKey] - Google Cloud API Key for Google Picker.
 */
export function setRuntimeGoogleCredentials(clientId, apiKey) {
  try {
    if (clientId && clientId.trim()) {
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId.trim());
    } else {
      localStorage.removeItem(CLIENT_ID_STORAGE_KEY);
    }

    if (apiKey !== undefined) {
      if (apiKey && apiKey.trim()) {
        localStorage.setItem(API_KEY_STORAGE_KEY, apiKey.trim());
      } else {
        localStorage.removeItem(API_KEY_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore storage write errors
  }
}

/**
 * Backwards-compatible alias for setting the runtime Google Client ID.
 *
 * @param {string} clientId
 */
export function setRuntimeGoogleClientId(clientId) {
  setRuntimeGoogleCredentials(clientId);
}

/**
 * Extracts the Google Cloud numeric Project Number (`appId`) from the OAuth Client ID
 * (e.g. `'123456789012-abc.apps.googleusercontent.com'` -> `'123456789012'`).
 * Passing `setAppId` to `PickerBuilder` is required by Google Drive so that picking a shared
 * folder or file grants `drive.file` access to this application's OAuth token.
 *
 * @returns {string}
 */
export function getGoogleAppIdFromClientId() {
  const clientId = getConfiguredGoogleClientId();
  if (!clientId) return '';
  const match = clientId.match(/^(\d+)-/);
  return match ? match[1] : '';
}

const PENDING_DRIVE_STATE_STORAGE_KEY = 'opendrivetex_pending_drive_state';

/**
 * Normalizes a parsed Google Drive `?state=` JSON object into a validated payload.
 *
 * @param {any} parsed
 * @returns {{ action: string, ids: string[], folderId?: string, userId?: string } | null}
 */
function normalizeDriveOpenWithState(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const candidateIds = Array.isArray(parsed.ids)
    ? parsed.ids
    : Array.isArray(parsed.exportIds)
    ? parsed.exportIds
    : [];

  const validIds = candidateIds.filter(isValidDriveId);
  if (validIds.length === 0 && !isValidDriveId(parsed.folderId)) {
    return null;
  }

  return {
    action: parsed.action || 'open',
    ids: validIds,
    folderId: isValidDriveId(parsed.folderId) ? parsed.folderId : undefined,
    userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
  };
}

/**
 * Parses Google Drive's "Open With" `?state=` query parameter if present in the URL,
 * persists it in `sessionStorage` BEFORE OAuth login so it is never lost across popups/redirects,
 * and falls back to `sessionStorage` if the URL parameter was already consumed.
 *
 * Google Drive passes `?state={"ids":["FILE_ID"],"action":"open","userId":"..."}`.
 *
 * @returns {{ action: string, ids: string[], folderId?: string, userId?: string } | null}
 */
export function parseDriveOpenWithStateFromUrl() {
  if (typeof window === 'undefined') return null;

  try {
    const searchParams = new URLSearchParams(window.location.search);
    let rawState = searchParams.get('state');

    if (!rawState && window.location.hash.includes('state=')) {
      const hashQuery = window.location.hash.replace(/^#/, '');
      const hashParams = new URLSearchParams(hashQuery);
      rawState = hashParams.get('state');
    }

    if (rawState) {
      const parsed = JSON.parse(rawState);
      const normalized = normalizeDriveOpenWithState(parsed);
      if (normalized) {
        try {
          sessionStorage.setItem(PENDING_DRIVE_STATE_STORAGE_KEY, JSON.stringify(normalized));
        } catch {
          // Ignore sessionStorage write restrictions
        }
        return normalized;
      }
    }

    // Fallback: check sessionStorage if `?state=` was persisted prior to OAuth login
    try {
      const storedRaw = sessionStorage.getItem(PENDING_DRIVE_STATE_STORAGE_KEY);
      if (storedRaw) {
        const storedParsed = JSON.parse(storedRaw);
        return normalizeDriveOpenWithState(storedParsed);
      }
    } catch {
      // Ignore sessionStorage read errors
    }

    return null;
  } catch (err) {
    console.warn('[OpenDriveTeX] Failed to parse ?state= parameter from URL:', err);
    return null;
  }
}

/**
 * Cleans the `?state=` parameter from both `sessionStorage` and the browser address bar
 * using `window.history.replaceState` once the target file/folder has been loaded,
 * preventing page refreshes from re-triggering the initial import loop.
 */
export function clearPendingDriveOpenWithState() {
  if (typeof window === 'undefined') return;

  try {
    sessionStorage.removeItem(PENDING_DRIVE_STATE_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }

  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('state')) {
      url.searchParams.delete('state');
      const remainingSearch = url.searchParams.toString();
      const cleanUrl = `${url.pathname}${remainingSearch ? `?${remainingSearch}` : ''}${url.hash}`;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  } catch {
    const cleanUrl = `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

// Eagerly capture and persist `?state=` into sessionStorage as soon as the module loads
if (typeof window !== 'undefined') {
  parseDriveOpenWithStateFromUrl();
}

/**
 * Dynamically injects and loads the Google Identity Services (`gsi/client`) script.
 *
 * @returns {Promise<void>}
 */
export function loadGisClientScript() {
  return new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.google?.accounts?.oauth2) {
      resolve();
      return;
    }

    const existingScript = document.querySelector(`script[src="${GIS_CLIENT_SCRIPT_URL}"]`);
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener(
        'error',
        () => reject(new Error('Failed to load Google Identity Services script.')),
        { once: true }
      );
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_CLIENT_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new Error(
          'Failed to load Google Identity Services (https://accounts.google.com/gsi/client).'
        )
      );
    document.head.appendChild(script);
  });
}

/**
 * Dynamically loads the official Google Picker API (`window.google.picker.PickerBuilder`)
 * via `https://apis.google.com/js/api.js` -> `gapi.load('picker')`.
 * Note: This only loads the `picker` UI widget module, NEVER `gapi.auth2`.
 *
 * @returns {Promise<void>}
 */
export function loadGooglePickerApi() {
  return new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.google?.picker?.PickerBuilder && isPickerLoaded) {
      resolve();
      return;
    }

    const onGapiReady = () => {
      if (!window.gapi?.load) {
        reject(new Error('Google API loader (gapi.load) is unavailable for Google Picker.'));
        return;
      }
      window.gapi.load('picker', {
        callback: () => {
          isPickerLoaded = true;
          resolve();
        },
        onerror: () => {
          reject(new Error('Failed to load the Google Picker module.'));
        },
      });
    };

    if (typeof window !== 'undefined' && window.gapi?.load) {
      onGapiReady();
      return;
    }

    const existingScript = document.querySelector(`script[src="${GAPI_PICKER_SCRIPT_URL}"]`);
    if (existingScript) {
      existingScript.addEventListener('load', onGapiReady, { once: true });
      existingScript.addEventListener(
        'error',
        () => reject(new Error('Failed to load Google Picker script.')),
        { once: true }
      );
      return;
    }

    const script = document.createElement('script');
    script.src = GAPI_PICKER_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = onGapiReady;
    script.onerror = () =>
      reject(new Error('Failed to load https://apis.google.com/js/api.js for Google Picker.'));
    document.head.appendChild(script);
  });
}

/**
 * Returns the currently valid OAuth 2.0 access token, or `null` if unauthenticated or expired.
 *
 * @returns {string | null}
 */
export function getValidAccessToken() {
  if (!currentTokenRecord) {
    try {
      const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.accessToken && parsed.expiresAt > Date.now()) {
          currentTokenRecord = parsed;
        } else {
          sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        }
      }
    } catch {
      // Ignore sessionStorage errors
    }
  }

  if (currentTokenRecord && currentTokenRecord.expiresAt > Date.now()) {
    return currentTokenRecord.accessToken;
  }

  currentTokenRecord = null;
  return null;
}

/**
 * Single in-flight token refresh promise to prevent multiple concurrent GIS requests.
 * @type {Promise<string | null> | null}
 */
let activeTokenRefreshPromise = null;

/**
 * Automatically requests a fresh Google OAuth 2.0 access token via Google Identity Services (GIS)
 * using `tokenClient.requestAccessToken({ prompt: '', login_hint: userEmail })`.
 *
 * Stores `expiresAt = Date.now() + (tokenResponse.expires_in - 120) * 1000` to prevent
 * 60-minute HTTP 401 expiration during long writing sessions.
 *
 * @returns {Promise<string | null>} Fresh access token.
 */
export async function refreshAccessToken() {
  if (isSimulatedTokenActive()) {
    if (currentTokenRecord) {
      currentTokenRecord.expiresAt = Date.now() + 3600 * 1000;
      try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(currentTokenRecord));
      } catch {
        // Ignore storage write errors
      }
      return currentTokenRecord.accessToken;
    }
    return null;
  }

  if (activeTokenRefreshPromise) {
    return activeTokenRefreshPromise;
  }

  activeTokenRefreshPromise = (async () => {
    try {
      const resolvedClientId = getConfiguredGoogleClientId();
      if (!resolvedClientId) {
        throw new Error('Missing Google OAuth Client ID for token refresh.');
      }

      await loadGisClientScript();

      if (!window.google?.accounts?.oauth2?.initTokenClient) {
        throw new Error(
          'Google Identity Services (google.accounts.oauth2.initTokenClient) is unavailable.'
        );
      }

      const userEmail = currentUserProfile?.email || getAuthenticatedUserProfile()?.email || '';

      const refreshedToken = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('Silent Google OAuth token refresh timed out.'));
          }
        }, 15000);

        try {
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: resolvedClientId,
            scope: GOOGLE_OAUTH_SCOPES,
            callback: (tokenResponse) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);

              if (tokenResponse.error) {
                reject(
                  new Error(
                    tokenResponse.error_description ||
                      `Google OAuth Token Refresh Error: ${tokenResponse.error}`
                  )
                );
                return;
              }

              const expiresInSec = Number(tokenResponse.expires_in) || 3599;
              const record = {
                accessToken: tokenResponse.access_token,
                expiresAt: Date.now() + (expiresInSec - 120) * 1000,
                isSimulated: false,
              };

              currentTokenRecord = record;
              try {
                sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(record));
              } catch {
                // Ignore storage errors
              }

              resolve(tokenResponse.access_token);
            },
            error_callback: (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(new Error(err?.message || 'Silent token refresh failed.'));
            },
          });

          client.requestAccessToken({
            prompt: '',
            login_hint: userEmail || undefined,
          });
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        }
      });

      return refreshedToken;
    } finally {
      activeTokenRefreshPromise = null;
    }
  })();

  return activeTokenRefreshPromise;
}

/**
 * Ensures that a valid (unexpired) access token is available.
 * If the current token is missing or within 120s of expiring, automatically triggers
 * a silent token refresh via GIS before returning.
 *
 * @returns {Promise<string | null>}
 */
export async function ensureValidAccessToken() {
  const currentToken = getValidAccessToken();
  if (currentToken) {
    return currentToken;
  }

  // If a session or profile exists, attempt silent refresh
  const stored = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  const profile = getAuthenticatedUserProfile();
  if (stored || profile || currentTokenRecord) {
    try {
      const refreshed = await refreshAccessToken();
      if (refreshed) return refreshed;
    } catch (err) {
      console.warn('[OpenDriveTeX] Silent token refresh attempt failed:', err);
    }
  }

  return null;
}

/**
 * Returns the cached authenticated Google user profile (`{ name, email, picture }`) if available.
 *
 * @returns {{ name: string, email: string, picture: string, sub?: string } | null}
 */
export function getAuthenticatedUserProfile() {
  if (currentUserProfile) {
    return currentUserProfile;
  }
  try {
    const raw = sessionStorage.getItem(USER_PROFILE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.name) {
        currentUserProfile = parsed;
        return currentUserProfile;
      }
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

/**
 * Fetches the authenticated user's real profile (`name`, `email`, `picture`) from
 * `https://www.googleapis.com/oauth2/v3/userinfo` using the OAuth 2.0 `access_token`.
 *
 * @param {string} accessToken - Active Google OAuth 2.0 Bearer token.
 * @returns {Promise<{ name: string, email: string, picture: string, sub?: string }>}
 */
export async function fetchGoogleUserProfile(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Google user profile (${response.status}).`);
  }

  const data = await response.json();
  const profile = {
    name: data.name || data.given_name || data.email || 'Authenticated Researcher',
    email: data.email || '',
    picture: data.picture || '',
    sub: data.sub || '',
  };

  currentUserProfile = profile;
  try {
    sessionStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Ignore storage errors
  }

  return profile;
}

/**
 * Checks whether the current token is a local simulation token used for offline testing.
 *
 * @returns {boolean}
 */
export function isSimulatedTokenActive() {
  getValidAccessToken();
  return Boolean(currentTokenRecord?.isSimulated);
}

/**
 * Activates a simulated OAuth token and user profile for local testing when offline.
 *
 * @returns {{ accessToken: string, expiresAt: number, isSimulated: boolean, userProfile: { name: string, email: string, picture: string } }}
 */
export function enableSimulatedDriveToken() {
  const suffix = Math.floor(10 + Math.random() * 90);
  const record = {
    accessToken: `sim_gis_token_${Math.random().toString(36).slice(2, 10)}`,
    expiresAt: Date.now() + 3600 * 1000,
    isSimulated: true,
  };
  const simProfile = {
    name: `Local Test User #${suffix}`,
    email: `researcher${suffix}@example.edu`,
    picture: '',
  };

  currentTokenRecord = record;
  currentUserProfile = simProfile;

  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(record));
    sessionStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(simProfile));

    const defaultFolderId = 'folder_quantum_paper_2026';
    if (!localStorage.getItem(`opendrivetex_sim_folder_meta_${defaultFolderId}`)) {
      const nowIso = new Date().toISOString();
      localStorage.setItem(
        `opendrivetex_sim_folder_meta_${defaultFolderId}`,
        JSON.stringify({
          id: defaultFolderId,
          name: 'Quantum-CRDT-Manuscript-Folder',
          mimeType: 'application/vnd.google-apps.folder',
          modifiedTime: nowIso,
        })
      );

      const sampleFolderFiles = [
        {
          id: 'sim_main_tex_1',
          name: 'main.tex',
          mimeType: 'text/x-tex',
          modifiedTime: nowIso,
          content: NEW_PROJECT_MAIN_TEX_TEMPLATE,
        },
        {
          id: 'sim_aux_bib_1',
          name: 'references.bib',
          mimeType: 'text/x-bibtex',
          modifiedTime: nowIso,
          content: DEFAULT_BIBTEX_CONTENT,
        },
      ];

      localStorage.setItem(
        `opendrivetex_sim_folder_files_${defaultFolderId}`,
        JSON.stringify(sampleFolderFiles)
      );
      localStorage.setItem(
        `opendrivetex_sim_drive_meta_sim_main_tex_1`,
        JSON.stringify({
          id: 'sim_main_tex_1',
          name: 'main.tex',
          mimeType: 'text/x-tex',
          modifiedTime: nowIso,
          parents: [defaultFolderId],
        })
      );
      localStorage.setItem(
        `opendrivetex_sim_drive_content_sim_main_tex_1`,
        NEW_PROJECT_MAIN_TEX_TEMPLATE
      );
    }
  } catch {
    // Ignore storage errors
  }

  return { ...record, userProfile: simProfile };
}

/**
 * Clears the stored OAuth 2.0 access token and user profile, revoking the token if applicable.
 */
export function signOutGoogleDrive() {
  const token = currentTokenRecord?.accessToken;
  const wasSimulated = currentTokenRecord?.isSimulated;
  currentTokenRecord = null;
  currentUserProfile = null;

  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(USER_PROFILE_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }

  if (token && !wasSimulated && typeof window !== 'undefined' && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(token, () => {});
    } catch {
      // Ignore revoke errors
    }
  }
}

/**
 * Initializes the Google Identity Services OAuth 2.0 Token Client with scopes
 * `'https://www.googleapis.com/auth/drive.file openid profile email'`, requests an
 * `access_token`, and immediately fetches `'https://www.googleapis.com/oauth2/v3/userinfo'`
 * to obtain the user's real Google name, email, and avatar picture.
 *
 * @param {Object} [options]
 * @param {string} [options.clientId] - Explicit Google OAuth Client ID override.
 * @param {string} [options.prompt=''] - GIS prompt mode (`''` or `'consent'`).
 * @returns {Promise<{
 *   accessToken: string,
 *   expiresAt: number,
 *   userProfile: { name: string, email: string, picture: string, sub?: string }
 * }>}
 */
export async function authenticateWithGoogleDrive(options = {}) {
  const resolvedClientId = options.clientId || getConfiguredGoogleClientId();
  if (!resolvedClientId) {
    throw new Error(
      'Missing Google OAuth Client ID. Set VITE_GOOGLE_CLIENT_ID in .env or configure it in the UI.'
    );
  }

  await loadGisClientScript();

  if (!window.google?.accounts?.oauth2?.initTokenClient) {
    throw new Error(
      'Google Identity Services (google.accounts.oauth2.initTokenClient) is unavailable.'
    );
  }

  return new Promise((resolve, reject) => {
    try {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: resolvedClientId,
        scope: GOOGLE_OAUTH_SCOPES,
        callback: async (tokenResponse) => {
          if (tokenResponse.error) {
            reject(
              new Error(
                tokenResponse.error_description ||
                  `Google OAuth Error: ${tokenResponse.error}`
              )
            );
            return;
          }

          const expiresInSec = Number(tokenResponse.expires_in) || 3599;
          const record = {
            accessToken: tokenResponse.access_token,
            expiresAt: Date.now() + (expiresInSec - 120) * 1000,
            isSimulated: false,
          };

          currentTokenRecord = record;
          try {
            sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(record));
          } catch {
            // Ignore storage errors
          }

          // Immediately fetch real Google user profile from /oauth2/v3/userinfo
          let userProfile = {
            name: 'Authenticated Researcher',
            email: '',
            picture: '',
          };
          try {
            userProfile = await fetchGoogleUserProfile(record.accessToken);
          } catch (profileErr) {
            console.warn('[OpenDriveTeX] Could not fetch userinfo profile:', profileErr);
          }

          resolve({
            ...record,
            userProfile,
          });
        },
        error_callback: (err) => {
          reject(
            new Error(err?.message || 'Google Identity Services popup was closed or blocked.')
          );
        },
      });

      tokenClient.requestAccessToken({
        prompt: options.prompt !== undefined ? options.prompt : '',
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================================
// Google Picker API Integration (Visual Folder & Shared File Selection)
// ============================================================================

/**
 * Opens the official Google Picker dialog (`google.picker.PickerBuilder`) configured with:
 *   1. "My Drive Folders & Files" view (`setIncludeFolders(true)`, `setSelectFolderEnabled(true)`).
 *   2. "Shared with me" view (`setOwnedByMe(false)`, `setIncludeFolders(true)`, `setSelectFolderEnabled(true)`)
 *      so collaborators can visually select shared folders or files, which automatically grants
 *      `drive.file` access to the selected items without 404 errors.
 *
 * @param {Object} [options]
 * @param {'folder' | 'files'} [options.mode='folder'] - Whether the user is picking a project folder or files.
 * @param {string} [options.parentFolderId] - Optional parent folder ID to scope file selection.
 * @returns {Promise<{
 *   action: 'picked' | 'cancel',
 *   items: Array<{ id: string, name: string, mimeType: string, parentId?: string }>
 * }>}
 */
export async function openGoogleDrivePicker(options = {}) {
  const { mode = 'folder', parentFolderId } = options;
  const token = (await ensureValidAccessToken()) || getValidAccessToken();
  if (!token) {
    throw new Error('Please sign in with Google first before opening the Google Drive Picker.');
  }

  // In local simulated OAuth mode, return the seeded simulated folder
  if (isSimulatedTokenActive()) {
    const folders = await listDriveProjectFolders(token);
    if (folders.length > 0) {
      return {
        action: 'picked',
        items: [
          {
            id: folders[0].id,
            name: folders[0].name,
            mimeType: 'application/vnd.google-apps.folder',
          },
        ],
      };
    }
    const created = await createDriveProjectFolder('Simulated-LaTeX-Project', token);
    return {
      action: 'picked',
      items: [
        {
          id: created.id,
          name: created.name,
          mimeType: 'application/vnd.google-apps.folder',
        },
      ],
    };
  }

  await loadGooglePickerApi();

  const googlePicker = window.google?.picker;
  if (!googlePicker?.PickerBuilder) {
    throw new Error('Google Picker API failed to initialize.');
  }

  const apiKey = getConfiguredGoogleApiKey();
  const appId = getGoogleAppIdFromClientId();

  return new Promise((resolve, reject) => {
    try {
      // View 1: Project Folder & Files View (configured with setIncludeFolders(true),
      // setSelectFolderEnabled(true), and all file types allowed so users can open their
      // project folder, press Ctrl+A to select main.tex, .bib, .sty, .cls, and figures/subfolders,
      // and authorize them in one step under the drive.file scope).
      const primaryDocsView = new googlePicker.DocsView(googlePicker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true);

      if (isValidDriveId(parentFolderId)) {
        primaryDocsView.setParent(parentFolderId.trim());
      }

      // View 2: All My Drive Folders & Files (unfiltered root navigation)
      const allMyDriveView = new googlePicker.DocsView(googlePicker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true);

      // View 3: "Shared with me" Folders & Files (Crucial for collaborators!)
      const sharedWithMeView = new googlePicker.DocsView(googlePicker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setOwnedByMe(false);

      let pickerTitle =
        'Open Folder or Select Project Files (Press Ctrl+A inside your folder to authorize all files)';
      if (mode === 'tex') {
        pickerTitle = 'Select main.tex from Google Drive';
      } else if (mode === 'missing_assets') {
        pickerTitle =
          'Authorize Missing Project Files (Navigate into subfolder, press Ctrl+A, click Select)';
      } else if (mode === 'files') {
        pickerTitle =
          'Authorize Project Files (Open your folder, press Ctrl+A to select main.tex & figures, and click Select)';
      }

      const builder = new googlePicker.PickerBuilder()
        .setTitle(pickerTitle)
        .setOAuthToken(token)
        .addView(primaryDocsView)
        .addView(allMyDriveView)
        .addView(sharedWithMeView)
        .enableFeature(googlePicker.Feature.MULTISELECT_ENABLED)
        .setOrigin(window.location.protocol + '//' + window.location.host)
        .setCallback((data) => {
          if (data[googlePicker.Response.ACTION] === googlePicker.Action.PICKED) {
            const docs = data[googlePicker.Response.DOCUMENTS] || [];
            const items = docs.map((doc) => ({
              id: doc[googlePicker.Document.ID],
              name: doc[googlePicker.Document.NAME],
              mimeType: doc[googlePicker.Document.MIME_TYPE],
              parentId: doc[googlePicker.Document.PARENT_ID],
            }));
            resolve({ action: 'picked', items });
          } else if (data[googlePicker.Response.ACTION] === googlePicker.Action.CANCEL) {
            resolve({ action: 'cancel', items: [] });
          }
        });

      if (apiKey) {
        builder.setDeveloperKey(apiKey);
      }
      if (appId) {
        builder.setAppId(appId);
      }

      const picker = builder.build();
      picker.setVisible(true);
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================================
// Google Drive REST API v3 Operations (Standard `fetch`)
// ============================================================================

/**
 * Checks whether a filename or MIME type represents an image asset
 * (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`).
 *
 * @param {string} [fileName='']
 * @param {string} [mimeType='']
 * @returns {boolean}
 */
export function isImageAssetFile(fileName = '', mimeType = '') {
  if (typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/')) {
    return true;
  }
  return /\.(png|jpe?g|gif|svg|webp)$/i.test(fileName || '');
}

/**
 * Infers the standard image MIME type from a filename or existing MIME string.
 *
 * @param {string} [fileName='']
 * @param {string} [fallbackMime='application/octet-stream']
 * @returns {string}
 */
export function inferImageMimeType(fileName = '', fallbackMime = 'application/octet-stream') {
  if (typeof fallbackMime === 'string' && fallbackMime.startsWith('image/')) {
    return fallbackMime;
  }
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.webp')) return 'image/webp';
  return fallbackMime || 'application/octet-stream';
}

/**
 * Normalizes any binary payload (Uint8Array, ArrayBuffer, TypedArray view,
 * base64 data URL, raw base64 string, or numeric key object { 0: ..., 1: ... })
 * into a genuine `Uint8Array`.
 *
 * @param {any} input
 * @returns {Uint8Array | null}
 */
export function normalizeBinaryContent(input) {
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
    // Check if raw base64 string
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
export function isValidPngHeader(bytes) {
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
 * Helper that builds standard Authorization and cache-busting headers for Google Drive REST API v3 requests.
 * Automatically ensures the access token is valid and unexpired before making requests.
 *
 * @param {string} [explicitToken] - Optional explicit access token.
 * @returns {Promise<{ token: string, headers: Record<string, string>, isSimulated: boolean }>}
 */
async function getAuthContext(explicitToken) {
  let token = explicitToken;
  if (!token) {
    token = (await ensureValidAccessToken()) || getValidAccessToken();
  }
  if (!token) {
    throw new Error('Not authenticated with Google Drive. Please connect your Google account first.');
  }

  return {
    token,
    isSimulated: Boolean(currentTokenRecord?.isSimulated && token.startsWith('sim_gis_token_')),
    headers: {
      Authorization: `Bearer ${token}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
    },
  };
}

/**
 * Executes a fetch request against the Google Drive API with automatic 401 token refresh retry.
 *
 * @param {string} url
 * @param {RequestInit} [options={}]
 * @param {string} [explicitToken]
 * @returns {Promise<Response>}
 */
async function driveFetchWithRetry(url, options = {}, explicitToken) {
  const auth = await getAuthContext(explicitToken);

  if (auth.isSimulated) {
    return fetch(url, options);
  }

  const mergedHeaders = {
    ...auth.headers,
    ...(options.headers || {}),
    Authorization: `Bearer ${auth.token}`,
  };

  let response = await fetch(url, {
    ...options,
    headers: mergedHeaders,
  });

  // If any Drive API call returns HTTP 401, automatically request a fresh token via GIS
  // and retry the failed request seamlessly.
  if (response.status === 401) {
    try {
      const freshToken = await refreshAccessToken();
      if (freshToken) {
        mergedHeaders.Authorization = `Bearer ${freshToken}`;
        response = await fetch(url, {
          ...options,
          headers: mergedHeaders,
        });
      }
    } catch (refreshErr) {
      console.warn('[OpenDriveTeX] Auto-retry on HTTP 401 failed:', refreshErr);
    }
  }

  return response;
}

/**
 * Fetches file or folder metadata from Google Drive REST API v3.
 * Supports shared drives (`supportsAllDrives=true`) and bypasses HTTP cache.
 *
 * @param {string} fileId - Google Drive file or folder identifier.
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<{ id: string, name: string, mimeType: string, modifiedTime: string, trashed?: boolean, parents?: string[] }>}
 */
export async function fetchDriveFileMetadata(fileId, accessToken) {
  if (!isValidDriveId(fileId)) {
    throw new Error(`Invalid Google Drive ID ("${fileId || ''}").`);
  }

  const cleanId = fileId.trim();
  const { isSimulated } = await getAuthContext(accessToken);

  if (isSimulated) {
    const simFolderMeta = localStorage.getItem(`opendrivetex_sim_folder_meta_${cleanId}`);
    if (simFolderMeta) {
      return JSON.parse(simFolderMeta);
    }
    const simMetaRaw = localStorage.getItem(`opendrivetex_sim_drive_meta_${cleanId}`);
    if (simMetaRaw) {
      return JSON.parse(simMetaRaw);
    }
    return {
      id: cleanId,
      name: `${cleanId}.tex`,
      mimeType: 'text/x-tex',
      modifiedTime: new Date().toISOString(),
      trashed: false,
    };
  }

  const url = `${DRIVE_API_BASE_URL}/${encodeURIComponent(
    cleanId
  )}?fields=id,name,mimeType,modifiedTime,trashed,parents&supportsAllDrives=true&_t=${Date.now()}`;

  const response = await driveFetchWithRetry(url, {
    method: 'GET',
    cache: 'no-store',
  }, accessToken);

  if (!response.ok) {
    if (response.status === 404) {
      const notFoundErr = new Error(
        'Google Drive returned 404 (File not found). Under the least-privilege "drive.file" scope, shared folders or files created outside OpenDriveTeX must be selected using the "Browse with Google Picker" button so Google grants access.'
      );
      notFoundErr.status = 404;
      throw notFoundErr;
    }
    const errText = await response.text().catch(() => '');
    const err = new Error(
      `Google Drive metadata GET failed (${response.status}): ${errText || response.statusText}`
    );
    err.status = response.status;
    throw err;
  }

  return response.json();
}

/**
 * Checks via `files.get` whether a Google Drive file still exists and is not in the trash.
 * Used during folder reconciliation to detect files deleted or trashed in Google Drive.
 *
 * @param {string} fileId - Google Drive file ID.
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<{ exists: boolean, trashed: boolean, status: number, metadata?: any }>}
 */
export async function checkDriveFileStatus(fileId, accessToken) {
  if (!isValidDriveId(fileId)) {
    return { exists: false, trashed: true, status: 400 };
  }

  const cleanId = fileId.trim();
  const { isSimulated } = await getAuthContext(accessToken);

  if (isSimulated) {
    const simMetaRaw = localStorage.getItem(`opendrivetex_sim_drive_meta_${cleanId}`);
    if (simMetaRaw) {
      const parsed = JSON.parse(simMetaRaw);
      return {
        exists: !parsed.trashed,
        trashed: Boolean(parsed.trashed),
        status: 200,
        metadata: parsed,
      };
    }
    return { exists: true, trashed: false, status: 200 };
  }

  const url = `${DRIVE_API_BASE_URL}/${encodeURIComponent(
    cleanId
  )}?fields=id,name,mimeType,modifiedTime,trashed&supportsAllDrives=true&_t=${Date.now()}`;

  try {
    const response = await driveFetchWithRetry(url, {
      method: 'GET',
      cache: 'no-store',
    }, accessToken);

    if (response.status === 404) {
      return { exists: false, trashed: true, status: 404 };
    }
    if (!response.ok) {
      return { exists: true, trashed: false, status: response.status };
    }

    const data = await response.json();
    return {
      exists: !data.trashed,
      trashed: Boolean(data.trashed),
      status: 200,
      metadata: data,
    };
  } catch {
    return { exists: true, trashed: false, status: 0 };
  }
}

/**
 * Moves a project file to the Google Drive trash (`PATCH /drive/v3/files/{fileId}` with `{ trashed: true }`).
 *
 * @param {string} fileId - Google Drive file ID to trash.
 * @param {string} [folderId] - Optional parent folder ID (used in simulated mode).
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<{ id: string, trashed: boolean }>}
 */
export async function trashDriveFile(fileId, folderId, accessToken) {
  if (!isValidDriveId(fileId)) {
    throw new Error('A valid Google Drive fileId is required to delete a file.');
  }

  const cleanId = fileId.trim();
  const { isSimulated } = await getAuthContext(accessToken);

  if (isSimulated) {
    localStorage.removeItem(`opendrivetex_sim_drive_meta_${cleanId}`);
    localStorage.removeItem(`opendrivetex_sim_drive_content_${cleanId}`);
    if (isValidDriveId(folderId)) {
      const folderKey = `opendrivetex_sim_folder_files_${folderId.trim()}`;
      const raw = localStorage.getItem(folderKey);
      if (raw) {
        const list = JSON.parse(raw).filter((f) => f.id !== cleanId);
        localStorage.setItem(folderKey, JSON.stringify(list));
      }
    }
    return { id: cleanId, trashed: true };
  }

  const url = `${DRIVE_API_BASE_URL}/${encodeURIComponent(
    cleanId
  )}?fields=id,name,trashed&supportsAllDrives=true`;

  const response = await driveFetchWithRetry(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ trashed: true }),
  }, accessToken);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const error = new Error(
      `Failed to delete file in Google Drive (${response.status}): ${errText || response.statusText}`
    );
    error.status = response.status;
    throw error;
  }

  return response.json();
}

/**
 * Fetches the raw `.tex` text content of a file from Google Drive REST API v3.
 *
 * @param {string} fileId - Google Drive file identifier.
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<string>} Raw UTF-8 text content of the `.tex` file.
 */
export async function fetchDriveFileContent(fileId, isBinaryOrAccessToken, explicitAccessToken) {
  if (!isValidDriveId(fileId)) {
    throw new Error(`Invalid Google Drive fileId ("${fileId || ''}").`);
  }

  const cleanId = fileId.trim();
  const isBinary = typeof isBinaryOrAccessToken === 'boolean' ? isBinaryOrAccessToken : false;
  const accessToken =
    typeof isBinaryOrAccessToken === 'string' ? isBinaryOrAccessToken : explicitAccessToken;

  const { isSimulated } = await getAuthContext(accessToken);

  if (isSimulated) {
    const simContent = localStorage.getItem(`opendrivetex_sim_drive_content_${cleanId}`);
    if (simContent !== null) {
      return simContent;
    }
    return isBinary ? new Uint8Array() : '';
  }

  const url = `${DRIVE_API_BASE_URL}/${encodeURIComponent(
    cleanId
  )}?alt=media&supportsAllDrives=true&_t=${Date.now()}`;

  const response = await driveFetchWithRetry(url, {
    method: 'GET',
    cache: 'no-store',
  }, accessToken);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `Google Drive content GET failed (${response.status}): ${errText || response.statusText}`
    );
  }

  if (isBinary) {
    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  return response.text();
}

/**
 * Updates an existing `.tex` file's content on Google Drive using a raw media `PATCH` request.
 *
 * @param {string} fileId - Google Drive file identifier.
 * @param {string} texContent - Full `.tex` manuscript content to persist.
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<{ id: string, name?: string, modifiedTime: string }>}
 */
export async function updateDriveFileContent(fileId, texContent, accessToken) {
  if (!isValidDriveId(fileId)) {
    throw new Error('A valid Google Drive fileId is required to save.');
  }

  const cleanId = fileId.trim();
  const { isSimulated } = await getAuthContext(accessToken);

  if (isSimulated) {
    const nowIso = new Date().toISOString();
    localStorage.setItem(`opendrivetex_sim_drive_content_${cleanId}`, texContent);
    const existingMetaRaw = localStorage.getItem(`opendrivetex_sim_drive_meta_${cleanId}`);
    const existingMeta = existingMetaRaw
      ? JSON.parse(existingMetaRaw)
      : { id: cleanId, name: 'main.tex' };
    const updatedMeta = { ...existingMeta, modifiedTime: nowIso };
    localStorage.setItem(`opendrivetex_sim_drive_meta_${cleanId}`, JSON.stringify(updatedMeta));
    return updatedMeta;
  }

  const url = `${DRIVE_UPLOAD_BASE_URL}/${encodeURIComponent(
    cleanId
  )}?uploadType=media&fields=id,name,modifiedTime&supportsAllDrives=true`;

  const response = await driveFetchWithRetry(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: typeof texContent === 'string' ? texContent : String(texContent ?? ''),
  }, accessToken);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const error = new Error(
      response.status === 404
        ? 'Please click main.tex in the Google Picker once to grant save permission to your account.'
        : `Google Drive PATCH failed (${response.status}): ${errText || response.statusText}`
    );
    error.status = response.status;
    throw error;
  }

  return response.json();
}

/**
 * Creates a brand-new `.tex` file in the user's Google Drive (optionally inside `folderId`),
 * uploads the initial LaTeX manuscript content, and returns its metadata (`id`, `name`, `modifiedTime`).
 *
 * @param {string} [fileName='main.tex'] - Desired file name in Google Drive.
 * @param {string} [initialTexContent=''] - Initial `.tex` content to write.
 * @param {string} [folderId] - Optional parent Google Drive folder ID.
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<{ id: string, name: string, mimeType: string, modifiedTime: string }>}
 */
export async function createDriveTexFile(
  fileName = 'main.tex',
  initialTexContent = NEW_PROJECT_MAIN_TEX_TEMPLATE,
  folderId,
  accessToken
) {
  const { token, isSimulated } = await getAuthContext(accessToken);
  const normalizedName = fileName.endsWith('.tex') ? fileName : `${fileName}.tex`;
  const validFolderId = isValidDriveId(folderId) ? folderId.trim() : undefined;

  if (isSimulated) {
    const simFileId = `drive_${Math.random().toString(36).slice(2, 11)}`;
    const nowIso = new Date().toISOString();
    const meta = {
      id: simFileId,
      name: normalizedName,
      mimeType: 'text/x-tex',
      modifiedTime: nowIso,
      parents: validFolderId ? [validFolderId] : undefined,
    };
    localStorage.setItem(`opendrivetex_sim_drive_meta_${simFileId}`, JSON.stringify(meta));
    localStorage.setItem(`opendrivetex_sim_drive_content_${simFileId}`, initialTexContent);

    if (validFolderId) {
      const folderFilesKey = `opendrivetex_sim_folder_files_${validFolderId}`;
      const existingRaw = localStorage.getItem(folderFilesKey);
      const existing = existingRaw ? JSON.parse(existingRaw) : [];
      existing.push({
        id: simFileId,
        name: normalizedName,
        mimeType: 'text/x-tex',
        modifiedTime: nowIso,
        content: initialTexContent,
      });
      localStorage.setItem(folderFilesKey, JSON.stringify(existing));
    }

    return meta;
  }

  const metadataBody = {
    name: normalizedName,
    mimeType: 'text/x-tex',
    description: 'Collaborative LaTeX manuscript managed by OpenDriveTeX',
  };
  if (validFolderId) {
    metadataBody.parents = [validFolderId];
  }

  const createResponse = await driveFetchWithRetry(
    `${DRIVE_API_BASE_URL}?fields=id,name,mimeType,modifiedTime,parents&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(metadataBody),
    },
    accessToken
  );

  if (!createResponse.ok) {
    const errText = await createResponse.text().catch(() => '');
    throw new Error(
      `Google Drive file creation failed (${createResponse.status}): ${
        errText || createResponse.statusText
      }`
    );
  }

  const createdMeta = await createResponse.json();

  if (initialTexContent) {
    const updated = await updateDriveFileContent(createdMeta.id, initialTexContent, token);
    return {
      ...createdMeta,
      ...updated,
    };
  }

  return createdMeta;
}

/**
 * Lists `.tex` files accessible to this app under the `drive.file` scope.
 *
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<Array<{ id: string, name: string, mimeType: string, modifiedTime: string }>>}
 */
export async function listDriveTexFiles(accessToken) {
  const { isSimulated } = await getAuthContext(accessToken);

  if (isSimulated) {
    const files = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith('opendrivetex_sim_drive_meta_')) {
        try {
          files.push(JSON.parse(localStorage.getItem(key)));
        } catch {
          // Ignore malformed entries
        }
      }
    }
    return files.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  }

  const query = encodeURIComponent(
    "trashed = false and (name contains '.tex' or mimeType = 'text/x-tex')"
  );
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,parents)');
  const url = `${DRIVE_API_BASE_URL}?q=${query}&fields=${fields}&orderBy=modifiedTime desc&pageSize=20&supportsAllDrives=true&includeItemsFromAllDrives=true`;

  const response = await driveFetchWithRetry(url, {
    method: 'GET',
    cache: 'no-store',
  }, accessToken);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `Google Drive file list failed (${response.status}): ${errText || response.statusText}`
    );
  }

  const data = await response.json();
  return Array.isArray(data.files) ? data.files : [];
}

/**
 * Lists Google Drive folders accessible under the `drive.file` scope.
 *
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<Array<{ id: string, name: string, modifiedTime: string }>>}
 */
export async function listDriveProjectFolders(accessToken) {
  const { isSimulated } = await getAuthContext(accessToken);

  if (isSimulated) {
    const folders = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith('opendrivetex_sim_folder_meta_')) {
        try {
          folders.push(JSON.parse(localStorage.getItem(key)));
        } catch {
          // Ignore malformed entries
        }
      }
    }
    return folders.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  }

  const query = encodeURIComponent(
    "trashed = false and mimeType = 'application/vnd.google-apps.folder'"
  );
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime)');
  const url = `${DRIVE_API_BASE_URL}?q=${query}&fields=${fields}&orderBy=modifiedTime desc&pageSize=25&supportsAllDrives=true&includeItemsFromAllDrives=true`;

  const response = await driveFetchWithRetry(url, {
    method: 'GET',
    cache: 'no-store',
  }, accessToken);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `Google Drive folder list failed (${response.status}): ${errText || response.statusText}`
    );
  }

  const data = await response.json();
  return Array.isArray(data.files) ? data.files : [];
}

/**
 * Creates a new Google Drive project folder (`application/vnd.google-apps.folder`),
 * seeds it with a starter `main.tex` and `references.bib`, and returns its metadata.
 *
 * @param {string} folderName - Desired project folder name.
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<{ id: string, name: string, modifiedTime: string, mainTexFile?: { id: string, name: string } }>}
 */
export async function createDriveProjectFolder(folderName = 'LaTeX-Project', accessToken) {
  const { token, isSimulated } = await getAuthContext(accessToken);
  const cleanName = (folderName || 'LaTeX-Project').trim();

  if (isSimulated) {
    const folderId = `folder_${Math.random().toString(36).slice(2, 10)}`;
    const mainFileId = `drive_${Math.random().toString(36).slice(2, 10)}`;
    const nowIso = new Date().toISOString();
    const folderMeta = {
      id: folderId,
      name: cleanName,
      mimeType: 'application/vnd.google-apps.folder',
      modifiedTime: nowIso,
    };
    localStorage.setItem(`opendrivetex_sim_folder_meta_${folderId}`, JSON.stringify(folderMeta));
    localStorage.setItem(
      `opendrivetex_sim_drive_meta_${mainFileId}`,
      JSON.stringify({
        id: mainFileId,
        name: 'main.tex',
        mimeType: 'text/x-tex',
        modifiedTime: nowIso,
        parents: [folderId],
      })
    );
    localStorage.setItem(
      `opendrivetex_sim_drive_content_${mainFileId}`,
      NEW_PROJECT_MAIN_TEX_TEMPLATE
    );
    localStorage.setItem(
      `opendrivetex_sim_folder_files_${folderId}`,
      JSON.stringify([
        {
          id: mainFileId,
          name: 'main.tex',
          mimeType: 'text/x-tex',
          modifiedTime: nowIso,
          content: NEW_PROJECT_MAIN_TEX_TEMPLATE,
        },
        {
          id: `sim_bib_${Date.now()}`,
          name: 'references.bib',
          mimeType: 'text/x-bibtex',
          modifiedTime: nowIso,
          content: DEFAULT_BIBTEX_CONTENT,
        },
      ])
    );
    return { ...folderMeta, mainTexFile: { id: mainFileId, name: 'main.tex' } };
  }

  const createResponse = await driveFetchWithRetry(
    `${DRIVE_API_BASE_URL}?fields=id,name,mimeType,modifiedTime&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        name: cleanName,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    },
    accessToken
  );

  if (!createResponse.ok) {
    const errText = await createResponse.text().catch(() => '');
    throw new Error(
      `Google Drive folder creation failed (${createResponse.status}): ${
        errText || createResponse.statusText
      }`
    );
  }

  const folderMeta = await createResponse.json();

  // Create starter main.tex and references.bib inside the newly created folder
  const [mainTexFile] = await Promise.all([
    createDriveTexFile('main.tex', NEW_PROJECT_MAIN_TEX_TEMPLATE, folderMeta.id, token),
    uploadAuxFileToDriveFolder({
      folderId: folderMeta.id,
      fileName: 'references.bib',
      content: DEFAULT_BIBTEX_CONTENT,
      mimeType: 'text/plain',
      accessToken: token,
    }).catch(() => null),
  ]);

  return {
    ...folderMeta,
    mainTexFile,
  };
}

/**
 * Creates a new subfolder in Google Drive inside `parentFolderId`.
 * Since it is created by OpenDriveTeX, the least-privilege `drive.file` scope
 * automatically authorizes read and write access without requiring Google Picker.
 *
 * @param {string} folderName - Subfolder name (e.g. `'output_figures'`).
 * @param {string} parentFolderId - Parent project folder ID.
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<{ id: string, name: string, mimeType: string, modifiedTime: string }>}
 */
export async function createDriveSubfolder(folderName = 'subfolder', parentFolderId, accessToken) {
  const { isSimulated } = await getAuthContext(accessToken);
  const cleanName = (folderName || 'subfolder').replace(/[\\/]/g, '').trim();
  const validParentId = isValidDriveId(parentFolderId) ? parentFolderId.trim() : undefined;

  if (isSimulated) {
    const subId = `sim_sub_${Math.random().toString(36).slice(2, 10)}`;
    const nowIso = new Date().toISOString();
    const folderMeta = {
      id: subId,
      name: cleanName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: validParentId ? [validParentId] : [],
      modifiedTime: nowIso,
    };
    localStorage.setItem(`opendrivetex_sim_folder_meta_${subId}`, JSON.stringify(folderMeta));
    return folderMeta;
  }

  const metaBody = {
    name: cleanName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (validParentId) {
    metaBody.parents = [validParentId];
  }

  const response = await driveFetchWithRetry(
    `${DRIVE_API_BASE_URL}?fields=id,name,mimeType,modifiedTime,parents&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(metaBody),
    },
    accessToken
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `Failed to create subfolder "${cleanName}" in Drive (${response.status}): ${
        errText || response.statusText
      }`
    );
  }

  return response.json();
}

/**
 * Finds or creates a subfolder hierarchy (e.g., `'output_figures'`) inside a parent folder.
 *
 * @param {string} parentFolderId - Top-level Google Drive project folder ID.
 * @param {string} relativePath - Folder path segment (e.g. `'output_figures'`).
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<string>} The target Google Drive folder ID.
 */
export async function getOrCreateDriveSubfolderPath(parentFolderId, relativePath, accessToken) {
  if (!isValidDriveId(parentFolderId)) {
    return parentFolderId;
  }
  const cleanPath = (relativePath || '').replace(/^\/+|\/+$/g, '').trim();
  if (!cleanPath) {
    return parentFolderId;
  }

  const parts = cleanPath.split('/').filter(Boolean);
  let currentParentId = parentFolderId.trim();

  for (const part of parts) {
    const cleanPart = part.trim();
    if (!cleanPart) continue;

    // Check if subfolder already exists inside current parent
    try {
      const files = await listAndFetchDriveFolderFiles(currentParentId, accessToken);
      const existing = files.find(
        (f) =>
          f.name === cleanPart &&
          (f.mimeType === 'application/vnd.google-apps.folder' || f.isFolder)
      );
      if (existing?.id) {
        currentParentId = existing.id;
        continue;
      }
    } catch {
      // If listing fails, proceed to create
    }

    const created = await createDriveSubfolder(cleanPart, currentParentId, accessToken);
    currentParentId = created.id;
  }

  return currentParentId;
}

/**
 * Fetches a list of specific Drive files by their IDs (used when a user multi-selects
 * files via Google Picker or opens files via `?state=`).
 *
 * Automatically inspects `parentId` and folder hierarchy:
 * - If a subfolder (like `output_figures`) was selected, crawls files inside it.
 * - If files belong to a subfolder, resolves the parent folder name so their relative
 *   path is preserved (e.g. `output_figures/fig1.png`).
 *
 * @param {Array<{ id: string, name?: string, mimeType?: string, parentId?: string }>} fileDescriptors
 * @param {string} [accessToken]
 * @param {string} [rootFolderId] - Optional canonical project folder ID to determine relative subfolder paths.
 */
export async function fetchMultipleDriveFilesById(fileDescriptors, accessToken, rootFolderId) {
  const { isSimulated } = await getAuthContext(accessToken);
  const validDescriptors = (fileDescriptors || []).filter((d) => isValidDriveId(d?.id));

  // Build a folder name map from any folder items in the selection
  const folderNameMap = new Map();
  const folderItems = [];
  const fileItems = [];

  for (const desc of validDescriptors) {
    if (desc.mimeType === 'application/vnd.google-apps.folder') {
      folderItems.push(desc);
      if (desc.id && desc.name) {
        folderNameMap.set(desc.id.trim(), desc.name.trim());
      }
    } else {
      fileItems.push(desc);
    }
  }

  // Pre-fetch names for any unknown parentIds that differ from the root project folder
  const cleanRootId = isValidDriveId(rootFolderId) ? rootFolderId.trim() : null;
  const unknownParentIds = new Set();
  for (const file of fileItems) {
    const pId = file.parentId ? file.parentId.trim() : null;
    if (pId && pId !== cleanRootId && !folderNameMap.has(pId) && isValidDriveId(pId)) {
      unknownParentIds.add(pId);
    }
  }

  await Promise.all(
    Array.from(unknownParentIds).map(async (pId) => {
      try {
        const meta = await fetchDriveFileMetadata(pId, accessToken);
        if (meta?.name) {
          folderNameMap.set(pId, meta.name.trim());
        }
      } catch {
        // Fallback: ignore parent name resolution failure
      }
    })
  );

  // If subfolders were picked directly (e.g., user selected the folder 'output_figures'),
  // crawl all files inside each subfolder so they are authorized and hydrated
  const subfolderFetchedFiles = [];
  for (const folder of folderItems) {
    // If the picked folder is the root project folder itself, don't crawl it here (handled separately)
    if (cleanRootId && folder.id === cleanRootId) continue;
    try {
      const children = await listAndFetchDriveFolderFiles(folder.id, accessToken);
      const subfolderName = folder.name || 'subfolder';
      for (const child of children) {
        if (child.mimeType === 'application/vnd.google-apps.folder' || child.isFolder) continue;
        const childRelPath = child.path.startsWith(`${subfolderName}/`)
          ? child.path
          : `${subfolderName}/${child.name}`;
        subfolderFetchedFiles.push({
          ...child,
          path: childRelPath,
          parentId: folder.id,
        });
      }
    } catch {
      // Subfolder listing might be empty under drive.file; continue
    }
  }

  const fetchedFiles = await Promise.all(
    fileItems.map(async (desc) => {
      const cleanId = desc.id.trim();
      try {
        const meta =
          desc.name && desc.mimeType
            ? desc
            : await fetchDriveFileMetadata(cleanId, accessToken);

        if (meta.mimeType === 'application/vnd.google-apps.folder') {
          return null;
        }

        const pId = meta.parentId || (Array.isArray(meta.parents) ? meta.parents[0] : null);
        let resolvedPath = meta.name;
        if (pId && pId !== cleanRootId && folderNameMap.has(pId)) {
          resolvedPath = `${folderNameMap.get(pId)}/${meta.name}`;
        }

        const mediaUrl = `${DRIVE_API_BASE_URL}/${encodeURIComponent(
          cleanId
        )}?alt=media&supportsAllDrives=true&_t=${Date.now()}`;
        const mediaResp = await driveFetchWithRetry(mediaUrl, {
          method: 'GET',
          cache: 'no-store',
        }, accessToken);
        if (!mediaResp.ok) {
          return { ...meta, path: resolvedPath, content: '' };
        }

        const isBinaryImage =
          isImageAssetFile(meta.name, meta.mimeType) || /\.(pdf|eps)$/i.test(meta.name);

        if (isBinaryImage) {
          const arrayBuffer = await mediaResp.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          return {
            ...meta,
            mimeType: inferImageMimeType(meta.name, meta.mimeType),
            size: Number(meta.size) || bytes.byteLength,
            path: resolvedPath,
            content: bytes,
          };
        }

        const textContent = await mediaResp.text();
        return {
          ...meta,
          size: Number(meta.size) || textContent.length,
          path: resolvedPath,
          content: textContent,
        };
      } catch {
        return null;
      }
    })
  );

  const combined = [...fetchedFiles.filter(Boolean), ...subfolderFetchedFiles];
  // Deduplicate by path or id
  const dedupMap = new Map();
  for (const item of combined) {
    const key = item.path || item.id;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, item);
    }
  }

  return Array.from(dedupMap.values());
}

/**
 * Lists all files (`.tex`, `.bib`, `.sty`, `.cls`, figures) inside a selected Google Drive folder,
 * and fetches their contents so the main `.tex` file can be loaded into Yjs and auxiliary files
 * into the Web Worker's virtual file system (MEMFS).
 *
 * Strictly validates `folderId` so `'.'` is never sent to the Google Drive API, and adds
 * `Cache-Control: no-cache` + timestamp query parameters to bypass browser HTTP caching.
 *
 * @param {string} folderId - Google Drive folder ID.
 * @param {string} [accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<Array<{
 *   id: string,
 *   name: string,
 *   path: string,
 *   mimeType: string,
 *   modifiedTime: string,
 *   size?: number,
 *   content: string | Uint8Array
 * }>>}
 */
export async function listAndFetchDriveFolderFiles(folderId, accessToken) {
  if (!isValidDriveId(folderId)) {
    throw new Error(`Invalid Google Drive folderId ("${folderId || ''}").`);
  }

  const cleanFolderId = folderId.trim();
  const { isSimulated } = await getAuthContext(accessToken);

  if (isSimulated) {
    const rawList = localStorage.getItem(`opendrivetex_sim_folder_files_${cleanFolderId}`);
    const parsedList = rawList ? JSON.parse(rawList) : [];
    return parsedList.map((item) => ({
      ...item,
      path: item.name,
    }));
  }

  const query = encodeURIComponent(`'${cleanFolderId}' in parents and trashed = false`);
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,size,trashed)');
  const url = `${DRIVE_API_BASE_URL}?q=${query}&fields=${fields}&orderBy=name&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true&_t=${Date.now()}`;

  const response = await driveFetchWithRetry(url, {
    method: 'GET',
    cache: 'no-store',
  }, accessToken);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `Failed to list files in Drive folder (${response.status}): ${
        errText || response.statusText
      }`
    );
  }

  const data = await response.json();
  const files = (Array.isArray(data.files) ? data.files : []).filter((f) => !f.trashed);

  const hydratedFiles = await Promise.all(
    files.map(async (file) => {
      const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
      if (isFolder) {
        return {
          ...file,
          isFolder: true,
          path: file.name,
          content: '',
        };
      }

      try {
        const mediaUrl = `${DRIVE_API_BASE_URL}/${encodeURIComponent(
          file.id
        )}?alt=media&supportsAllDrives=true&_t=${Date.now()}`;
        const mediaResp = await driveFetchWithRetry(mediaUrl, {
          method: 'GET',
          cache: 'no-store',
        }, accessToken);
        if (!mediaResp.ok) {
          return { ...file, path: file.name, content: '' };
        }

        const isBinaryImage =
          isImageAssetFile(file.name, file.mimeType) || /\.(pdf|eps)$/i.test(file.name);

        if (isBinaryImage) {
          const arrayBuffer = await mediaResp.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          return {
            ...file,
            mimeType: inferImageMimeType(file.name, file.mimeType),
            size: Number(file.size) || bytes.byteLength,
            path: file.name,
            content: bytes,
          };
        }

        const textContent = await mediaResp.text();
        return {
          ...file,
          size: Number(file.size) || textContent.length,
          path: file.name,
          content: textContent,
        };
      } catch {
        return { ...file, path: file.name, content: '' };
      }
    })
  );

  // Requirement 2: Whenever a child item in the root folder is a folder (e.g. output_figures),
  // recursively query `files.list` with `'${subfolder.id}' in parents and trashed = false`
  // so already-authorized images inside output_figures/ are automatically loaded on Sync or page reload.
  const subfolderItems = files.filter(
    (f) => f.mimeType === 'application/vnd.google-apps.folder' || f.isFolder
  );

  const nestedFiles = [];
  for (const subfolder of subfolderItems) {
    if (!isValidDriveId(subfolder.id)) continue;
    try {
      const subQuery = encodeURIComponent(`'${subfolder.id.trim()}' in parents and trashed = false`);
      const subUrl = `${DRIVE_API_BASE_URL}?q=${subQuery}&fields=${fields}&orderBy=name&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true&_t=${Date.now()}`;
      const subResp = await driveFetchWithRetry(subUrl, {
        method: 'GET',
        cache: 'no-store',
      }, accessToken);
      if (subResp.ok) {
        const subData = await subResp.json();
        const subChildren = (Array.isArray(subData.files) ? subData.files : []).filter((f) => !f.trashed);

        const subHydrated = await Promise.all(
          subChildren.map(async (child) => {
            if (child.mimeType === 'application/vnd.google-apps.folder') return null;
            const subfolderName = (subfolder.name || 'subfolder').trim();
            const childRelPath = `${subfolderName}/${child.name.trim()}`;
            try {
              const mediaUrl = `${DRIVE_API_BASE_URL}/${encodeURIComponent(
                child.id
              )}?alt=media&supportsAllDrives=true&_t=${Date.now()}`;
              const mediaResp = await driveFetchWithRetry(mediaUrl, {
                method: 'GET',
                cache: 'no-store',
              }, accessToken);
              if (!mediaResp.ok) {
                return { ...child, path: childRelPath, parentId: subfolder.id, content: '' };
              }

              const isBinaryImage =
                isImageAssetFile(child.name, child.mimeType) || /\.(pdf|eps)$/i.test(child.name);

              if (isBinaryImage) {
                const arrayBuffer = await mediaResp.arrayBuffer();
                const bytes = new Uint8Array(arrayBuffer);
                return {
                  ...child,
                  mimeType: inferImageMimeType(child.name, child.mimeType),
                  size: Number(child.size) || bytes.byteLength,
                  path: childRelPath,
                  parentId: subfolder.id,
                  content: bytes,
                };
              }

              const textContent = await mediaResp.text();
              return {
                ...child,
                size: Number(child.size) || textContent.length,
                path: childRelPath,
                parentId: subfolder.id,
                content: textContent,
              };
            } catch {
              return { ...child, path: childRelPath, parentId: subfolder.id, content: '' };
            }
          })
        );
        nestedFiles.push(...subHydrated.filter(Boolean));
      }
    } catch {
      // Ignore subfolder listing errors under drive.file
    }
  }

  return [...hydratedFiles, ...nestedFiles];
}

/**
 * Uploads or updates an auxiliary file (`.bib`, `.sty`, `.cls`, or image) inside a Google Drive folder.
 * Strictly strips any leading `./` or `.` path segments before sending to Google Drive.
 *
 * @param {Object} params
 * @param {string} params.folderId - Target Google Drive folder ID.
 * @param {string} params.fileName - File name (e.g. `'references.bib'` or `'plot.png'`).
 * @param {string | Uint8Array | ArrayBuffer} params.content - File content.
 * @param {string} [params.mimeType='application/octet-stream'] - File MIME type.
 * @param {string} [params.accessToken] - OAuth 2.0 Bearer token.
 * @returns {Promise<{ id: string, name: string, path: string, mimeType: string, modifiedTime: string }>}
 */
export async function uploadAuxFileToDriveFolder({
  folderId,
  fileName,
  content,
  mimeType = 'application/octet-stream',
  accessToken,
}) {
  const { isSimulated } = await getAuthContext(accessToken);
  const validFolderId = isValidDriveId(folderId) ? folderId.trim() : undefined;
  const cleanFileName = (fileName || 'asset.dat').replace(/^\.+\//, '').trim();

  // If the path contains subfolders (e.g. output_figures/fig1.png), resolve the leaf file name
  // and ensure the subfolder hierarchy exists in Google Drive
  let targetFolderId = validFolderId;
  let leafFileName = cleanFileName;

  if (cleanFileName.includes('/')) {
    const parts = cleanFileName.split('/');
    leafFileName = parts.pop();
    const subfolderRelPath = parts.join('/');
    if (validFolderId && !isSimulated) {
      targetFolderId = await getOrCreateDriveSubfolderPath(validFolderId, subfolderRelPath, accessToken);
    }
  }

  if (isSimulated && validFolderId) {
    const key = `opendrivetex_sim_folder_files_${validFolderId}`;
    const existingRaw = localStorage.getItem(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];
    const nowIso = new Date().toISOString();

    const serializedContent =
      content instanceof Uint8Array
        ? `BINARY_IMAGE_${cleanFileName}_${content.byteLength}_BYTES`
        : typeof content === 'string'
        ? content
        : 'BINARY_ASSET';

    const existingIdx = existing.findIndex((f) => f.path === cleanFileName || f.name === cleanFileName);
    const record = {
      id: existingIdx >= 0 ? existing[existingIdx].id : `sim_aux_${Date.now()}`,
      name: leafFileName,
      path: cleanFileName,
      mimeType,
      modifiedTime: nowIso,
      content: serializedContent,
    };

    if (existingIdx >= 0) {
      existing[existingIdx] = record;
    } else {
      existing.push(record);
    }

    localStorage.setItem(key, JSON.stringify(existing));
    return record;
  }

  // 1. Create file metadata inside target parent/subfolder
  const metaBody = {
    name: leafFileName,
    mimeType,
  };
  if (targetFolderId) {
    metaBody.parents = [targetFolderId];
  }

  const metaResponse = await driveFetchWithRetry(
    `${DRIVE_API_BASE_URL}?fields=id,name,mimeType,modifiedTime&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(metaBody),
    },
    accessToken
  );

  if (!metaResponse.ok) {
    const errText = await metaResponse.text().catch(() => '');
    throw new Error(`Failed to create auxiliary file metadata (${metaResponse.status}): ${errText}`);
  }

  const createdMeta = await metaResponse.json();

  // 2. Upload file content via media PATCH
  const uploadUrl = `${DRIVE_UPLOAD_BASE_URL}/${encodeURIComponent(
    createdMeta.id
  )}?uploadType=media&fields=id,name,mimeType,modifiedTime&supportsAllDrives=true`;

  const uploadResponse = await driveFetchWithRetry(
    uploadUrl,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': mimeType,
      },
      body: content,
    },
    accessToken
  );

  if (!uploadResponse.ok) {
    const errText = await uploadResponse.text().catch(() => '');
    throw new Error(`Failed to upload auxiliary file media (${uploadResponse.status}): ${errText}`);
  }

  const finalMeta = await uploadResponse.json();
  return {
    ...finalMeta,
    name: leafFileName,
    path: cleanFileName,
  };
}

// ============================================================================
// Mandate 2: Smart .tex Dependency Scanner & Asset Matching
// ============================================================================

/**
 * Scans a LaTeX source string for external file dependencies:
 * - \graphicspath{{dir1/}{dir2/}}
 * - \includegraphics[...]{path}
 * - \bibliography{...} and \addbibresource{...}
 * - \input{...} and \include{...}
 * - \documentclass[...]{name} (for custom classes like elsarticle.cls)
 * - \usepackage[...]{name} (for local .sty packages)
 *
 * @param {string} texSource - Raw .tex document text.
 * @returns {Array<{ type: string, rawPath: string, relativePath: string, candidates: string[] }>}
 */
export function scanTexDependencies(texSource) {
  if (!texSource || typeof texSource !== 'string') return [];

  // Strip LaTeX comments (% ...) to avoid false positives
  const cleanSource = texSource
    .split('\n')
    .map((line) => {
      let escaped = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') {
          escaped = !escaped;
        } else if (line[i] === '%' && !escaped) {
          return line.slice(0, i);
        } else {
          escaped = false;
        }
      }
      return line;
    })
    .join('\n');

  const dependencies = [];
  const seenPaths = new Set();

  const addDep = (type, rawPath, defaultExt = '') => {
    let clean = rawPath.replace(/^\.+\//, '').replace(/\\/g, '/').trim();
    if (!clean) return;

    const candidates = [];
    candidates.push(clean);

    if (defaultExt && !clean.includes('.')) {
      candidates.push(`${clean}${defaultExt}`);
      clean = `${clean}${defaultExt}`;
    }

    if (!clean.includes('.')) {
      if (type === 'image') {
        candidates.push(
          `${clean}.png`,
          `${clean}.jpg`,
          `${clean}.jpeg`,
          `${clean}.pdf`,
          `${clean}.eps`
        );
      } else if (type === 'bib') {
        candidates.push(`${clean}.bib`);
      } else if (type === 'tex') {
        candidates.push(`${clean}.tex`);
      } else if (type === 'class') {
        candidates.push(`${clean}.cls`);
      } else if (type === 'package') {
        candidates.push(`${clean}.sty`);
      }
    }

    if (!seenPaths.has(clean)) {
      seenPaths.add(clean);
      dependencies.push({
        type,
        rawPath,
        relativePath: clean,
        candidates,
      });
    }
  };

  // 1. Parse \graphicspath{{dir1/}{dir2/}}
  const graphicDirs = [];
  const gpRegex = /\\graphicspath\s*\{((?:\{[^}]*\}\s*)+)\}/g;
  let gpMatch;
  while ((gpMatch = gpRegex.exec(cleanSource)) !== null) {
    const inner = gpMatch[1];
    const dirRegex = /\{([^}]+)\}/g;
    let dirMatch;
    while ((dirMatch = dirRegex.exec(inner)) !== null) {
      let d = dirMatch[1].replace(/^\.+\//, '').replace(/\\/g, '/').trim();
      if (d && !d.endsWith('/')) d += '/';
      if (d) graphicDirs.push(d);
    }
  }

  // 2. Parse \includegraphics[...]{path}
  const incRegex = /\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g;
  let incMatch;
  while ((incMatch = incRegex.exec(cleanSource)) !== null) {
    const raw = incMatch[1].trim();
    addDep('image', raw);
    for (const gDir of graphicDirs) {
      if (!raw.startsWith(gDir)) {
        addDep('image', `${gDir}${raw}`);
      }
    }
  }

  // 3. Parse \bibliography{...} and \addbibresource{...}
  const bibRegex = /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  let bibMatch;
  while ((bibMatch = bibRegex.exec(cleanSource)) !== null) {
    const paths = bibMatch[1].split(',');
    for (const p of paths) {
      addDep('bib', p.trim(), '.bib');
    }
  }

  // 4. Parse \input{...} and \include{...}
  const inputRegex = /\\(?:input|include)\s*\{([^}]+)\}/g;
  let inMatch;
  while ((inMatch = inputRegex.exec(cleanSource)) !== null) {
    addDep('tex', inMatch[1].trim(), '.tex');
  }

  // 5. Parse \documentclass[...]{cls}
  const docClassRegex = /\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/;
  const docClassMatch = docClassRegex.exec(cleanSource);
  if (docClassMatch) {
    const clsName = docClassMatch[1].trim();
    const standardClasses = new Set([
      'article',
      'report',
      'book',
      'letter',
      'slides',
      'proc',
      'minimal',
      'beamer',
      'standalone',
    ]);
    if (!standardClasses.has(clsName.toLowerCase())) {
      addDep('class', `${clsName}.cls`);
    }
  }

  return dependencies;
}

/**
 * Matches Google Drive picker documents against missing project dependencies.
 * If a user picked `fig1.png` inside subfolder `output_figures`, maps it to
 * the full relative path `output_figures/fig1.png` expected by the .tex file.
 *
 * @param {Array<{ id: string, name: string, mimeType: string, parentId?: string }>} pickedDocs
 * @param {Array<{ relativePath: string, candidates?: string[] }>} missingDependencies
 * @returns {Array<{ id: string, name: string, relativePath: string, mimeType: string }>}
 */
export function matchPickedFilesToDependencies(pickedDocs, missingDependencies) {
  if (!Array.isArray(pickedDocs)) return [];
  const missingList = Array.isArray(missingDependencies) ? missingDependencies : [];

  return pickedDocs.map((doc) => {
    const docName = (doc.name || '').trim();
    const docNameWithoutExt = docName.replace(/\.[^/.]+$/, '');

    // 1. Check if any missing dependency has a candidate matching docName
    const matched = missingList.find((dep) => {
      const depRelPath = dep.relativePath || '';
      const depBase = depRelPath.split('/').pop() || '';
      const depBaseWithoutExt = depBase.replace(/\.[^/.]+$/, '');

      if (depRelPath === docName) return true;
      if (depBase === docName) return true;
      if (depBaseWithoutExt === docNameWithoutExt) return true;

      if (Array.isArray(dep.candidates)) {
        return dep.candidates.some((c) => {
          const cBase = c.split('/').pop() || '';
          return c === docName || cBase === docName;
        });
      }

      return false;
    });

    const targetRelativePath = matched
      ? matched.relativePath
      : doc.path || docName;

    return {
      id: doc.id,
      name: docName,
      relativePath: targetRelativePath,
      mimeType: doc.mimeType,
      parentId: doc.parentId,
    };
  });
}

