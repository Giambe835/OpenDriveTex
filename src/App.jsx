/**
 * @fileoverview Main Application Layout for OpenDriveTeX.
 * Coordinates:
 *   1. Folder-First Workspace Startup: Shows a clean "Welcome / Open Drive Folder" screen
 *      until the user connects Google Drive and selects or creates a project folder.
 *   2. Real Google User Profile: Fetches `https://www.googleapis.com/oauth2/v3/userinfo`
 *      after GIS OAuth2 login and broadcasts the user's real `name`, `email`, and `picture`
 *      in Yjs Awareness.
 *   3. Google Picker API (`openGoogleDrivePicker`) for visual folder & "Shared with me"
 *      selection (preventing 404 errors under the `drive.file` scope).
 *   4. Google Drive `?state=` ("Open With" UI integration) automatic detection and loading.
 *   5. Dedicated Web Worker (`src/workers/latex.worker.js`) with MEMFS for `.bib`, `.sty`,
 *      `.cls`, and figure compilation.
 *
 * CRITICAL ARCHITECTURAL INVARIANT (Rule #2):
 * The editor text buffer is NEVER stored in React `useState`. Both compilation,
 * local exports, and Google Drive saves read `collabSession.ytext.toString()` on-demand.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FolderSearch,
  FolderPlus,
  HardDrive,
  Sparkles,
  ShieldCheck,
  Users,
  Cpu,
  Loader2,
  FolderOpen,
  AlertCircle,
  CheckCircle2,
  FileCode,
} from 'lucide-react';
import { openSearchPanel } from '@codemirror/search';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';
import EditorPane from './components/EditorPane';
import PdfPreview from './components/PdfPreview';
import PreFlightModal from './components/PreFlightModal';
import {
  countReviewItems,
  scanReviewItems,
  sanitizeTexForSubmission,
  createCleanSubmissionZipBlob,
  triggerFileDownload,
} from './utils/reviewMacroUtils';
import {
  createCollabSession,
  getDeterministicRoomName,
  getRoomFromUrlHash,
  setRoomInUrlHash,
} from './services/collabService';
import {
  NEW_PROJECT_MAIN_TEX_TEMPLATE,
  authenticateWithGoogleDrive,
  checkDriveFileStatus,
  createDriveProjectFolder,
  createDriveSubfolder,
  createDriveTexFile,
  fetchDriveFileContent,
  fetchDriveFileMetadata,
  fetchGoogleUserProfile,
  fetchMultipleDriveFilesById,
  getAuthenticatedUserProfile,
  getValidAccessToken,
  inferImageMimeType,
  isImageAssetFile,
  isSimulatedTokenActive,
  isValidDriveId,
  isValidPngHeader,
  listAndFetchDriveFolderFiles,
  listDriveProjectFolders,
  listDriveTexFiles,
  matchPickedFilesToDependencies,
  normalizeBinaryContent,
  openGoogleDrivePicker,
  parseDriveOpenWithStateFromUrl,
  clearPendingDriveOpenWithState,
  refreshTokenFromUserGesture,
  resolveOrCreateSubfolderId,
  scanTexDependencies,
  signOutGoogleDrive,
  trashDriveFile,
  tryProactiveRefreshOnUserActivity,
  updateDriveFileContent,
  uploadAuxFileToDriveFolder,
} from './services/driveService';

/**
 * Gathers and normalizes all auxiliary project files (figures, bib, sty, cls)
 * for the Web Worker's MEMFS, ensuring:
 * 1. Every figure has its binary payload decoded into a genuine `Uint8Array`.
 * 2. Any image present in `driveFolderFiles` with valid content is used to supplement
 *    or hydrate entries in `session.auxFilesMap` if they were missing content or 0 bytes.
 * 3. Subfolder paths like `output_figures/fig1.png` are strictly preserved.
 *
 * @param {Object} session - Active Yjs collab session.
 * @param {Array<any>} driveFolderFiles - Hydrated files list from Google Drive.
 * @returns {Array<{ path: string, name: string, mimeType: string, category: string, content: string | Uint8Array, size: number }>}
 */
function prepareMemfsAuxFiles(session, driveFolderFiles = []) {
  const result = [];
  const seenPaths = new Set();

  // 1. Pull files from active Yjs session MEMFS collector
  const sessionAux = session?.getAuxFilesForMemFS ? session.getAuxFilesForMemFS() : [];

  // Index driveFolderFiles by relative path, basename, and ID for quick fallback
  const driveFilesByPath = new Map();
  const driveFilesByBase = new Map();
  const driveFilesById = new Map();

  for (const f of driveFolderFiles || []) {
    if (!f || f.mimeType === 'application/vnd.google-apps.folder' || f.isFolder) continue;
    const cleanPath = (f.path || f.name || '').replace(/^\.+\//, '').trim();
    if (!cleanPath) continue;
    const base = cleanPath.split('/').pop();
    if (cleanPath) driveFilesByPath.set(cleanPath, f);
    if (base) driveFilesByBase.set(base, f);
    if (f.id) driveFilesById.set(f.id, f);
  }

  for (const item of sessionAux) {
    if (!item || !item.path) continue;
    const cleanPath = item.path.replace(/^\.+\//, '').trim();
    if (!cleanPath || cleanPath === '.') continue;

    const isImage =
      item.category === 'figure' ||
      isImageAssetFile(cleanPath, item.mimeType) ||
      /\.(pdf|eps)$/i.test(cleanPath);

    let content = item.content;

    // Check if content is missing or empty, and supplement from driveFolderFiles if available
    const hasNoContent =
      content === undefined ||
      content === null ||
      (content instanceof Uint8Array && content.byteLength === 0) ||
      (typeof content === 'string' && content.length === 0);

    if (hasNoContent) {
      const base = cleanPath.split('/').pop();
      const driveMatch =
        driveFilesByPath.get(cleanPath) ||
        (item.id && driveFilesById.get(item.id)) ||
        driveFilesByBase.get(base);
      if (driveMatch && driveMatch.content) {
        content = driveMatch.content;
      }
    }

    if (isImage) {
      const bin = normalizeBinaryContent(content);
      content = bin || content;
    }

    const byteSize =
      content instanceof Uint8Array
        ? content.byteLength
        : typeof content === 'string'
        ? content.length
        : typeof item.size === 'number'
        ? item.size
        : 0;

    seenPaths.add(cleanPath);
    result.push({
      ...item,
      path: cleanPath,
      name: item.name || cleanPath.split('/').pop(),
      content,
      size: byteSize,
    });
  }

  // 2. Also ensure any image/aux files present in driveFolderFiles not yet in session are included
  for (const f of driveFolderFiles || []) {
    if (!f || f.mimeType === 'application/vnd.google-apps.folder' || f.isFolder) continue;
    const cleanPath = (f.path || f.name || '').replace(/^\.+\//, '').trim();
    if (!cleanPath || cleanPath.endsWith('.tex') || seenPaths.has(cleanPath)) continue;

    const isImage =
      isImageAssetFile(cleanPath, f.mimeType) || /\.(pdf|eps)$/i.test(cleanPath);
    let content = f.content;
    if (isImage) {
      const bin = normalizeBinaryContent(content);
      content = bin || content;
    }

    const byteSize =
      content instanceof Uint8Array
        ? content.byteLength
        : typeof content === 'string'
        ? content.length
        : typeof f.size === 'number'
        ? f.size
        : 0;

    seenPaths.add(cleanPath);
    result.push({
      id: f.id || null,
      name: f.name || cleanPath.split('/').pop(),
      path: cleanPath,
      mimeType: isImage ? inferImageMimeType(cleanPath, f.mimeType) : f.mimeType || 'text/plain',
      category: cleanPath.endsWith('.bib') ? 'bib' : isImage ? 'figure' : 'package',
      content,
      size: byteSize,
    });
  }

  return result;
}

/**
 * Root OpenDriveTeX Workspace Component.
 */
export default function App() {
  const [roomName, setRoomName] = useState(() => getRoomFromUrlHash());
  const [collabSession, setCollabSession] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeFile, setActiveFile] = useState('main.tex');
  const [auxFiles, setAuxFiles] = useState([]);
  const [expandedFolders, setExpandedFolders] = useState(() => new Set(['output_figures']));

  // Theme State ('dark' default, persisted in localStorage)
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('opendrivetex_theme') || 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.classList.add('light');
      root.classList.remove('dark');
    } else {
      root.classList.add('dark');
      root.classList.remove('light');
    }
    try {
      localStorage.setItem('opendrivetex_theme', theme);
    } catch {
      // Ignore storage errors
    }
  }, [theme]);

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  // Resizable Split Pane & Toggleable PDF Preview State
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('opendrivetex_split_ratio'));
      return saved >= 20 && saved <= 80 ? saved : 50;
    } catch {
      return 50;
    }
  });
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const [isPdfVisible, setIsPdfVisible] = useState(() => {
    try {
      return localStorage.getItem('opendrivetex_pdf_visible') !== 'false';
    } catch {
      return true;
    }
  });
  const splitContainerRef = useRef(null);

  const handleTogglePdfVisible = useCallback(() => {
    setIsPdfVisible((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('opendrivetex_pdf_visible', String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isResizingSplit) return undefined;

    const handleMouseMove = (e) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const rawPct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(80, Math.max(20, Math.round(rawPct * 10) / 10));
      setSplitRatio(clamped);
      try {
        localStorage.setItem('opendrivetex_split_ratio', String(clamped));
      } catch {
        // Ignore storage errors
      }
    };

    const handleMouseUp = () => {
      setIsResizingSplit(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingSplit]);

  // Web Worker Compilation State (Metadata & Binary PDF Output only; never editor source text)
  const [compileStatus, setCompileStatus] = useState('idle');
  const [pdfBuffer, setPdfBuffer] = useState(null);
  const [compileLogs, setCompileLogs] = useState('');
  const [compileStdout, setCompileStdout] = useState('');
  const [compileStderr, setCompileStderr] = useState('');
  const [compileErrors, setCompileErrors] = useState([]);
  const [compileWarnings, setCompileWarnings] = useState([]);
  const [compileElapsedMs, setCompileElapsedMs] = useState(null);
  const [engineName, setEngineName] = useState('OpenDriveTeX Worker Engine');

  // Google Drive OAuth2, User Profile, Folder & Persistence State
  const [isDriveAuthenticated, setIsDriveAuthenticated] = useState(() =>
    Boolean(getValidAccessToken())
  );
  const [userProfile, setUserProfile] = useState(() => getAuthenticatedUserProfile());
  const [driveFileId, setDriveFileId] = useState(null);
  const [driveFileName, setDriveFileName] = useState('main.tex');
  const [driveFolderId, setDriveFolderId] = useState(() => getRoomFromUrlHash());
  const [driveFolderName, setDriveFolderName] = useState('');
  const [driveFoldersList, setDriveFoldersList] = useState([]);
  const [driveFolderFiles, setDriveFolderFiles] = useState([]);
  const [driveSaveStatus, setDriveSaveStatus] = useState('idle');
  const [driveError, setDriveError] = useState(null);
  const [pickerToastMessage, setPickerToastMessage] = useState(null);
  const [sharedFolderNeedsFilePicker, setSharedFolderNeedsFilePicker] = useState(false);
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [isSyncingFromDrive, setIsSyncingFromDrive] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [nextAutoSaveAt, setNextAutoSaveAt] = useState(null);
  const [driveFilesList, setDriveFilesList] = useState([]);

  // Welcome Screen New Folder Input & Pending Google Drive `?state=` Open-With State
  // Parse `?state=` BEFORE doing anything else and persist in sessionStorage
  const [welcomeFolderName, setWelcomeFolderName] = useState('My-LaTeX-Manuscript');
  const [pendingOpenWithId, setPendingOpenWithId] = useState(() => {
    const initialState = parseDriveOpenWithStateFromUrl();
    return initialState?.ids?.[0] || initialState?.folderId || null;
  });

  // Mandate 2: Pre-Compilation Dependency Scanner & Guided Missing-Files State
  const [missingAssetsModalOpen, setMissingAssetsModalOpen] = useState(false);
  const [missingAssetsList, setMissingAssetsList] = useState([]);
  const [isAuthorizingMissing, setIsAuthorizingMissing] = useState(false);

  // Review Mode, Track Changes & Pre-Flight Journal Submission Export State
  const [isReviewPanelOpen, setIsReviewPanelOpen] = useState(false);
  const [reviewTargetItem, setReviewTargetItem] = useState(null);
  const [reviewItems, setReviewItems] = useState([]);
  const [triggerAddCommentKey, setTriggerAddCommentKey] = useState(0);
  const [isTrackingChanges, setIsTrackingChanges] = useState(() => {
    try {
      return localStorage.getItem('opendrivetex_track_changes') === 'true';
    } catch {
      return false;
    }
  });

  const handleToggleTrackChanges = useCallback(() => {
    setIsTrackingChanges((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('opendrivetex_track_changes', String(next));
      } catch {}
      return next;
    });
  }, []);

  const handleTriggerAddComment = useCallback(() => {
    setTriggerAddCommentKey((k) => k + 1);
  }, []);

  const [preFlightModalState, setPreFlightModalState] = useState({
    isOpen: false,
    exportType: 'tex',
    counts: { comments: 0, additions: 0, deletions: 0, total: 0 },
  });

  const [isSessionExpired, setIsSessionExpired] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const isSessionExpiredRef = useRef(false);
  isSessionExpiredRef.current = isSessionExpired;

  /**
   * Dedicated background Web Worker reference (`src/workers/latex.worker.js`).
   * @type {React.MutableRefObject<Worker | null>}
   */
  const latexWorkerRef = useRef(null);

  /**
   * Tracks the active compilation job ID and UI fallback timeout timer
   * to guarantee that late/orphaned errors never trigger false positive timeout errors.
   */
  const activeCompileJobIdRef = useRef(0);
  const compileTimeoutTimerRef = useRef(null);

  /**
   * Tracks the last focused/active pane ('editor' | 'pdf') and element references
   * to provide intelligent context-aware Ctrl+F / Cmd+F search hijacking.
   */
  const lastActivePaneRef = useRef('editor');
  const editorViewInstanceRef = useRef(null);
  const pdfIframeRef = useRef(null);

  /**
   * Ref to the active collaboration session for stable access inside callbacks.
   * @type {React.MutableRefObject<any>}
   */
  const collabSessionRef = useRef(null);
  collabSessionRef.current = collabSession;

  const driveFolderFilesRef = useRef(driveFolderFiles);
  driveFolderFilesRef.current = driveFolderFiles;

  /**
   * Ref to the currently linked Google Drive `fileId`.
   * @type {React.MutableRefObject<string | null>}
   */
  const driveFileIdRef = useRef(driveFileId);
  driveFileIdRef.current = driveFileId;

  /**
   * Tracks whether the local user's OAuth token has confirmed `drive.file` read/write access
   * to the canonical `main.tex` file in Google Drive.
   * @type {React.MutableRefObject<boolean>}
   */
  const canWriteDriveFileRef = useRef(false);

  /**
   * Tracks the latest Drive modifiedTime timestamp in milliseconds to prevent stale closure comparison loops.
   * @type {React.MutableRefObject<number | null>}
   */
  const lastSavedAtRef = useRef(null);

  /**
   * Tracks the latest `manualSaveRequestedAt` timestamp handled by the Leader tab.
   * @type {React.MutableRefObject<number>}
   */
  const lastHandledManualSaveReqRef = useRef(0);

  /**
   * Tracks whether a Drive PATCH save is waiting for the user to click `main.tex` in Google Picker
   * after a 404 fallback.
   * @type {React.MutableRefObject<boolean>}
   */
  const pendingSaveAfterPickerRef = useRef(false);

  /**
   * Ref to the Leader Drive PATCH execution callback so `projectMeta` observers can invoke it directly.
   * @type {React.MutableRefObject<((sessionOverride?: any) => Promise<void>) | null>}
   */
  const executeLeaderDrivePatchRef = useRef(null);

  /**
   * Ref to the Google Drive folder reconciliation helper so `session.persistence.whenSynced`
   * can reconcile stale IndexedDB cache with live Google Drive state on page reload.
   * @type {React.MutableRefObject<((session: any, folderId: string, folderFilesOverride?: Array<any> | null, options?: { forceOverwriteText?: boolean }) => Promise<void>) | null>}
   */
  const reconcileSessionWithDriveFolderRef = useRef(null);

  /**
   * Pending project payload (main `.tex` + auxiliary files + canonical `projectMeta`)
   * to hydrate into a newly switched folder room.
   * @type {React.MutableRefObject<{
   *   roomId: string,
   *   mainTexFileId?: string | null,
   *   mainTexContent: string,
   *   mainTexName: string,
   *   folderId?: string | null,
   *   folderName?: string,
   *   auxFiles: Array<any>,
   *   canWriteDriveFile?: boolean,
   *   forceOverwrite?: boolean
   * } | null>}
   */
  const pendingRoomHydrationRef = useRef(null);

  // 1. Initialize the dedicated LaTeX Web Worker on mount
  useEffect(() => {
    const worker = new Worker(new URL('./workers/latex.worker.js', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event) => {
      const { type, payload = {} } = event.data || {};

      if (type === 'COMPILE_STARTED') {
        if (payload.jobId && payload.jobId >= activeCompileJobIdRef.current) {
          activeCompileJobIdRef.current = payload.jobId;
        }
        setCompileStatus('compiling');
      } else if (type === 'COMPILE_SUCCESS') {
        // Clear any pending compilation timeout immediately upon receiving PDF payload
        if (compileTimeoutTimerRef.current) {
          clearTimeout(compileTimeoutTimerRef.current);
          compileTimeoutTimerRef.current = null;
        }

        if (payload.jobId && payload.jobId < activeCompileJobIdRef.current) {
          return;
        }

        setCompileStatus('success');
        if (payload.pdfBuffer) {
          setPdfBuffer(
            payload.pdfBuffer instanceof Uint8Array
              ? payload.pdfBuffer
              : new Uint8Array(payload.pdfBuffer)
          );
        }
        setCompileStdout(payload.stdout || '');
        setCompileStderr(payload.stderr || '');
        setCompileLogs(payload.logs || payload.stdout || '');
        setCompileErrors(payload.errors || []);
        setCompileWarnings(payload.warnings || []);
        setCompileElapsedMs(typeof payload.elapsedMs === 'number' ? payload.elapsedMs : null);
        if (payload.engine) {
          setEngineName(payload.engine);
        }
      } else if (type === 'COMPILE_ERROR') {
        if (compileTimeoutTimerRef.current) {
          clearTimeout(compileTimeoutTimerRef.current);
          compileTimeoutTimerRef.current = null;
        }

        // Ignore stale/orphaned error reports from superseded compilation jobs
        if (payload.jobId && payload.jobId < activeCompileJobIdRef.current) {
          return;
        }

        setCompileStatus('error');
        setCompileStdout(payload.stdout || '');
        setCompileStderr(payload.stderr || '');
        setCompileLogs(payload.logs || payload.stderr || '');
        setCompileErrors(payload.errors || []);
        setCompileWarnings(payload.warnings || []);
        setCompileElapsedMs(typeof payload.elapsedMs === 'number' ? payload.elapsedMs : null);
        if (payload.engine) {
          setEngineName(payload.engine);
        }
      }
    };

    worker.onerror = (err) => {
      setCompileStatus('error');
      const errMsg = err?.message || 'Unexpected Web Worker runtime error.';
      setCompileStderr(errMsg);
      setCompileLogs(errMsg);
      setCompileErrors([{ line: null, message: errMsg, context: '' }]);
    };

    latexWorkerRef.current = worker;

    // Pre-warm the BusyTeX WebAssembly worker in the background immediately on mount
    worker.postMessage({ type: 'PREWARM' });

    return () => {
      worker.terminate();
      latexWorkerRef.current = null;
    };
  }, []);

  // Ensure authenticated user profile and session state are hydrated on initial app load / refresh
  useEffect(() => {
    const token = getValidAccessToken();
    if (token) {
      setIsDriveAuthenticated(true);
      const cachedProfile = getAuthenticatedUserProfile();
      if (cachedProfile) {
        setUserProfile(cachedProfile);
        if (collabSessionRef.current) {
          collabSessionRef.current.updateLocalUserProfile({
            ...cachedProfile,
            hasDriveToken: true,
          });
        }
      }

      if (!isSimulatedTokenActive()) {
        fetchGoogleUserProfile(token)
          .then((profile) => {
            setUserProfile(profile);
            if (collabSessionRef.current) {
              collabSessionRef.current.updateLocalUserProfile({
                ...profile,
                hasDriveToken: true,
              });
            }
          })
          .catch(() => {});
      }
    }
  }, []);

  /**
   * Reads the current LaTeX document directly from `Y.Text` (`ytext.toString()`),
   * scans for missing project dependencies under `drive.file` scope, gathers all auxiliary
   * `.bib`, `.sty`, `.cls`, and figure files for MEMFS, and posts a compilation job
   * to the dedicated WebAssembly Web Worker.
   */
  const handleCompile = useCallback(
    (skipDependencyCheck = false) => {
      const currentSession = collabSessionRef.current;
      const worker = latexWorkerRef.current;
      if (!currentSession || !worker) return;

      const texSource = currentSession.ytext.toString();
      if (!texSource.trim()) return;

      const memfsAuxFiles = prepareMemfsAuxFiles(currentSession, driveFolderFiles);

      // Mandate 2: Pre-Compilation .tex Dependency Scanner
      if (!skipDependencyCheck) {
        const detectedDeps = scanTexDependencies(texSource);
        const currentPaths = new Set(
          memfsAuxFiles.map((f) => (f.path || f.name || '').replace(/^\.+\//, ''))
        );
        auxFiles.forEach((f) => {
          const p = (f.path || f.name || '').replace(/^\.+\//, '');
          if (p) currentPaths.add(p);
        });

        const missing = detectedDeps.filter((dep) => {
          if (currentPaths.has(dep.relativePath)) return false;
          if (dep.candidates && dep.candidates.some((c) => currentPaths.has(c))) return false;
          const depBase = dep.relativePath ? dep.relativePath.split('/').pop() : '';
          if (depBase && currentPaths.has(depBase)) return false;
          if (dep.relativePath === 'elsarticle.cls' || dep.relativePath.endsWith('.bst')) {
            return false;
          }
          return true;
        });

        if (missing.length > 0) {
          setMissingAssetsList(missing);
          setMissingAssetsModalOpen(true);
          return;
        }
      }

      const jobId = Date.now();
      activeCompileJobIdRef.current = jobId;

      if (compileTimeoutTimerRef.current) {
        clearTimeout(compileTimeoutTimerRef.current);
      }
      compileTimeoutTimerRef.current = setTimeout(() => {
        if (activeCompileJobIdRef.current === jobId) {
          setCompileStatus('error');
          const timeoutMsg = 'Compilation timeout (180s elapsed).';
          setCompileStderr(timeoutMsg);
          setCompileLogs(timeoutMsg);
          setCompileErrors([{ line: null, message: timeoutMsg, context: '' }]);
        }
      }, 180000);

      setCompileStatus('compiling');
      worker.postMessage({
        type: 'COMPILE',
        payload: {
          jobId,
          texSource,
          mainFile: driveFileName || 'main.tex',
          auxFiles: memfsAuxFiles,
          wasmScriptUrl: import.meta.env?.VITE_LATEX_WASM_URL || undefined,
        },
      });
    },
    [driveFileName, auxFiles, driveFolderFiles]
  );

  /**
   * Refreshes the list of accessible `.tex` files and project folders from Google Drive REST API v3.
   */
  const handleRefreshDriveFiles = useCallback(async () => {
    if (!getValidAccessToken()) return;
    try {
      const [files, folders] = await Promise.all([
        listDriveTexFiles(),
        listDriveProjectFolders(),
      ]);
      setDriveFilesList(files);
      setDriveFoldersList(folders);
    } catch (err) {
      setDriveError(err?.message || 'Failed to list Google Drive files and folders.');
    }
  }, []);

  useEffect(() => {
    if (isDriveAuthenticated) {
      handleRefreshDriveFiles();
    } else {
      setDriveFilesList([]);
      setDriveFoldersList([]);
      setDriveFolderFiles([]);
    }
  }, [isDriveAuthenticated, handleRefreshDriveFiles]);

  // 2. Listen for URL hash changes (`#room=<folderId>`) to switch folder rooms cleanly (Rule #1)
  useEffect(() => {
    const handleHashChange = () => {
      const nextRoom = getRoomFromUrlHash();
      setRoomName(nextRoom);
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

  // 3. Initialize and tear down the Yjs + WebRTC + IndexedDB session when a room is active
  useEffect(() => {
    if (!roomName || typeof roomName !== 'string' || !roomName.trim()) {
      setCollabSession(null);
      setAuxFiles([]);
      setPdfBuffer(null);
      setCompileStatus('idle');
      return undefined;
    }

    const hasToken = Boolean(getValidAccessToken());
    const currentProfile = getAuthenticatedUserProfile();
    const session = createCollabSession({
      roomName,
      projectName: driveFolderName || driveFileName || roomName,
      hasDriveToken: hasToken,
      userProfile: currentProfile || undefined,
    });
    setCollabSession(session);

    // Sync auxiliary files list from `session.auxFilesMap` for Sidebar & Worker MEMFS
    const syncAuxFilesList = () => {
      const list = [];
      session.auxFilesMap.forEach((val, key) => {
        if (val) {
          list.push({ ...val, path: key });
        }
      });
      list.sort((a, b) => a.path.localeCompare(b.path));
      setAuxFiles(list);
    };

    syncAuxFilesList();
    session.auxFilesMap.observe(syncAuxFilesList);

    // Initialize `lastHandledManualSaveReqRef` to any existing timestamp so cached state doesn't re-fire
    const initialManualReq = session.projectMeta?.get('manualSaveRequestedAt');
    if (typeof initialManualReq === 'number') {
      lastHandledManualSaveReqRef.current = initialManualReq;
    }

    // Rule #3 & Leader-Delegated Save Observer:
    // Syncs canonical project metadata (`mainTexFileId`, `mainTexFileName`, `folderId`, `folderName`),
    // shared save status (`lastSavedAt`, `saveStatus`), and `manualSaveRequestedAt` from `Y.Map('projectMeta')`.
    const syncProjectMeta = () => {
      if (!session.projectMeta) return;
      const metaMainId = session.projectMeta.get('mainTexFileId');
      const metaMainName = session.projectMeta.get('mainTexFileName');
      const metaFolderId = session.projectMeta.get('folderId');
      const metaFolderName = session.projectMeta.get('folderName');
      const metaLastSavedAt = session.projectMeta.get('lastSavedAt');
      const metaSaveStatus = session.projectMeta.get('saveStatus');
      const metaManualSaveReqAt = session.projectMeta.get('manualSaveRequestedAt');

      if (typeof metaMainId === 'string' && isValidDriveId(metaMainId)) {
        setDriveFileId(metaMainId);
      }
      if (typeof metaMainName === 'string' && metaMainName.trim()) {
        setDriveFileName(metaMainName);
      }
      if (typeof metaFolderId === 'string' && isValidDriveId(metaFolderId)) {
        setDriveFolderId(metaFolderId);
      }
      if (typeof metaFolderName === 'string' && metaFolderName.trim()) {
        setDriveFolderName(metaFolderName);
      }

      if (typeof metaLastSavedAt === 'number' && metaLastSavedAt > 0) {
        setLastSavedAt((prev) => (!prev || metaLastSavedAt > prev ? metaLastSavedAt : prev));
      }

      if (metaSaveStatus === 'saving') {
        setDriveSaveStatus('saving');
      } else if (metaSaveStatus === 'saved') {
        setDriveSaveStatus('saved');
        setNextAutoSaveAt(null);
      }

      // Requirement #2: Elected Save Leader listens to `manualSaveRequestedAt` and immediately executes PATCH
      if (
        typeof metaManualSaveReqAt === 'number' &&
        metaManualSaveReqAt > lastHandledManualSaveReqRef.current
      ) {
        lastHandledManualSaveReqRef.current = metaManualSaveReqAt;
        const election = session.getLeaderElectionState();
        if (election.isLocalLeader && executeLeaderDrivePatchRef.current) {
          executeLeaderDrivePatchRef.current(session);
        }
      }
    };

    syncProjectMeta();
    session.projectMeta.observe(syncProjectMeta);

    // Trigger an automatic first PDF compilation when remote `ytext` arrives over WebRTC for a joining collaborator
    let hasTriggeredInitialCompile = false;
    const triggerInitialCompileIfReady = () => {
      if (session.ytext.length > 0) {
        setSharedFolderNeedsFilePicker(false);
        if (!hasTriggeredInitialCompile && latexWorkerRef.current) {
          hasTriggeredInitialCompile = true;
          const jobId = Date.now();
          activeCompileJobIdRef.current = jobId;

          if (compileTimeoutTimerRef.current) {
            clearTimeout(compileTimeoutTimerRef.current);
          }
          compileTimeoutTimerRef.current = setTimeout(() => {
            if (activeCompileJobIdRef.current === jobId) {
              setCompileStatus('error');
              const timeoutMsg = 'Compilation timeout (180s elapsed).';
              setCompileStderr(timeoutMsg);
              setCompileLogs(timeoutMsg);
              setCompileErrors([{ line: null, message: timeoutMsg, context: '' }]);
            }
          }, 180000);

          setCompileStatus('compiling');
          const memfsFiles = prepareMemfsAuxFiles(session, driveFolderFilesRef.current || []);
          latexWorkerRef.current.postMessage({
            type: 'COMPILE',
            payload: {
              jobId,
              texSource: session.ytext.toString(),
              mainFile: session.projectMeta?.get('mainTexFileName') || 'main.tex',
              auxFiles: memfsFiles,
              wasmScriptUrl: import.meta.env?.VITE_LATEX_WASM_URL || undefined,
            },
          });
        }
      }
    };

    const handleYTextArrival = () => {
      triggerInitialCompileIfReady();
    };
    session.ytext.observe(handleYTextArrival);

    // Listen to remote peers' Drive save timestamps broadcasted via Awareness
    const handleAwarenessSaveSync = () => {
      let latestRemoteSave = null;
      session.awareness.getStates().forEach((state) => {
        const ts = state?.user?.lastDriveSaveAt;
        if (typeof ts === 'number' && (!latestRemoteSave || ts > latestRemoteSave)) {
          latestRemoteSave = ts;
        }
      });
      if (latestRemoteSave) {
        setLastSavedAt((prev) => (!prev || latestRemoteSave > prev ? latestRemoteSave : prev));
        setDriveSaveStatus((prev) => (prev === 'dirty' ? 'saved' : prev));
        setNextAutoSaveAt(null);
      }
    };

    session.awareness.on('change', handleAwarenessSaveSync);

    // Register Leader-Elected 30-second debounced auto-save
    const unregisterAutoSave = session.registerLeaderAutoSave({
      isDriveFileLinked: () =>
        Boolean(
          !isSessionExpiredRef.current &&
            isValidDriveId(
              driveFileIdRef.current || session.projectMeta?.get('mainTexFileId')
            ) &&
            getValidAccessToken()
        ),
      onDirtyStateChange: ({ isDirty, nextAutoSaveAt: scheduledAt }) => {
        if (isSessionExpiredRef.current) return;
        if (isDirty) {
          setDriveSaveStatus('dirty');
          setNextAutoSaveAt(scheduledAt);
        } else {
          setNextAutoSaveAt(null);
        }
      },
      onLeaderAutoSave: async () => {
        if (isSessionExpiredRef.current) return;
        if (executeLeaderDrivePatchRef.current) {
          await executeLeaderDrivePatchRef.current(session);
        }
      },
    });

    // Hydrate pending project folder content and reconcile stale IndexedDB cache with Google Drive once IndexedDB syncs
    let initialCompileTimer = null;
    session.persistence.whenSynced.then(async () => {
      if (
        pendingRoomHydrationRef.current &&
        pendingRoomHydrationRef.current.roomId === roomName
      ) {
        const {
          mainTexFileId,
          mainTexContent,
          mainTexName,
          folderId: pendingFolderId,
          folderName: pendingFolderName,
          auxFiles: pendingAux,
          folderFiles: pendingFolderFiles,
          canWriteDriveFile,
          forceOverwrite,
        } = pendingRoomHydrationRef.current;
        pendingRoomHydrationRef.current = null;

        if (typeof canWriteDriveFile === 'boolean') {
          canWriteDriveFileRef.current = canWriteDriveFile;
          session.updateLocalUserProfile({ canWriteDriveFile });
        }

        // Rule #3: Sync canonical projectMeta inside Y.Doc so all peers in the folder room share it
        session.updateProjectMeta({
          mainTexFileId: mainTexFileId || undefined,
          mainTexFileName: mainTexName || undefined,
          folderId: pendingFolderId || roomName,
          folderName: pendingFolderName || undefined,
        });

        if (typeof mainTexContent === 'string' && mainTexContent.length > 0) {
          session.replaceDocumentFromDrive(mainTexContent, Boolean(forceOverwrite));
        }

        if (reconcileSessionWithDriveFolderRef.current && Array.isArray(pendingFolderFiles)) {
          await reconcileSessionWithDriveFolderRef.current(
            session,
            pendingFolderId || roomName,
            pendingFolderFiles,
            { forceOverwriteText: Boolean(forceOverwrite) }
          );
        } else if (Array.isArray(pendingAux) && pendingAux.length > 0) {
          session.mergeFolderAuxFiles(pendingAux);
        }

        if (mainTexName) {
          setDriveFileName(mainTexName);
          setActiveFile(mainTexName);
        }
      } else if (getValidAccessToken()) {
        // Page reload with an existing `#room=<fileId>` hash:
        // Query Google Drive to fetch the latest state directly from Google Drive API
        try {
          const meta = await fetchDriveFileMetadata(roomName);
          if (meta.mimeType === 'application/vnd.google-apps.folder') {
            if (reconcileSessionWithDriveFolderRef.current) {
              await reconcileSessionWithDriveFolderRef.current(session, roomName, null, {
                forceOverwriteText: true,
              });
            }
          } else {
            const rawContent = await fetchDriveFileContent(meta.id, false);
            const resolvedName = meta.name || 'main.tex';
            canWriteDriveFileRef.current = true;
            setDriveFileId(meta.id);
            setDriveFileName(resolvedName);
            setActiveFile(resolvedName);
            setDriveSaveStatus('saved');
            const initialSavedMs = meta.modifiedTime
              ? new Date(meta.modifiedTime).getTime()
              : Date.now();
            lastSavedAtRef.current = initialSavedMs;
            setLastSavedAt(initialSavedMs);
            session.updateProjectMeta({
              mainTexFileId: meta.id,
              mainTexFileName: resolvedName,
            });
            session.replaceDocumentFromDrive(rawContent, true);
          }
        } catch {
          if (reconcileSessionWithDriveFolderRef.current) {
            await reconcileSessionWithDriveFolderRef.current(session, roomName, null, {
              forceOverwriteText: true,
            });
          }
        }
      }

      syncProjectMeta();

      initialCompileTimer = window.setTimeout(() => {
        syncAuxFilesList();
        syncProjectMeta();
        triggerInitialCompileIfReady();
      }, 320);
    });

    return () => {
      if (initialCompileTimer) {
        window.clearTimeout(initialCompileTimer);
      }
      session.auxFilesMap.unobserve(syncAuxFilesList);
      session.projectMeta.unobserve(syncProjectMeta);
      session.ytext.unobserve(handleYTextArrival);
      session.awareness.off('change', handleAwarenessSaveSync);
      unregisterAutoSave();
      session.destroy();
    };
  }, [roomName]);

  // Keep local peer's real Google user profile & `hasDriveToken` synchronized in Yjs Awareness
  useEffect(() => {
    if (collabSession) {
      collabSession.updateLocalUserProfile({
        name: userProfile?.name,
        email: userProfile?.email,
        picture: userProfile?.picture,
        hasDriveToken: isDriveAuthenticated,
        canWriteDriveFile: canWriteDriveFileRef.current,
      });
    }
  }, [collabSession, isDriveAuthenticated, userProfile]);

  /**
   * Requirement #1: Reconciles the Google Drive folder file list (`files.list` with `trashed=false`
   * and `Cache-Control: no-cache`) against the local Yjs `projectMeta` / `auxFilesMap` (IndexedDB)
   * and Web Worker MEMFS state:
   *   a) Any file present in Drive (`driveAuxFiles`) is downloaded and upserted into MEMFS and the sidebar.
   *   b) Any file present locally in `auxFilesMap` that no longer exists in Drive (or has `trashed=true`
   *      when checked via `checkDriveFileStatus`) is removed from the sidebar, Yjs state, IndexedDB cache,
   *      and Web Worker MEMFS.
   */
  const reconcileSessionWithDriveFolder = useCallback(
    async (
      targetSession,
      targetFolderId,
      folderFilesOverride = null,
      { forceOverwriteText = false } = {}
    ) => {
      if (!targetSession || !isValidDriveId(targetFolderId) || !getValidAccessToken()) {
        return;
      }

      const folderFiles =
        folderFilesOverride || (await listAndFetchDriveFolderFiles(targetFolderId));
      setDriveFolderFiles(folderFiles);

      const folderItems = folderFiles.filter(
        (f) => f.mimeType === 'application/vnd.google-apps.folder' || f.isFolder
      );
      const regularFiles = folderFiles.filter(
        (f) => f.mimeType !== 'application/vnd.google-apps.folder' && !f.isFolder
      );
      const texFiles = regularFiles.filter((f) => f.name.endsWith('.tex'));
      const auxItems = regularFiles.filter((f) => !f.name.endsWith('.tex'));
      const mainTexFile =
        texFiles.find((f) => f.name.toLowerCase() === 'main.tex') || texFiles[0] || null;

      // Ensure any subfolder names discovered in Drive are registered in expandedFolders
      if (folderItems.length > 0) {
        setExpandedFolders((prev) => {
          const next = new Set(prev);
          folderItems.forEach((f) => next.add(f.name));
          return next;
        });
      }

      // Build lookup sets of active files currently in the Drive folder
      const driveAuxPathSet = new Set(
        auxItems.map((f) => (f.path || f.name || '').replace(/^\.+\//, '').trim())
      );
      const driveFileIdSet = new Set(folderFiles.map((f) => f.id).filter(Boolean));

      // Inspect locally cached entries in `targetSession.auxFilesMap` (restored from IndexedDB or peers)
      const localEntries = [];
      targetSession.auxFilesMap.forEach((val, key) => {
        if (val) {
          localEntries.push([key, val]);
        }
      });

      const pathsToRemove = [];
      for (const [localPath, localMeta] of localEntries) {
        // Automatically prune any legacy folder entries mistakenly saved as files
        if (localMeta.mimeType === 'application/vnd.google-apps.folder' || localMeta.isFolder) {
          pathsToRemove.push(localPath);
          continue;
        }

        // CRITICAL BUG FIX: Never prune subfolder assets (e.g. output_figures/fig1.png)
        // during root folder reconciliation, because flat root files.list does not list nested files!
        if (localPath.includes('/')) {
          continue;
        }

        if (!driveAuxPathSet.has(localPath)) {
          if (isValidDriveId(localMeta?.id)) {
            const status = await checkDriveFileStatus(localMeta.id);
            if (
              !status.exists ||
              status.trashed ||
              (folderFiles.length > 0 && !driveFileIdSet.has(localMeta.id))
            ) {
              pathsToRemove.push(localPath);
            }
          } else if (folderFiles.length > 0 && forceOverwriteText) {
            pathsToRemove.push(localPath);
          }
        }
      }

      // Reconcile Yjs `auxFilesMap`, `Y.Text('file:...')`, and `projectMeta`
      targetSession.reconcileFolderWithDrive({
        driveAuxFiles: auxItems,
        pathsToRemove,
        forceOverwriteText,
      });

      // Synchronize the Web Worker's MEMFS (delete removed paths and sync active files)
      if (latexWorkerRef.current) {
        for (const removedPath of pathsToRemove) {
          latexWorkerRef.current.postMessage({
            type: 'DELETE_MEMFS_FILE',
            payload: { path: removedPath },
          });
        }
        latexWorkerRef.current.postMessage({
          type: 'SYNC_MEMFS',
          payload: { auxFiles: targetSession.getAuxFilesForMemFS() },
        });
      }

      if (pathsToRemove.length > 0) {
        setActiveFile((prevActive) =>
          pathsToRemove.includes(prevActive)
            ? mainTexFile?.name || driveFileName || 'main.tex'
            : prevActive
        );
      }

      if (mainTexFile) {
        canWriteDriveFileRef.current = true;
        setSharedFolderNeedsFilePicker(false);
        const mainName = mainTexFile.name || 'main.tex';
        setDriveFileId(mainTexFile.id);
        setDriveFileName(mainName);
        targetSession.updateLocalUserProfile({ canWriteDriveFile: true });
        targetSession.updateProjectMeta({
          mainTexFileId: mainTexFile.id,
          mainTexFileName: mainName,
          folderId: targetFolderId,
        });
        if (typeof mainTexFile.content === 'string' && mainTexFile.content.length > 0) {
          targetSession.replaceDocumentFromDrive(mainTexFile.content, Boolean(forceOverwriteText));
        }
      }
    },
    [driveFileName]
  );

  reconcileSessionWithDriveFolderRef.current = reconcileSessionWithDriveFolder;

  /**
   * Loads a Google Drive Project Folder by its `folderId`:
   *   1. Rule #1: Unifies the Yjs WebRTC room ID by `cleanFolderId` (`#room=<folderId>`) so
   *      all collaborators who pick the same shared folder join the exact same P2P room.
   *   2. Rule #2: NEVER auto-creates a duplicate `main.tex` if `files.list` returns empty on
   *      a shared folder under `drive.file`. Instead, joins the folder room to receive live state
   *      from WebRTC peers OR prompts the user to select the existing files in Google Picker.
   *   3. Rule #3: Stores canonical `mainTexFileId`, `mainTexFileName`, `folderId`, and `folderName`
   *      in `Y.Map('projectMeta')` alongside `Y.Map('auxFiles')`.
   *   4. Reconciles the live Drive file list against IndexedDB so deleted/trashed files are pruned.
   */
  const handleSelectDriveFolder = useCallback(
    async (selectedFolderId, optionalFolderName = '') => {
      if (!isValidDriveId(selectedFolderId) || !getValidAccessToken()) {
        return;
      }

      const cleanFolderId = selectedFolderId.trim();
      setIsLoadingFolder(true);
      setDriveError(null);

      try {
        let resolvedFolderName = optionalFolderName;
        if (!resolvedFolderName) {
          try {
            const folderMeta = await fetchDriveFileMetadata(cleanFolderId);
            resolvedFolderName = folderMeta.name || cleanFolderId;
          } catch {
            resolvedFolderName = cleanFolderId;
          }
        }

        const folderFiles = await listAndFetchDriveFolderFiles(cleanFolderId);
        setDriveFolderId(cleanFolderId);
        setDriveFolderName(resolvedFolderName);
        setDriveFolderFiles(folderFiles);

        // Separate subfolders, .tex files, and auxiliary MEMFS files (.bib, .sty, .cls, images)
        const folderItems = folderFiles.filter(
          (f) => f.mimeType === 'application/vnd.google-apps.folder' || f.isFolder
        );
        const regularFiles = folderFiles.filter(
          (f) => f.mimeType !== 'application/vnd.google-apps.folder' && !f.isFolder
        );
        const texFiles = regularFiles.filter((f) => f.name.endsWith('.tex'));
        const auxItems = regularFiles.filter((f) => !f.name.endsWith('.tex'));

        if (folderItems.length > 0) {
          setExpandedFolders((prev) => {
            const next = new Set(prev);
            folderItems.forEach((f) => next.add(f.name));
            return next;
          });
        }

        const mainTexFile =
          texFiles.find((f) => f.name.toLowerCase() === 'main.tex') || texFiles[0] || null;

        // Shared deterministic room name based on project folder or main .tex name
        // (avoiding user-specific Google Drive IDs so all collaborators join the same WebRTC room).
        const targetRoomId = getDeterministicRoomName(
          resolvedFolderName || (mainTexFile ? mainTexFile.name : null) || cleanFolderId
        );

        if (mainTexFile) {
          // User has direct `drive.file` visibility of `main.tex` inside this folder
          canWriteDriveFileRef.current = true;
          setSharedFolderNeedsFilePicker(false);

          const mainTexContent =
            typeof mainTexFile.content === 'string' ? mainTexFile.content : '';
          const mainName = mainTexFile.name || 'main.tex';
          const initialSavedMs = mainTexFile.modifiedTime
            ? new Date(mainTexFile.modifiedTime).getTime()
            : Date.now();
          lastSavedAtRef.current = initialSavedMs;
          setLastSavedAt(initialSavedMs);

          setDriveFileId(mainTexFile.id);
          setDriveFileName(mainName);
          setActiveFile(mainName);
          setDriveSaveStatus('saved');

          if (collabSessionRef.current && collabSessionRef.current.roomName === targetRoomId) {
            collabSessionRef.current.updateLocalUserProfile({ canWriteDriveFile: true });
            collabSessionRef.current.updateProjectMeta({
              mainTexFileId: mainTexFile.id,
              mainTexFileName: mainName,
              folderId: cleanFolderId,
              folderName: resolvedFolderName,
            });
            await reconcileSessionWithDriveFolder(
              collabSessionRef.current,
              cleanFolderId,
              folderFiles,
              { forceOverwriteText: true }
            );
          } else {
            pendingRoomHydrationRef.current = {
              roomId: targetRoomId,
              mainTexFileId: mainTexFile.id,
              mainTexContent,
              mainTexName: mainName,
              folderId: cleanFolderId,
              folderName: resolvedFolderName,
              auxFiles: auxItems,
              folderFiles,
              canWriteDriveFile: true,
              forceOverwrite: true,
            };
            setRoomInUrlHash(targetRoomId);
          }
        } else {
          // Rule #2: `files.list` returned no `.tex` files (e.g. User B opened a shared folder
          // created by User A under the `drive.file` scope).
          // NEVER auto-create a duplicate `main.tex`! Join the unified folder room `#room=<folderId>`
          // to sync `Y.Doc`, `projectMeta`, and `auxFiles` from connected WebRTC peers, or let
          // User B multi-select the existing files inside the shared folder via Google Picker.
          canWriteDriveFileRef.current = false;
          setSharedFolderNeedsFilePicker(true);
          setActiveFile('main.tex');

          if (collabSessionRef.current && collabSessionRef.current.roomName === targetRoomId) {
            collabSessionRef.current.updateLocalUserProfile({ canWriteDriveFile: false });
            collabSessionRef.current.updateProjectMeta({
              folderId: cleanFolderId,
              folderName: resolvedFolderName,
            });
            await reconcileSessionWithDriveFolder(
              collabSessionRef.current,
              cleanFolderId,
              folderFiles,
              { forceOverwriteText: true }
            );
            if (collabSessionRef.current.ytext.length > 0) {
              setSharedFolderNeedsFilePicker(false);
            }
          } else {
            pendingRoomHydrationRef.current = {
              roomId: targetRoomId,
              mainTexFileId: null,
              mainTexContent: '',
              mainTexName: 'main.tex',
              folderId: cleanFolderId,
              folderName: resolvedFolderName,
              auxFiles: auxItems,
              folderFiles,
              canWriteDriveFile: false,
              forceOverwrite: false,
            };
            setRoomInUrlHash(targetRoomId);
          }
        }
      } catch (err) {
        setDriveError(
          err?.message || 'Failed to load files from the selected Google Drive folder.'
        );
      } finally {
        setIsLoadingFolder(false);
      }
    },
    [reconcileSessionWithDriveFolder]
  );

  /**
   * Requirement #1: Explicit "Sync / Refresh from Drive" button handler in the Sidebar header.
   * Queries Google Drive (`files.list` with `trashed=false` and `Cache-Control: no-cache`)
   * and reconciles the Drive file list with Yjs `projectMeta`, `auxFilesMap`, IndexedDB, and Worker MEMFS.
   */
  const handleSyncFromDrive = useCallback(async () => {
    const currentSession = collabSessionRef.current;
    const targetFolderId =
      driveFolderId || currentSession?.projectMeta?.get('folderId') || roomName;

    if (!getValidAccessToken()) return;

    setIsSyncingFromDrive(true);
    setDriveError(null);
    try {
      if (currentSession && isValidDriveId(targetFolderId)) {
        await reconcileSessionWithDriveFolder(currentSession, targetFolderId, null, {
          forceOverwriteText: true,
        });
      }
      await handleRefreshDriveFiles();
    } catch (err) {
      setDriveError(err?.message || 'Failed to sync folder state from Google Drive.');
    } finally {
      setIsSyncingFromDrive(false);
    }
  }, [driveFolderId, roomName, reconcileSessionWithDriveFolder, handleRefreshDriveFiles]);

  /**
   * Opens a single `.tex` file or folder ID from Google Drive (used by `?state=` "Open With"):
   *   a) Calls `files.get` (`fetchDriveFileMetadata`) on `targetId` with `fields=id,name,mimeType,modifiedTime,parents`.
   *   b) If `targetId` is a `.tex` file (not a folder), reads its `parents[0]` as the active Project Folder ID
   *      so the Yjs room ID remains unified by the parent folder, loads the `.tex` content immediately into
   *      the editor, and scans it for `\includegraphics` / `\bibliography` dependencies.
   *   c) Cleans the `?state=` parameter from `sessionStorage` and the browser address bar using
   *      `window.history.replaceState` (`clearPendingDriveOpenWithState`) once loaded so refreshing the page
   *      doesn't re-trigger the initial import loop.
   */
  const handleOpenDriveTargetById = useCallback(
    async (targetId) => {
      if (!isValidDriveId(targetId) || !getValidAccessToken()) return;
      setIsLoadingFolder(true);
      setDriveError(null);

      try {
        const metadata = await fetchDriveFileMetadata(targetId);

        if (metadata.mimeType === 'application/vnd.google-apps.folder') {
          await handleSelectDriveFolder(metadata.id, metadata.name);
          clearPendingDriveOpenWithState();
          setPendingOpenWithId(null);
          return;
        }

        // Target is a single file (e.g., a `.tex` file opened via Google Drive "Open With")
        const rawContent = await fetchDriveFileContent(metadata.id);
        const resolvedName = metadata.name || 'main.tex';

        canWriteDriveFileRef.current = true;
        setSharedFolderNeedsFilePicker(false);
        setDriveFileId(metadata.id);
        setDriveFileName(resolvedName);
        setActiveFile(resolvedName);
        setDriveSaveStatus('saved');

        const initialSavedMs = metadata.modifiedTime
          ? new Date(metadata.modifiedTime).getTime()
          : Date.now();
        lastSavedAtRef.current = initialSavedMs;
        setLastSavedAt(initialSavedMs);

        let siblingAuxFiles = [];
        let folderFiles = [];
        let resolvedFolderName = '';
        const parentId = Array.isArray(metadata.parents) ? metadata.parents[0] : null;

        if (isValidDriveId(parentId)) {
          setDriveFolderId(parentId);
          try {
            const parentMeta = await fetchDriveFileMetadata(parentId);
            if (parentMeta?.name) {
              resolvedFolderName = parentMeta.name;
              setDriveFolderName(parentMeta.name);
            }
          } catch {
            // Parent folder metadata may not be accessible under drive.file until picked
          }
          try {
            folderFiles = await listAndFetchDriveFolderFiles(parentId);
            setDriveFolderFiles(folderFiles);
            siblingAuxFiles = folderFiles.filter(
              (f) =>
                f.mimeType !== 'application/vnd.google-apps.folder' &&
                !f.isFolder &&
                !f.name.endsWith('.tex')
            );
          } catch {
            // Parent folder may not be authorized yet; continue with the opened file
          }
        }

        // Shared deterministic room name based on parent folder or .tex file name
        const targetRoomId = getDeterministicRoomName(
          resolvedFolderName || metadata.name || 'project'
        );

        if (collabSessionRef.current && collabSessionRef.current.roomName === targetRoomId) {
          collabSessionRef.current.updateLocalUserProfile({ canWriteDriveFile: true });
          collabSessionRef.current.updateProjectMeta({
            mainTexFileId: metadata.id,
            mainTexFileName: resolvedName,
            folderId: isValidDriveId(parentId) ? parentId : undefined,
            folderName: resolvedFolderName || undefined,
          });
          collabSessionRef.current.replaceDocumentFromDrive(rawContent, true);
          if (siblingAuxFiles.length > 0) {
            collabSessionRef.current.mergeFolderAuxFiles(siblingAuxFiles);
          }
        } else {
          pendingRoomHydrationRef.current = {
            roomId: targetRoomId,
            mainTexFileId: metadata.id,
            mainTexContent: rawContent,
            mainTexName: resolvedName,
            folderId: isValidDriveId(parentId) ? parentId : undefined,
            folderName: resolvedFolderName || undefined,
            auxFiles: siblingAuxFiles,
            folderFiles: folderFiles.length > 0 ? folderFiles : undefined,
            canWriteDriveFile: true,
            forceOverwrite: true,
          };
          setRoomInUrlHash(targetRoomId);
        }

        // Scan the opened `.tex` content for `\includegraphics` / `\bibliography` dependencies
        if (typeof rawContent === 'string' && rawContent.trim()) {
          const detectedDeps = scanTexDependencies(rawContent);
          const authorizedPaths = new Set(
            siblingAuxFiles.map((f) => (f.path || f.name || '').replace(/^\.+\//, ''))
          );
          if (collabSessionRef.current?.auxFilesMap) {
            collabSessionRef.current.auxFilesMap.forEach((_v, k) => {
              authorizedPaths.add(k.replace(/^\.+\//, ''));
            });
          }

          const missingDeps = detectedDeps.filter((dep) => {
            if (authorizedPaths.has(dep.relativePath)) return false;
            if (dep.candidates && dep.candidates.some((c) => authorizedPaths.has(c))) return false;
            const depBase = dep.relativePath ? dep.relativePath.split('/').pop() : '';
            if (depBase && authorizedPaths.has(depBase)) return false;
            if (dep.relativePath === 'elsarticle.cls' || dep.relativePath.endsWith('.bst')) {
              return false;
            }
            return true;
          });

          if (missingDeps.length > 0) {
            setMissingAssetsList(missingDeps);
            setMissingAssetsModalOpen(true);
          }
        }

        // Clean `?state=` from sessionStorage and browser address bar once loaded
        clearPendingDriveOpenWithState();
        setPendingOpenWithId(null);
      } catch (err) {
        setDriveError(err?.message || `Failed to open Google Drive item "${targetId}".`);
      } finally {
        setIsLoadingFolder(false);
      }
    },
    [handleSelectDriveFolder]
  );

  // 4. Requirement #4: Check URL query parameters (or sessionStorage) on startup for Google Drive's `?state=` JSON parameter
  useEffect(() => {
    const openWithState = parseDriveOpenWithStateFromUrl();
    if (!openWithState) return;

    const targetId = openWithState.ids[0] || openWithState.folderId;
    if (!isValidDriveId(targetId)) return;

    setPendingOpenWithId(targetId);

    if (getValidAccessToken()) {
      handleOpenDriveTargetById(targetId);
    } else {
      // Trigger Google OAuth login while keeping `openWithState` persisted in sessionStorage
      authenticateWithGoogleDrive({ prompt: '' })
        .then((authResult) => {
          setIsDriveAuthenticated(true);
          setUserProfile(authResult.userProfile);
          handleOpenDriveTargetById(targetId);
        })
        .catch(() => {
          // If popup was blocked prior to user gesture, `pendingOpenWithId` and `sessionStorage`
          // remain set and a prominent button on the Welcome screen completes it in one click.
        });
    }
  }, [handleOpenDriveTargetById]);

  /**
   * Initiates Google Identity Services (GIS) OAuth 2.0 login with
   * `drive.file openid profile email` scopes and updates Yjs Awareness with the real user profile.
   */
  const handleConnectDrive = useCallback(async () => {
    setDriveError(null);
    try {
      const authResult = await authenticateWithGoogleDrive();
      setIsDriveAuthenticated(true);
      setUserProfile(authResult.userProfile);

      if (collabSessionRef.current) {
        collabSessionRef.current.updateLocalUserProfile({
          ...authResult.userProfile,
          hasDriveToken: true,
        });
      }

      const persistedState = parseDriveOpenWithStateFromUrl();
      const targetId = pendingOpenWithId || persistedState?.ids?.[0] || persistedState?.folderId;
      if (isValidDriveId(targetId)) {
        await handleOpenDriveTargetById(targetId);
      }
    } catch (err) {
      setDriveError(err?.message || 'Google Drive authentication failed.');
    }
  }, [pendingOpenWithId, handleOpenDriveTargetById]);

  /**
   * Signs out of Google Drive and resets workspace state.
   */
  const handleDisconnectDrive = useCallback(() => {
    signOutGoogleDrive();
    setIsDriveAuthenticated(false);
    setUserProfile(null);
    setDriveSaveStatus('idle');
    setNextAutoSaveAt(null);
    if (collabSessionRef.current) {
      collabSessionRef.current.setLocalDriveAuthStatus(false);
    }
  }, []);

  /**
   * Requirement #3: Opens the official Google Picker API (`google.picker.PickerBuilder`)
   * so users and collaborators can visually select a folder (or shared files in "Shared with me"),
   * automatically granting `drive.file` access without 404 errors.
   */
  const handleOpenGooglePicker = useCallback(
    async (mode = 'folder') => {
      setDriveError(null);
      try {
        const result = await openGoogleDrivePicker({
          mode,
          parentFolderId: mode === 'files' ? driveFolderId : undefined,
        });

        if (result.action !== 'picked' || result.items.length === 0) {
          return;
        }

        const pickedFolders = result.items.filter(
          (item) => item.mimeType === 'application/vnd.google-apps.folder'
        );
        const pickedFiles = result.items.filter(
          (item) => item.mimeType !== 'application/vnd.google-apps.folder'
        );

        // If the user selected a folder only (and no individual files) in folder mode, load the folder
        if (mode === 'folder' && pickedFolders.length === 1 && pickedFiles.length === 0) {
          const folder = pickedFolders[0];
          await handleSelectDriveFolder(folder.id, folder.name);
          await handleRefreshDriveFiles();
          return;
        }

        // If the user picked individual files and/or folders (e.g. in files mode or multiselect)
        if (pickedFiles.length > 0 || pickedFolders.length > 0) {
          setIsLoadingFolder(true);
          const targetFolderId = driveFolderId || pickedFolders[0]?.id;
          const allItemsToFetch = [...pickedFiles, ...pickedFolders];
          const hydratedPickedFiles = await fetchMultipleDriveFilesById(
            allItemsToFetch,
            getValidAccessToken(),
            targetFolderId
          );

          if (pickedFolders.length > 0 && !driveFolderId) {
            setDriveFolderId(pickedFolders[0].id);
            setDriveFolderName(pickedFolders[0].name);
          }

          setDriveFolderFiles((prev) => {
            const mergedMap = new Map(prev.map((f) => [f.id || f.name, f]));
            for (const f of hydratedPickedFiles) {
              mergedMap.set(f.id || f.name, f);
            }
            return Array.from(mergedMap.values());
          });

          // Filter out folder items so they are not treated as regular aux files
          const regularPickedFiles = hydratedPickedFiles.filter(
            (f) => f.mimeType !== 'application/vnd.google-apps.folder' && !f.isFolder
          );
          const texFiles = regularPickedFiles.filter((f) => f.name.endsWith('.tex'));
          const auxItems = regularPickedFiles.filter((f) => !f.name.endsWith('.tex'));
          const mainTex =
            texFiles.find((f) => f.name.toLowerCase() === 'main.tex') || texFiles[0] || null;

          // Requirement 2: Match each selected file's basename (doc.name) against \includegraphics
          // paths in main.tex (e.g. output_figures/fig1_neff_vs_porosity_ab_ema.png) so they are
          // mounted at their exact relative subfolder paths in auxFilesMap and MEMFS
          const currentTex =
            collabSessionRef.current?.ytext?.toString() ||
            (typeof mainTex?.content === 'string' ? mainTex.content : '');
          const scannedDeps = scanTexDependencies(currentTex);

          for (const item of auxItems) {
            const docName = (item.name || '').trim();
            const docNameWithoutExt = docName.replace(/\.[^/.]+$/, '');
            const matchedDep = scannedDeps.find((dep) => {
              const depRel = dep.relativePath || '';
              const depBase = depRel.split('/').pop() || '';
              const depBaseWithoutExt = depBase.replace(/\.[^/.]+$/, '');
              if (depRel === docName) return true;
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
            if (matchedDep?.relativePath) {
              item.path = matchedDep.relativePath;
            }
          }

          // Auto-expand any subfolder paths found in picked files
          auxItems.forEach((f) => {
            if (f.path && f.path.includes('/')) {
              const subName = f.path.split('/')[0];
              setExpandedFolders((prev) => new Set([...prev, subName]));
            }
          });
          hydratedPickedFiles.forEach((f) => {
            if (f.mimeType === 'application/vnd.google-apps.folder' || f.isFolder) {
              setExpandedFolders((prev) => new Set([...prev, f.name]));
            }
          });

          // Rule #1: Keep the Yjs room ID unified by `folderId` (NEVER split out to `mainTex.id`)
          const resolvedFolderId =
            targetFolderId ||
            pickedFolders[0]?.id ||
            pickedFiles[0]?.parentId ||
            (Array.isArray(hydratedPickedFiles[0]?.parents)
              ? hydratedPickedFiles[0].parents[0]
              : null) ||
            mainTex?.id;

          if (isValidDriveId(resolvedFolderId)) {
            setDriveFolderId(resolvedFolderId);
          }

          if (mainTex) {
            canWriteDriveFileRef.current = true;
            setSharedFolderNeedsFilePicker(false);
            setPickerToastMessage(null);
            setDriveFileId(mainTex.id);
            setDriveFileName(mainTex.name);
            setActiveFile(mainTex.name);
            setDriveSaveStatus('saved');

            const initialSavedMs = mainTex.modifiedTime
              ? new Date(mainTex.modifiedTime).getTime()
              : Date.now();
            lastSavedAtRef.current = initialSavedMs;
            setLastSavedAt(initialSavedMs);

            const folderName = driveFolderName || pickedFolders[0]?.name || null;
            const targetRoomId = getDeterministicRoomName(folderName || mainTex.name || 'project');

            if (
              collabSessionRef.current &&
              collabSessionRef.current.roomName === targetRoomId
            ) {
              collabSessionRef.current.updateLocalUserProfile({ canWriteDriveFile: true });
              collabSessionRef.current.updateProjectMeta({
                mainTexFileId: mainTex.id,
                mainTexFileName: mainTex.name,
                folderId: resolvedFolderId,
              });
              collabSessionRef.current.replaceDocumentFromDrive(mainTex.content || '', true);
              if (auxItems.length > 0) {
                collabSessionRef.current.mergeFolderAuxFiles(auxItems);
              }

              if (latexWorkerRef.current) {
                const memfsFiles = prepareMemfsAuxFiles(
                  collabSessionRef.current,
                  hydratedPickedFiles
                );
                latexWorkerRef.current.postMessage({
                  type: 'SYNC_MEMFS',
                  payload: { auxFiles: memfsFiles },
                });
                latexWorkerRef.current.postMessage({
                  type: 'COMPILE',
                  payload: {
                    jobId: Date.now(),
                    texSource: mainTex.content || '',
                    mainFile: mainTex.name || 'main.tex',
                    auxFiles: memfsFiles,
                    wasmScriptUrl: import.meta.env?.VITE_LATEX_WASM_URL || undefined,
                  },
                });
              }

              // If a save was pending prior to the 404 Google Picker fallback, complete the PATCH immediately
              if (pendingSaveAfterPickerRef.current && collabSessionRef.current.ytext.length > 0) {
                pendingSaveAfterPickerRef.current = false;
                try {
                  setDriveSaveStatus('saving');
                  const updateRes = await updateDriveFileContent(
                    mainTex.id,
                    collabSessionRef.current.ytext.toString()
                  );
                  const savedTimeMs = updateRes?.modifiedTime
                    ? new Date(updateRes.modifiedTime).getTime()
                    : Date.now();
                  lastSavedAtRef.current = savedTimeMs;
                  setLastSavedAt(savedTimeMs);
                  setDriveSaveStatus('saved');
                  setNextAutoSaveAt(null);
                  collabSessionRef.current.broadcastDriveSaveTimestamp(savedTimeMs);
                } catch {
                  // Ignore follow-up error if already handled
                }
              }
            } else {
              pendingRoomHydrationRef.current = {
                roomId: targetRoomId,
                mainTexFileId: mainTex.id,
                mainTexContent: mainTex.content || '',
                mainTexName: mainTex.name,
                folderId: resolvedFolderId,
                auxFiles: auxItems,
                folderFiles: hydratedPickedFiles,
                canWriteDriveFile: true,
                forceOverwrite: true,
              };
              setRoomInUrlHash(targetRoomId);
            }
          } else if (collabSessionRef.current && auxItems.length > 0) {
            collabSessionRef.current.mergeFolderAuxFiles(auxItems);
            if (latexWorkerRef.current) {
              const memfsFiles = prepareMemfsAuxFiles(
                collabSessionRef.current,
                hydratedPickedFiles
              );
              latexWorkerRef.current.postMessage({
                type: 'SYNC_MEMFS',
                payload: { auxFiles: memfsFiles },
              });
              // Requirement 2: Immediately trigger compileLatex() with newly mounted assets
              handleCompile(true);
            }
          }

          setIsLoadingFolder(false);
          await handleRefreshDriveFiles();
        }
      } catch (err) {
        setIsLoadingFolder(false);
        setDriveError(err?.message || 'Google Picker selection failed.');
      }
    },
    [driveFolderId, handleSelectDriveFolder, handleRefreshDriveFiles, handleCompile]
  );

  /**
   * Mandate 2: Opens a single `.tex` file directly from Google Drive using Google Picker.
   * Loads its real content into Yjs Y.Text, sets its parent folder as the immutable
   * Project Root Folder & Yjs Room ID, and triggers the Pre-Compilation Dependency Scanner.
   */
  const handleOpenTexFromDrive = useCallback(async () => {
    if (!getValidAccessToken()) return;
    setIsLoadingFolder(true);
    setDriveError(null);

    try {
      const result = await openGoogleDrivePicker({ mode: 'tex' });
      if (result.action !== 'picked' || result.items.length === 0) {
        setIsLoadingFolder(false);
        return;
      }

      const pickedTex =
        result.items.find(
          (f) => f.name.endsWith('.tex') || f.mimeType !== 'application/vnd.google-apps.folder'
        ) || result.items[0];

      if (!pickedTex) {
        setIsLoadingFolder(false);
        return;
      }

      const rawContent = await fetchDriveFileContent(pickedTex.id, false);
      const resolvedName = pickedTex.name || 'main.tex';

      let parentFolderId = pickedTex.parentId;
      if (!isValidDriveId(parentFolderId)) {
        try {
          const meta = await fetchDriveFileMetadata(pickedTex.id);
          parentFolderId = Array.isArray(meta.parents) ? meta.parents[0] : null;
        } catch {
          // Keep existing parentFolderId
        }
      }

      let parentFolderName = '';
      if (isValidDriveId(parentFolderId)) {
        try {
          const parentMeta = await fetchDriveFileMetadata(parentFolderId);
          if (parentMeta?.name) {
            parentFolderName = parentMeta.name;
          }
        } catch {
          // Keep existing parentFolderId
        }
      }

      // Shared deterministic room name based on parent folder or .tex file name
      const targetRoomId = getDeterministicRoomName(parentFolderName || pickedTex.name || 'project');

      canWriteDriveFileRef.current = true;
      setSharedFolderNeedsFilePicker(false);
      setDriveFileId(pickedTex.id);
      setDriveFileName(resolvedName);
      setActiveFile(resolvedName);
      if (isValidDriveId(parentFolderId)) {
        setDriveFolderId(parentFolderId);
      }
      setDriveSaveStatus('saved');

      const initialSavedMs = pickedTex.modifiedTime
        ? new Date(pickedTex.modifiedTime).getTime()
        : Date.now();
      lastSavedAtRef.current = initialSavedMs;
      setLastSavedAt(initialSavedMs);

      let siblingAuxFiles = [];
      if (isValidDriveId(parentFolderId)) {
        try {
          const folderFiles = await listAndFetchDriveFolderFiles(parentFolderId);
          setDriveFolderFiles(folderFiles);
          siblingAuxFiles = folderFiles.filter((f) => !f.name.endsWith('.tex'));
        } catch {
          // Sibling aux files might not be authorized yet
        }
      }

      if (collabSessionRef.current && collabSessionRef.current.roomName === targetRoomId) {
        collabSessionRef.current.updateLocalUserProfile({ canWriteDriveFile: true });
        collabSessionRef.current.updateProjectMeta({
          mainTexFileId: pickedTex.id,
          mainTexFileName: resolvedName,
          folderId: isValidDriveId(parentFolderId) ? parentFolderId : undefined,
        });
        collabSessionRef.current.replaceDocumentFromDrive(rawContent, true);
        if (siblingAuxFiles.length > 0) {
          collabSessionRef.current.mergeFolderAuxFiles(siblingAuxFiles);
        }
      } else {
        pendingRoomHydrationRef.current = {
          roomId: targetRoomId,
          mainTexFileId: pickedTex.id,
          mainTexContent: rawContent,
          mainTexName: resolvedName,
          folderId: isValidDriveId(parentFolderId) ? parentFolderId : undefined,
          auxFiles: siblingAuxFiles,
          canWriteDriveFile: true,
          forceOverwrite: true,
        };
        setRoomInUrlHash(targetRoomId);
      }

      setIsLoadingFolder(false);
      await handleRefreshDriveFiles();

      // Scan dependencies immediately upon loading main.tex
      window.setTimeout(() => {
        const detectedDeps = scanTexDependencies(rawContent);
        const currentPaths = new Set(
          siblingAuxFiles.map((f) => (f.path || f.name || '').replace(/^\.+\//, ''))
        );
        const missing = detectedDeps.filter((dep) => {
          if (currentPaths.has(dep.relativePath)) return false;
          if (dep.candidates && dep.candidates.some((c) => currentPaths.has(c))) return false;
          if (dep.relativePath === 'elsarticle.cls' || dep.relativePath.endsWith('.bst')) {
            return false;
          }
          return true;
        });

        if (missing.length > 0) {
          setMissingAssetsList(missing);
          setMissingAssetsModalOpen(true);
        }
      }, 400);
    } catch (err) {
      setIsLoadingFolder(false);
      setDriveError(err?.message || 'Failed to open .tex file from Google Drive.');
    }
  }, [handleRefreshDriveFiles]);

  /**
   * Mandate 2: Guided Missing-Files Authorization via multi-select Google Picker.
   * Matches picked documents against missing dependencies, mounts them at their exact
   * relative paths (e.g. output_figures/fig1.png), without altering the Root Project Folder.
   */
  const handleAuthorizeMissingFiles = useCallback(async () => {
    const currentSession = collabSessionRef.current;
    if (!currentSession || !getValidAccessToken()) return;

    setIsAuthorizingMissing(true);
    setDriveError(null);

    try {
      const result = await openGoogleDrivePicker({
        mode: 'missing_assets',
        parentFolderId: driveFolderId || undefined,
      });

      if (result.action !== 'picked' || result.items.length === 0) {
        setIsAuthorizingMissing(false);
        return;
      }

      // Match picked files against missing dependencies
      const matchedFiles = matchPickedFilesToDependencies(result.items, missingAssetsList);

      for (const item of matchedFiles) {
        const isImage = isImageAssetFile(item.relativePath, item.mimeType);
        const isBinary = isImage || /\.(pdf|eps)$/i.test(item.relativePath);
        const content = await fetchDriveFileContent(item.id, isBinary);

        const cleanRelPath = item.relativePath.replace(/^\.+\//, '').trim();
        const resolvedMimeType = isImage
          ? inferImageMimeType(cleanRelPath, item.mimeType)
          : item.mimeType || (isBinary ? 'application/octet-stream' : 'text/plain');

        currentSession.upsertAuxFile({
          id: item.id,
          name: item.name,
          path: cleanRelPath,
          mimeType: resolvedMimeType,
          size: content instanceof Uint8Array ? content.byteLength : content.length,
          modifiedTime: new Date().toISOString(),
          content,
        });

        if (latexWorkerRef.current) {
          latexWorkerRef.current.postMessage({
            type: 'SYNC_MEMFS',
            payload: { auxFiles: currentSession.getAuxFilesForMemFS() },
          });
        }
      }

      setMissingAssetsModalOpen(false);
      setMissingAssetsList([]);

      // Automatically resume compilation once assets are mounted
      window.setTimeout(() => {
        handleCompile(true);
      }, 150);
    } catch (err) {
      setDriveError(err?.message || 'Failed to authorize missing files from Google Drive.');
    } finally {
      setIsAuthorizingMissing(false);
    }
  }, [driveFolderId, missingAssetsList, handleCompile]);

  /**
   * Creates a new project folder in Google Drive (with starter `main.tex` and `references.bib`)
   * and immediately loads it into the workspace.
   */
  const handleCreateDriveFolder = useCallback(
    async (folderName) => {
      if (!getValidAccessToken()) return;
      setIsLoadingFolder(true);
      setDriveError(null);
      try {
        const createdFolder = await createDriveProjectFolder(folderName);
        await handleRefreshDriveFiles();
        await handleSelectDriveFolder(createdFolder.id, createdFolder.name);
      } catch (err) {
        setDriveError(err?.message || 'Failed to create Google Drive project folder.');
      } finally {
        setIsLoadingFolder(false);
      }
    },
    [handleRefreshDriveFiles, handleSelectDriveFolder]
  );

  /**
   * Creates a subfolder in Google Drive and in the Web Worker MEMFS.
   */
  const handleCreateSubfolder = useCallback(
    async (subfolderName) => {
      if (!subfolderName || !isValidDriveId(driveFolderId) || !getValidAccessToken()) return;
      const cleanPath = subfolderName.replace(/^\.+\//, '').trim();
      if (!cleanPath) return;

      try {
        await resolveOrCreateSubfolderId(driveFolderId, cleanPath, driveFolderFilesRef.current || []);
        if (latexWorkerRef.current) {
          latexWorkerRef.current.postMessage({
            type: 'MKDIR_MEMFS',
            payload: { path: cleanPath },
          });
        }
        await handleRefreshDriveFiles();
      } catch (err) {
        setDriveError(err?.message || `Failed to create subfolder "${cleanPath}" in Google Drive.`);
      }
    },
    [driveFolderId, handleRefreshDriveFiles]
  );

  /**
   * Uploads a local auxiliary file (`.bib`, `.sty`, `.cls`, or image) into MEMFS
   * and into the active Google Drive folder if one is open.
   * Supports relative paths for subfolders (e.g. `output_figures/fig1.png`).
   */
  const handleUploadLocalAuxFile = useCallback(
    async (file, optionalPath) => {
      const currentSession = collabSessionRef.current;
      if (!file || !currentSession) return;

      const rawPath = optionalPath || file.webkitRelativePath || file.name;
      const cleanName = rawPath.replace(/^\.+\//, '').replace(/\\/g, '/').trim();
      const isImage = isImageAssetFile(cleanName, file.type);
      const isBinaryAsset = isImage || /\.(pdf|eps)$/i.test(cleanName);
      const resolvedMimeType = isImage
        ? inferImageMimeType(cleanName, file.type)
        : file.type || 'text/plain';

      try {
        let content;
        if (isBinaryAsset) {
          const buf = await file.arrayBuffer();
          content = new Uint8Array(buf);
        } else {
          content = await file.text();
        }

        currentSession.upsertAuxFile({
          name: cleanName.split('/').pop(),
          path: cleanName,
          mimeType: resolvedMimeType,
          size: file.size || (content instanceof Uint8Array ? content.byteLength : content.length),
          content,
        });

        if (latexWorkerRef.current) {
          latexWorkerRef.current.postMessage({
            type: 'SYNC_MEMFS',
            payload: { auxFiles: currentSession.getAuxFilesForMemFS() },
          });
        }

        // Switch active view to the uploaded file (CodeMirror for text, Image Preview View for images)
        setActiveFile(cleanName);

        if (isValidDriveId(driveFolderId) && getValidAccessToken()) {
          const projectFilesSnapshot = [
            ...(driveFolderFilesRef.current || []),
            ...(currentSession.getAuxFilesForMemFS ? currentSession.getAuxFilesForMemFS() : []),
          ];
          const uploadedMeta = await uploadAuxFileToDriveFolder({
            folderId: driveFolderId,
            fileName: cleanName,
            content,
            mimeType: resolvedMimeType || 'application/octet-stream',
            projectFiles: projectFilesSnapshot,
          });

          if (uploadedMeta?.id) {
            currentSession.upsertAuxFile({
              id: uploadedMeta.id,
              parentId: Array.isArray(uploadedMeta.parents) ? uploadedMeta.parents[0] : undefined,
              parents: uploadedMeta.parents,
              name: cleanName.split('/').pop(),
              path: cleanName,
              mimeType: uploadedMeta.mimeType || resolvedMimeType,
              size: file.size || (content instanceof Uint8Array ? content.byteLength : content.length),
              modifiedTime: new Date().toISOString(),
              content,
            });
          }
        }
      } catch (err) {
        console.error('[Drive Upload Error]:', err);
        setDriveError(err?.message || `Failed to upload auxiliary file "${file.name}".`);
      }
    },
    [driveFolderId]
  );

  /**
   * Requirement #2: Deletes any project file (auxiliary asset or main.tex) from the Sidebar UI:
   *   1. Asks for user confirmation via `window.confirm`.
   *   2. Calls Google Drive API `PATCH https://www.googleapis.com/drive/v3/files/{fileId}`
   *      with `{ "trashed": true }`.
   *   3. Removes the file entry from the shared Yjs `auxFilesMap` / `projectMeta` and IndexedDB
   *      so all connected peers immediately see it disappear from their sidebars.
   *   4. Removes the file from the Web Worker's MEMFS (`DELETE_MEMFS_FILE`).
   */
  const handleDeleteProjectFile = useCallback(
    async (fileObj) => {
      const currentSession = collabSessionRef.current;
      if (!fileObj || !fileObj.path || !currentSession) return;

      const cleanPath = fileObj.path.replace(/^\.+\//, '').trim();
      const canonicalMainName = driveFileName || 'main.tex';
      const isMainFile =
        cleanPath.toLowerCase() === 'main.tex' ||
        cleanPath === canonicalMainName ||
        Boolean(fileObj.isMain);

      const confirmed = window.confirm(
        isMainFile
          ? `Delete main document "${cleanPath}" from Google Drive and clear it for all collaborators?`
          : `Delete "${cleanPath}" from Google Drive and remove it for all collaborators?`
      );
      if (!confirmed) return;

      setDriveError(null);

      try {
        // Resolve the Google Drive `fileId` from the item metadata or `driveFolderFiles`
        const matchedDriveFile = driveFolderFiles.find(
          (f) => f.id === fileObj.id || f.name === cleanPath || (isMainFile && f.id === driveFileId)
        );
        const targetDriveId = fileObj.id || matchedDriveFile?.id || (isMainFile ? driveFileId : null);

        // 2a. Move the file to trash in Google Drive REST API v3
        if (isValidDriveId(targetDriveId) && getValidAccessToken()) {
          try {
            await trashDriveFile(targetDriveId, driveFolderId);
          } catch (driveErr) {
            // If the file was already deleted or 404 in Drive, proceed with local/Yjs cleanup
            if (driveErr?.status !== 404) {
              throw driveErr;
            }
          }
        }

        // 2b. Remove the file entry from shared Yjs `auxFilesMap` / `projectMeta` & IndexedDB
        if (isMainFile) {
          canWriteDriveFileRef.current = false;
          setDriveFileId(null);
          currentSession.updateProjectMeta({
            mainTexFileId: null,
          });
          currentSession.ydoc.transact(() => {
            currentSession.ytext.delete(0, currentSession.ytext.length);
          });
        } else {
          currentSession.removeAuxFile(cleanPath);
        }

        setDriveFolderFiles((prev) =>
          prev.filter((f) => f.id !== targetDriveId && f.name !== cleanPath)
        );

        // 2c. Remove the file from the Web Worker's MEMFS
        if (latexWorkerRef.current) {
          latexWorkerRef.current.postMessage({
            type: 'DELETE_MEMFS_FILE',
            payload: { path: cleanPath },
          });
        }

        // If the deleted file was currently open in the editor/preview, return to `main.tex`
        if (activeFile === cleanPath) {
          setActiveFile(canonicalMainName);
        }
      } catch (err) {
        setDriveError(err?.message || `Failed to delete "${cleanPath}" from Google Drive.`);
      }
    },
    [driveFileName, driveFileId, driveFolderFiles, driveFolderId, activeFile]
  );

  /**
   * Inserts a `\begin{figure} ... \includegraphics{...} \end{figure}` snippet into `main.tex`.
   */
  const handleInsertFigureSnippet = useCallback(
    (figurePath) => {
      const currentSession = collabSessionRef.current;
      if (!currentSession || !figurePath) return;

      const mainName = driveFileName || 'main.tex';
      setActiveFile(mainName);

      const snippet = `\n\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{${figurePath}}\n  \\caption{Included figure (${figurePath}).}\n\\end{figure}\n`;
      const currentText = currentSession.ytext.toString();
      const endDocIndex = currentText.lastIndexOf('\\end{document}');

      currentSession.ydoc.transact(() => {
        if (endDocIndex !== -1) {
          currentSession.ytext.insert(endDocIndex, snippet);
        } else {
          currentSession.ytext.insert(currentSession.ytext.length, snippet);
        }
      });
    },
    [driveFileName]
  );

  /**
   * Creates a new `.tex` file inside the current Google Drive folder.
   * Keeps the Yjs room ID unified by `driveFolderId` (Rule #1) and updates `projectMeta` (Rule #3).
   */
  const handleCreateDriveFile = useCallback(
    async (requestedName = 'main.tex') => {
      const currentSession = collabSessionRef.current;
      if (!getValidAccessToken()) return;

      try {
        setDriveSaveStatus('saving');
        setDriveError(null);
        const currentTex =
          currentSession && currentSession.ytext.length > 0
            ? currentSession.ytext.toString()
            : NEW_PROJECT_MAIN_TEX_TEMPLATE;

        const created = await createDriveTexFile(
          requestedName,
          currentTex,
          isValidDriveId(driveFolderId) ? driveFolderId : undefined
        );

        const now = Date.now();
        const resolvedName = created.name || requestedName;
        canWriteDriveFileRef.current = true;
        setSharedFolderNeedsFilePicker(false);
        setDriveFileId(created.id);
        setDriveFileName(resolvedName);
        setActiveFile(resolvedName);
        const createdMs = created.modifiedTime ? new Date(created.modifiedTime).getTime() : now;
        lastSavedAtRef.current = createdMs;
        setLastSavedAt(createdMs);
        setDriveSaveStatus('saved');
        setNextAutoSaveAt(null);

        // Shared deterministic room name based on folder or newly created .tex file
        const targetRoomId = getDeterministicRoomName(driveFolderName || resolvedName);

        if (currentSession && currentSession.roomName === targetRoomId) {
          currentSession.updateLocalUserProfile({ canWriteDriveFile: true });
          currentSession.updateProjectMeta({
            mainTexFileId: created.id,
            mainTexFileName: resolvedName,
            folderId: isValidDriveId(driveFolderId) ? driveFolderId : undefined,
          });
          currentSession.broadcastDriveSaveTimestamp(createdMs);
        } else {
          pendingRoomHydrationRef.current = {
            roomId: targetRoomId,
            mainTexFileId: created.id,
            mainTexContent: currentTex,
            mainTexName: resolvedName,
            folderId: isValidDriveId(driveFolderId) ? driveFolderId : undefined,
            auxFiles: [],
            canWriteDriveFile: true,
            forceOverwrite: false,
          };
          setRoomInUrlHash(targetRoomId);
        }

        await handleRefreshDriveFiles();
      } catch (err) {
        setDriveSaveStatus('error');
        setDriveError(err?.message || 'Failed to create .tex file on Google Drive.');
      }
    },
    [driveFolderId, handleRefreshDriveFiles]
  );

  /**
   * Creates any new project file (e.g. `section1.tex`, `references.bib`, `custom.sty`)
   * inside the active Yjs session / MEMFS and uploads it to the Google Drive project folder.
   */
  const handleCreateProjectFile = useCallback(
    async (requestedName) => {
      if (!requestedName || !requestedName.trim()) return;
      const cleanName = requestedName.trim().replace(/^\.+\//, '');
      const currentSession = collabSessionRef.current;

      // If creating the primary main.tex when no main file exists yet
      if (cleanName.toLowerCase() === 'main.tex' && !driveFileId) {
        await handleCreateDriveFile(cleanName);
        return;
      }

      if (!currentSession) return;

      const starterContent = cleanName.endsWith('.bib')
        ? `% Bibliography Database (${cleanName})\n`
        : cleanName.endsWith('.sty') || cleanName.endsWith('.cls')
        ? `% Custom Package (${cleanName})\n`
        : `% ${cleanName}\n`;

      const mimeType = cleanName.endsWith('.tex')
        ? 'text/x-tex'
        : 'text/plain';

      try {
        currentSession.upsertAuxFile({
          name: cleanName.split('/').pop(),
          path: cleanName,
          mimeType,
          size: starterContent.length,
          content: starterContent,
        });

        if (latexWorkerRef.current) {
          latexWorkerRef.current.postMessage({
            type: 'SYNC_MEMFS',
            payload: {
              auxFiles: prepareMemfsAuxFiles(
                currentSession,
                driveFolderFilesRef.current || []
              ),
            },
          });
        }

        setActiveFile(cleanName);

        if (isValidDriveId(driveFolderId) && getValidAccessToken()) {
          const projectFilesSnapshot = [
            ...(driveFolderFilesRef.current || []),
            ...(currentSession.getAuxFilesForMemFS ? currentSession.getAuxFilesForMemFS() : []),
          ];
          const uploaded = await uploadAuxFileToDriveFolder({
            folderId: driveFolderId,
            fileName: cleanName,
            content: starterContent,
            mimeType,
            projectFiles: projectFilesSnapshot,
          });
          if (uploaded?.id) {
            currentSession.upsertAuxFile({
              id: uploaded.id,
              name: cleanName.split('/').pop(),
              path: cleanName,
              mimeType,
              size: starterContent.length,
              modifiedTime: new Date().toISOString(),
              content: starterContent,
            });
          }
        }
      } catch (err) {
        console.error('[Drive Upload Error]:', err);
        setDriveError(err?.message || `Failed to create file "${cleanName}".`);
      }
    },
    [driveFileId, driveFolderId, handleCreateDriveFile]
  );

  /**
   * Executes the Google Drive `PATCH` for `main.tex` from the Elected Save Leader,
   * updates `projectMeta.set('lastSavedAt', Date.now())` and `projectMeta.set('saveStatus', 'saved')`,
   * and implements the graceful HTTP 404 Fallback (Requirement #3) if a former Follower
   * becomes the sole Leader before authorizing `main.tex` in Google Picker.
   */
  const executeLeaderDrivePatch = useCallback(
    async (sessionOverride) => {
      const currentSession = sessionOverride || collabSessionRef.current;
      if (!currentSession || isSessionExpiredRef.current || !getValidAccessToken()) return;

      const currentFileId =
        driveFileIdRef.current || currentSession.projectMeta?.get('mainTexFileId');

      if (!isValidDriveId(currentFileId)) {
        // User has not authorized main.tex in Google Picker yet — trigger graceful Picker flow
        setDriveError(null);
        setDriveSaveStatus('idle');
        setPickerToastMessage(
          'Please select main.tex in the Google Drive window to grant edit access to this document.'
        );
        pendingSaveAfterPickerRef.current = true;
        handleOpenGooglePicker('files');
        return;
      }

      try {
        setDriveSaveStatus('saving');
        setDriveError(null);

        // Check for external Drive modifications before overwriting if no other peers are connected
        const currentSavedBaseline = lastSavedAtRef.current ?? lastSavedAt;
        if (currentSavedBaseline && currentSession.awareness) {
          const peers = Array.from(currentSession.awareness.getStates().values()).filter(
            (state) => state?.user && state.user.clientId !== currentSession.ydoc.clientID
          );
          if (peers.length === 0) {
            try {
              const remoteMeta = await fetchDriveFileMetadata(currentFileId);
              if (remoteMeta && remoteMeta.modifiedTime) {
                const remoteModifiedMs = new Date(remoteMeta.modifiedTime).getTime();
                // If remote modifiedTime is newer than our last known save by more than 5 seconds
                if (remoteModifiedMs > currentSavedBaseline + 5000) {
                  console.warn(
                    `[OpenDriveTeX] External modification detected in Google Drive (${remoteMeta.modifiedTime} > ${new Date(currentSavedBaseline).toISOString()}); proceeding with save.`
                  );
                }
              }
            } catch {
              // Ignore metadata pre-check errors and continue with save attempt
            }
          }
        }

        const updateRes = await updateDriveFileContent(currentFileId, currentSession.ytext.toString());
        const savedTimeMs = updateRes?.modifiedTime
          ? new Date(updateRes.modifiedTime).getTime()
          : Date.now();
        canWriteDriveFileRef.current = true;
        currentSession.updateLocalUserProfile({ canWriteDriveFile: true });
        lastSavedAtRef.current = savedTimeMs;
        setLastSavedAt(savedTimeMs);
        setDriveSaveStatus('saved');
        setNextAutoSaveAt(null);
        setPickerToastMessage(null);
        currentSession.broadcastDriveSaveTimestamp(savedTimeMs);
      } catch (err) {
        const is404 =
          err?.status === 404 ||
          String(err?.message || '').includes('404') ||
          String(err?.message || '').includes('grant edit access') ||
          String(err?.message || '').includes('grant save permission');

        if (is404) {
          // Requirement #3: 404 Fallback when Follower becomes Leader under `drive.file` scope.
          // Demote `canWriteDriveFile` so if another authorized peer is online they become Leader;
          // otherwise automatically open Google Picker pre-filtered to the project folder with a toast.
          canWriteDriveFileRef.current = false;
          currentSession.updateLocalUserProfile({ canWriteDriveFile: false });
          setDriveError(null);

          const nextElection = currentSession.getLeaderElectionState();
          if (!nextElection.isLocalLeader && nextElection.leaderClientId !== null) {
            setDriveSaveStatus('saving');
            currentSession.requestManualSaveViaLeader(Date.now());
            return;
          }

          setDriveSaveStatus('idle');
          setPickerToastMessage(
            'Please select main.tex in the Google Drive window to grant edit access to this document.'
          );
          pendingSaveAfterPickerRef.current = true;
          handleOpenGooglePicker('files');
          return;
        }

        if (err?.message === 'SESSION_EXPIRED') {
          setDriveSaveStatus('idle');
          return;
        }

        setDriveSaveStatus('error');
        setDriveError(
          `${err?.message || 'Save to Google Drive failed.'} Your changes remain safely preserved locally in IndexedDB; you can retry saving.`
        );
      } finally {
        // Ensure UI is never left permanently stuck in 'saving' state
        setDriveSaveStatus((prev) => (prev === 'saving' ? 'idle' : prev));
      }
    },
    [handleOpenGooglePicker]
  );

  executeLeaderDrivePatchRef.current = executeLeaderDrivePatch;

  /**
   * Requirement #1: Explicit manual save (`Ctrl+S` or clicking "Save to Drive" in Navbar).
   * Routes all manual saves through the Elected Save Leader:
   * - If the current tab is a Follower Replica (`!election.isLocalLeader`) and there is an
   *   active Leader in the room, does NOT call Google Drive PATCH directly; instead writes
   *   `projectMeta.set('manualSaveRequestedAt', Date.now())` so the Leader executes the PATCH.
   * - If the current tab IS the Elected Leader, executes `executeLeaderDrivePatch` directly.
   */
  const handleManualSaveToDrive = useCallback(async () => {
    tryProactiveRefreshOnUserActivity();
    const currentSession = collabSessionRef.current;
    if (!currentSession || isSessionExpiredRef.current) return;

    const election = currentSession.getLeaderElectionState();

    // Requirement #1: Follower Replica delegates manual save to the Elected Save Leader via `projectMeta`
    if (!election.isLocalLeader && election.leaderClientId !== null) {
      setDriveError(null);
      setDriveSaveStatus('saving');
      setNextAutoSaveAt(null);
      currentSession.requestManualSaveViaLeader(Date.now());
      return;
    }

    if (!getValidAccessToken()) {
      if (isDriveAuthenticated) {
        isSessionExpiredRef.current = true;
        setIsSessionExpired(true);
      } else {
        setDriveError('Please sign in with Google Drive to save.');
      }
      return;
    }
    await executeLeaderDrivePatch(currentSession);
  }, [executeLeaderDrivePatch, isDriveAuthenticated]);

  // Listen for OAuth2 session expiration events and renew proactively on real user pointer activity
  useEffect(() => {
    const handleSessionExpired = () => {
      isSessionExpiredRef.current = true;
      setIsSessionExpired(true);
      setNextAutoSaveAt(null);
    };

    const handleGlobalPointerDown = () => {
      if (!isSessionExpiredRef.current) {
        tryProactiveRefreshOnUserActivity();
      }
    };

    window.addEventListener('opendrivetex:session-expired', handleSessionExpired);
    window.addEventListener('pointerdown', handleGlobalPointerDown);
    return () => {
      window.removeEventListener('opendrivetex:session-expired', handleSessionExpired);
      window.removeEventListener('pointerdown', handleGlobalPointerDown);
    };
  }, []);

  const handleReconnectAndReloadFromDrive = useCallback(async () => {
    setIsReconnecting(true);
    try {
      await refreshTokenFromUserGesture();

      const currentSession = collabSessionRef.current;
      const activeFolderId =
        (isValidDriveId(driveFolderId) ? driveFolderId : null) ||
        (isValidDriveId(currentSession?.projectMeta?.get('folderId'))
          ? currentSession.projectMeta.get('folderId')
          : null);
      const activeFileId =
        (isValidDriveId(driveFileIdRef.current) ? driveFileIdRef.current : null) ||
        (isValidDriveId(currentSession?.projectMeta?.get('mainTexFileId'))
          ? currentSession.projectMeta.get('mainTexFileId')
          : null);

      if (currentSession) {
        currentSession.setLocalDriveAuthStatus(true);

        if (activeFolderId && reconcileSessionWithDriveFolderRef.current) {
          await reconcileSessionWithDriveFolderRef.current(currentSession, activeFolderId, null, {
            forceOverwriteText: true,
          });
        }

        if (activeFileId) {
          try {
            const freshTexContent = await fetchDriveFileContent(activeFileId, false);
            if (typeof freshTexContent === 'string') {
              currentSession.replaceDocumentFromDrive(freshTexContent, true);
            }
          } catch (fileErr) {
            console.warn('[OpenDriveTeX] Could not reload main .tex after reconnect:', fileErr);
          }
        }
      }

      isSessionExpiredRef.current = false;
      setIsSessionExpired(false);
      setDriveError(null);
    } catch (err) {
      setDriveError(
        err?.message || 'No se pudo reconectar con Google Drive. Inténtalo de nuevo.'
      );
    } finally {
      setIsReconnecting(false);
    }
  }, [driveFolderId]);

  /**
   * Scans target text or all project files for pending review items.
   */
  const checkPendingReviewItems = useCallback((targetType = 'tex') => {
    const currentSession = collabSessionRef.current;
    if (!currentSession) {
      return { comments: 0, additions: 0, deletions: 0, total: 0, items: [] };
    }

    const mainText = currentSession.ytext.toString();
    const mainItems = scanReviewItems(mainText);

    if (targetType === 'tex') {
      return { ...countReviewItems(mainText), items: mainItems };
    }

    let comments = 0;
    let additions = 0;
    let deletions = 0;
    const allItems = [...mainItems];

    for (const item of mainItems) {
      if (item.type === 'comment') comments++;
      else if (item.type === 'add') additions++;
      else if (item.type === 'del') deletions++;
    }

    if (currentSession.auxFilesMap) {
      const iterate = (fn) => {
        if (typeof currentSession.auxFilesMap.forEach === 'function') {
          currentSession.auxFilesMap.forEach(fn);
        } else {
          Object.entries(currentSession.auxFilesMap).forEach(([k, v]) => fn(v, k));
        }
      };

      iterate((entry, path) => {
        if (path && path.endsWith('.tex')) {
          let text = '';
          if (typeof entry?.content === 'string') text = entry.content;
          else if (entry?.content instanceof Uint8Array) {
            text = new TextDecoder('utf-8').decode(entry.content);
          }
          const auxItems = scanReviewItems(text);
          allItems.push(...auxItems);
          for (const item of auxItems) {
            if (item.type === 'comment') comments++;
            else if (item.type === 'add') additions++;
            else if (item.type === 'del') deletions++;
          }
        }
      });
    }

    return {
      comments,
      additions,
      deletions,
      total: comments + additions + deletions,
      items: allItems,
    };
  }, []);

  /**
   * Executes the actual clean .tex download.
   */
  const executeCleanTexDownload = useCallback(() => {
    const currentSession = collabSessionRef.current;
    if (!currentSession) return;
    const cleanTex = sanitizeTexForSubmission(currentSession.ytext.toString());
    const downloadName = (driveFileName || 'manuscript.tex').endsWith('.tex')
      ? driveFileName || 'manuscript.tex'
      : `${driveFileName}.tex`;
    triggerFileDownload(cleanTex, downloadName, 'text/x-tex;charset=utf-8');
  }, [driveFileName]);

  /**
   * Executes the actual clean project .zip download.
   */
  const executeCleanZipDownload = useCallback(async () => {
    const currentSession = collabSessionRef.current;
    if (!currentSession) return;
    const zipBlob = await createCleanSubmissionZipBlob(
      driveFolderName || 'project',
      driveFileName || 'main.tex',
      currentSession.ytext.toString(),
      currentSession.auxFilesMap
    );
    const projectName = (driveFolderName || 'manuscript').replace(/[^a-zA-Z0-9_-]/g, '_');
    triggerFileDownload(zipBlob, `${projectName}-submission.zip`, 'application/zip');
  }, [driveFolderName, driveFileName]);

  /**
   * Initiates Clean .tex Export with Pre-Flight Check.
   */
  const handleExportSubmissionTex = useCallback(() => {
    const check = checkPendingReviewItems('tex');
    if (check.total > 0) {
      setPreFlightModalState({
        isOpen: true,
        exportType: 'tex',
        counts: check,
      });
    } else {
      executeCleanTexDownload();
    }
  }, [checkPendingReviewItems, executeCleanTexDownload]);

  /**
   * Initiates Clean Project .zip Export with Pre-Flight Check.
   */
  const handleExportSubmissionZip = useCallback(() => {
    const check = checkPendingReviewItems('zip');
    if (check.total > 0) {
      setPreFlightModalState({
        isOpen: true,
        exportType: 'zip',
        counts: check,
      });
    } else {
      executeCleanZipDownload();
    }
  }, [checkPendingReviewItems, executeCleanZipDownload]);

  /**
   * Offline local `.tex` source download.
   */
  const handleExportTex = useCallback(() => {
    const currentSession = collabSessionRef.current;
    if (!currentSession) return;

    const texContent = currentSession.ytext.toString();
    const blob = new Blob([texContent], { type: 'text/x-tex;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);

    const downloadName = (driveFileName || 'manuscript.tex').endsWith('.tex')
      ? driveFileName || 'manuscript.tex'
      : `${driveFileName}.tex`;

    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = downloadName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }, [driveFileName]);

  /**
   * Offline local `.pdf` download.
   */
  const handleExportPdf = useCallback(() => {
    if (!pdfBuffer || !(pdfBuffer instanceof Uint8Array) || pdfBuffer.byteLength === 0) {
      return;
    }

    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    const objectUrl = URL.createObjectURL(blob);

    const baseName = (driveFileName || 'manuscript.tex').replace(/\.tex$/i, '');
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `${baseName}.pdf`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }, [pdfBuffer, driveFileName]);

  // Global keyboard shortcuts for `Ctrl+Enter` (Compile), `Ctrl+S` (Save), and `Ctrl+F` (Context-Aware Search)
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      // Context-aware search (Ctrl+F / Cmd+F)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();

        const activeElement = document.activeElement;
        const isEditorFocused =
          lastActivePaneRef.current === 'editor' ||
          (activeElement && activeElement.closest('.cm-editor'));

        if (isEditorFocused && editorViewInstanceRef.current) {
          const view = editorViewInstanceRef.current;
          view.focus();
          openSearchPanel(view);
        } else if (pdfIframeRef.current) {
          // Focus the PDF preview iframe or trigger its search
          try {
            pdfIframeRef.current.focus();
            if (pdfIframeRef.current.contentWindow) {
              pdfIframeRef.current.contentWindow.focus();
            }
          } catch {
            // Ignore cross-origin issues
          }
        }
        return;
      }

      if (!collabSessionRef.current) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        tryProactiveRefreshOnUserActivity();
        handleCompile();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const election = collabSessionRef.current.getLeaderElectionState();
        if (getValidAccessToken() || election.leaderClientId !== null) {
          handleManualSaveToDrive();
        } else {
          handleExportTex();
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, { capture: true });
    };
  }, [handleCompile, handleManualSaveToDrive, handleExportTex]);

  // Accidental Tab Close Protection (`beforeunload` warning when there are unsaved changes)
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      const currentSession = collabSessionRef.current;
      if (!currentSession) return;
      const isDirty = driveSaveStatus === 'dirty';
      const peersCount = currentSession.awareness
        ? currentSession.awareness.getStates().size
        : 1;

      if (isDirty || (peersCount <= 1 && isDirty)) {
        // Attempt an immediate Drive save before the tab closes
        handleManualSaveToDrive();
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [driveSaveStatus, handleManualSaveToDrive]);

  const hasCompiledPdf = Boolean(pdfBuffer && pdfBuffer.byteLength > 0);

  // Requirement #3: Resolve whether the currently selected sidebar file is an image asset
  const activeAuxEntry =
    auxFiles.find((f) => f.path === activeFile || f.name === activeFile) ||
    driveFolderFiles.find((f) => f.path === activeFile || f.name === activeFile) ||
    null;

  let activeImageAsset = null;
  if (
    activeAuxEntry &&
    (activeAuxEntry.isBinary ||
      activeAuxEntry.category === 'figure' ||
      isImageAssetFile(activeAuxEntry.path || activeAuxEntry.name, activeAuxEntry.mimeType))
  ) {
    let content = activeAuxEntry.content;
    if (!content && driveFolderFiles.length > 0) {
      const match = driveFolderFiles.find(
        (f) =>
          f.path === activeAuxEntry.path ||
          f.name === activeAuxEntry.name ||
          (activeAuxEntry.id && f.id === activeAuxEntry.id)
      );
      if (match?.content) content = match.content;
    }
    const bin = normalizeBinaryContent(content);
    activeImageAsset = {
      ...activeAuxEntry,
      content: bin || content,
    };
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden relative">
      {/* Requirement #3: 404 Fallback Toast Notification when Follower becomes Leader */}
      {pickerToastMessage && (
        <div
          role="status"
          aria-live="polite"
          data-testid="picker-permission-toast"
          className="fixed bottom-5 right-5 z-50 max-w-md bg-slate-900/95 border border-amber-500/60 rounded-xl p-4 shadow-2xl shadow-black/60 flex items-start gap-3 text-xs text-amber-100 backdrop-blur-md"
        >
          <FolderSearch className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-2 flex-1">
            <div className="font-semibold text-amber-200">
              Google Drive Save Permission Needed
            </div>
            <p className="text-slate-200 leading-relaxed">{pickerToastMessage}</p>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => handleOpenGooglePicker('files')}
                className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold transition-colors cursor-pointer"
              >
                Open Google Picker
              </button>
              <button
                type="button"
                onClick={() => setPickerToastMessage(null)}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top Bar */}
      <Navbar
        collabSession={collabSession}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
        isPdfVisible={isPdfVisible}
        onTogglePdfVisible={handleTogglePdfVisible}
        onCompile={() => {
          tryProactiveRefreshOnUserActivity();
          handleCompile();
        }}
        isCompiling={compileStatus === 'compiling'}
        isDriveAuthenticated={isDriveAuthenticated}
        driveFileId={driveFileId}
        driveFolderId={driveFolderId}
        driveFolderName={driveFolderName}
        driveSaveStatus={driveSaveStatus}
        onManualSaveToDrive={handleManualSaveToDrive}
        onOpenFromDrive={() => handleOpenGooglePicker('folder')}
        onExportSubmissionTex={handleExportSubmissionTex}
        onExportSubmissionZip={handleExportSubmissionZip}
        onExportPdf={handleExportPdf}
      />

      {/* Main Split-Screen Workspace */}
      <main className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        {/* Left Collapsible Sidebar */}
        <Sidebar
          isOpen={isSidebarOpen}
          collabSession={collabSession}
          activeFile={activeFile}
          onSelectFile={setActiveFile}
          auxFiles={auxFiles}
          expandedFolders={expandedFolders}
          setExpandedFolders={setExpandedFolders}
          onUploadLocalAuxFile={handleUploadLocalAuxFile}
          onCreateSubfolder={handleCreateSubfolder}
          onCreateProjectFile={handleCreateProjectFile}
          onDeleteProjectFile={handleDeleteProjectFile}
          onSyncFromDrive={handleSyncFromDrive}
          isSyncingFromDrive={isSyncingFromDrive}
          isDriveAuthenticated={isDriveAuthenticated}
          driveFileId={driveFileId}
          driveFileName={driveFileName}
          driveFolderId={driveFolderId}
          driveFolderName={driveFolderName}
          driveSaveStatus={driveSaveStatus}
          driveError={driveError}
          lastSavedAt={lastSavedAt}
          nextAutoSaveAt={nextAutoSaveAt}
          onConnectDrive={handleConnectDrive}
          onDisconnectDrive={handleDisconnectDrive}
          onOpenGooglePicker={handleOpenGooglePicker}
          theme={theme}
          onToggleTheme={handleToggleTheme}
          isTrackingChanges={isTrackingChanges}
          onToggleTrackChanges={handleToggleTrackChanges}
          onOpenAddComment={handleTriggerAddComment}
          isReviewPanelOpen={isReviewPanelOpen}
          onToggleReviewPanel={() => setIsReviewPanelOpen((prev) => !prev)}
          reviewItemsCount={reviewItems.length}
        />

        {/* Center & Right Workspace OR Welcome / Open Drive Folder Screen */}
        {collabSession ? (
          <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
            {/* Google Drive Security (drive.file) Authorization Banner */}
            {sharedFolderNeedsFilePicker && (
              <div
                role="alert"
                className="px-4 py-2.5 bg-indigo-950/90 border-b border-indigo-500/50 flex flex-wrap items-center justify-between gap-3 text-xs text-indigo-100 shrink-0 shadow-sm"
              >
                <div className="flex items-center gap-2.5 max-w-3xl">
                  <ShieldCheck className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                  <div className="leading-snug">
                    <span className="font-semibold text-indigo-200 mr-1.5">
                      Google Drive Security (<code className="font-mono text-indigo-300">drive.file</code>):
                    </span>
                    <span>
                      To load existing files uploaded outside OpenDriveTeX, click &ldquo;Authorize Project Files&rdquo;,
                      open your folder in the popup, press <kbd className="px-1 py-0.5 rounded bg-indigo-900 border border-indigo-700 font-mono text-[11px] text-white">Ctrl+A</kbd> to
                      select your <code className="font-mono text-indigo-300">main.tex</code> and figures, and click Select.
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleOpenGooglePicker('files')}
                  className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-semibold flex items-center gap-1.5 shrink-0 shadow transition-colors cursor-pointer"
                >
                  <FolderSearch className="w-3.5 h-3.5" />
                  <span>Authorize Project Files</span>
                </button>
              </div>
            )}

            {/* Resizable Split Pane Container */}
            <div
              ref={splitContainerRef}
              className="flex-1 flex min-h-0 min-w-0 overflow-hidden relative"
            >
              {/* Left/Center Editor Pane */}
              <div
                className="h-full min-h-0 min-w-0 overflow-hidden"
                style={{
                  width: isPdfVisible ? `${splitRatio}%` : '100%',
                }}
              >
                <EditorPane
                  collabSession={collabSession}
                  activeFileName={activeFile}
                  activeImageAsset={activeImageAsset}
                  onBackToMainTex={() => setActiveFile(driveFileName || 'main.tex')}
                  onInsertFigureSnippet={handleInsertFigureSnippet}
                  onCompileShortcut={handleCompile}
                  onSaveShortcut={
                    isDriveAuthenticated ? handleManualSaveToDrive : handleExportTex
                  }
                  theme={theme}
                  isPdfVisible={isPdfVisible}
                  onTogglePdfVisible={handleTogglePdfVisible}
                  userProfile={userProfile}
                  isReviewPanelOpen={isReviewPanelOpen}
                  setIsReviewPanelOpen={setIsReviewPanelOpen}
                  reviewTargetItem={reviewTargetItem}
                  isTrackingChanges={isTrackingChanges}
                  onToggleTrackChanges={handleToggleTrackChanges}
                  triggerAddCommentKey={triggerAddCommentKey}
                  onReviewItemsChange={setReviewItems}
                  onFocusChange={(pane) => {
                    lastActivePaneRef.current = pane;
                  }}
                  editorViewExposeRef={editorViewInstanceRef}
                />
              </div>

              {/* Draggable Vertical Splitter Handle */}
              {isPdfVisible && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize Editor and PDF Preview Panes"
                  data-testid="split-pane-resizer"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setIsResizingSplit(true);
                  }}
                  className={`w-1.5 hover:w-2 shrink-0 cursor-col-resize flex items-center justify-center transition-colors z-30 select-none ${
                    isResizingSplit
                      ? 'bg-indigo-500'
                      : 'bg-slate-800 hover:bg-indigo-500/80'
                  }`}
                  title="Drag left or right to resize Editor and PDF Preview panes"
                >
                  <div className="w-0.5 h-8 rounded-full bg-slate-500/70 pointer-events-none" />
                </div>
              )}

              {/* Right PDF Preview Pane */}
              {isPdfVisible && (
                <div
                  className={`h-full min-h-0 min-w-0 overflow-hidden flex-1 ${
                    isResizingSplit ? 'pointer-events-none' : ''
                  }`}
                >
                  <PdfPreview
                    pdfBuffer={pdfBuffer}
                    compileStatus={compileStatus}
                    compileLogs={compileLogs}
                    compileStdout={compileStdout}
                    compileStderr={compileStderr}
                    compileErrors={compileErrors}
                    compileWarnings={compileWarnings}
                    compileElapsedMs={compileElapsedMs}
                    engineName={engineName}
                    onTriggerCompile={handleCompile}
                    onFocusChange={(pane) => {
                      lastActivePaneRef.current = pane;
                    }}
                    iframeRef={pdfIframeRef}
                  />
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Requirement #2: Empty Workspace on Startup (Folder-First Workflow) */
          <section
            className="flex-1 flex items-center justify-center p-6 overflow-y-auto bg-gradient-to-b from-slate-950 via-slate-900/60 to-slate-950"
            aria-label="Welcome and Open Google Drive Project Folder"
            data-testid="welcome-folder-screen"
          >
            <div className="max-w-2xl w-full bg-slate-900/85 border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-6">
              {/* Header */}
              <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-5">
                <div className="flex items-center gap-3.5">
                  <img
                    src="/icon.svg"
                    alt="OpenDriveTeX"
                    className="w-12 h-12 rounded-xl shadow-lg shadow-indigo-500/20 shrink-0"
                  />
                  <div>
                    <h1 className="text-xl font-bold text-slate-100 tracking-tight">
                      Welcome to OpenDriveTeX
                    </h1>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Collaborative LaTeX Editor
                    </p>
                  </div>
                </div>

                {userProfile && (
                  <div className="flex items-center gap-2 bg-slate-950/80 border border-slate-800 rounded-full px-3 py-1">
                    {userProfile.picture ? (
                      <img
                        src={userProfile.picture}
                        alt={userProfile.name}
                        referrerPolicy="no-referrer"
                        className="w-5 h-5 rounded-full object-cover"
                      />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    )}
                    <span className="text-xs font-medium text-slate-200 truncate max-w-[150px]">
                      {userProfile.name}
                    </span>
                  </div>
                )}
              </div>

              {/* Error Banner if any */}
              {driveError && (
                <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <div className="font-semibold text-rose-100">Google Drive Notice</div>
                    <p className="leading-relaxed">{driveError}</p>
                  </div>
                </div>
              )}

              {/* Pending Google Drive `?state=` Open-With Prompt */}
              {pendingOpenWithId && !isDriveAuthenticated && (
                <div className="p-4 rounded-xl bg-indigo-950/50 border border-indigo-500/40 text-xs text-indigo-100 flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="font-semibold flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-indigo-400" />
                      <span>Google Drive &ldquo;Open With&rdquo; Request Detected</span>
                    </div>
                    <p className="text-slate-300">
                      Sign in with Google to open target ID{' '}
                      <code className="font-mono text-indigo-300">{pendingOpenWithId}</code>.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleConnectDrive}
                    className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold shrink-0 cursor-pointer"
                  >
                    Authenticate &amp; Open
                  </button>
                </div>
              )}

              {/* Step 1 (Not Signed In) vs Step 2 (Signed In — Open or Create Folder) */}
              {!isDriveAuthenticated ? (
                <div className="space-y-4">
                  <p className="text-sm text-slate-300 leading-relaxed">
                    Connect your Google Drive account to open an existing{' '}
                    <span className="font-serif italic">LaTeX</span> project folder (including
                    folders shared with you) or create a new manuscript folder.
                  </p>

                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={handleConnectDrive}
                      className="w-full py-3 px-4 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold flex items-center justify-center gap-2.5 shadow-lg shadow-sky-600/25 transition-all cursor-pointer"
                    >
                      <HardDrive className="w-4 h-4" />
                      <span>Sign in with Google Drive</span>
                    </button>
                  </div>
                </div>
              ) : isLoadingFolder ? (
                <div className="py-12 flex flex-col items-center justify-center gap-3 text-slate-300">
                  <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
                  <div className="text-sm font-semibold">
                    Loading Google Drive Project Folder...
                  </div>
                  <div className="text-xs text-slate-400 font-mono">
                    Syncing main.tex into Yjs CRDT &amp; auxiliary assets into Worker MEMFS
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Primary Actions: Unified Open from Drive or Create New Project Folder */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Action 1: Unified Open from Google Drive */}
                    <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-4">
                      <div className="space-y-1.5">
                        <div className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                          <FolderSearch className="w-4 h-4 text-indigo-400" />
                          <span>Open from Drive</span>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Select a project folder or an existing <code className="text-indigo-300 font-mono">.tex</code> manuscript from <em>My Drive</em> or <em>Shared with me</em> via Google Picker.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleOpenGooglePicker('folder')}
                        className="w-full py-2.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 transition-all cursor-pointer"
                      >
                        <FolderSearch className="w-4 h-4" />
                        <span>Open from Drive</span>
                      </button>
                    </div>

                    {/* Action 2: Create a Brand-New Project Folder */}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleCreateDriveFolder(welcomeFolderName || 'My-LaTeX-Manuscript');
                      }}
                      className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-4"
                    >
                      <div className="space-y-2">
                        <div className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                          <FolderPlus className="w-4 h-4 text-sky-400" />
                          <span>Create New Folder</span>
                        </div>
                        <input
                          type="text"
                          value={welcomeFolderName}
                          onChange={(e) => setWelcomeFolderName(e.target.value)}
                          placeholder="Folder name..."
                          className="w-full bg-slate-900 text-xs font-mono text-slate-100 px-3 py-1.5 rounded-lg border border-slate-700 focus:border-sky-500 focus:outline-none"
                        />
                      </div>

                      <button
                        type="submit"
                        className="w-full py-2.5 px-3 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center justify-center gap-2 shadow-lg shadow-sky-600/20 transition-all cursor-pointer"
                      >
                        <FolderPlus className="w-4 h-4" />
                        <span>Create &amp; Open</span>
                      </button>
                    </form>
                  </div>
                </div>
              )}

              {/* Architecture Highlights Footer */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-slate-800/80 text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Real Google Profiles &amp; P2P Live Cursors</span>
                </div>
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-indigo-400 shrink-0" />
                  <span>Wasm Web Worker + MEMFS</span>
                </div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
                  <span>Google Picker &amp; Leader Auto-Save</span>
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Mandate 2: Guided Missing-Files Authorization Modal */}
      {missingAssetsModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="missing-assets-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
        >
          <div className="max-w-xl w-full bg-slate-900 border border-amber-500/60 rounded-2xl p-6 shadow-2xl space-y-5">
            <div className="flex items-start gap-3.5 border-b border-slate-800 pb-4">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0 mt-0.5">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div className="space-y-1 flex-1">
                <h2 id="missing-assets-title" className="text-base font-bold text-slate-100">
                  Missing Project Assets Detected
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Your <code className="text-indigo-300 font-mono">.tex</code> manuscript references external files (figures, bibliography, or styles) that have not yet been authorized under Google Drive&rsquo;s strict <code className="text-slate-300 font-mono">drive.file</code> security scope.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Referenced Paths in Document:
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1.5 p-2 bg-slate-950/80 border border-slate-800 rounded-xl font-mono text-xs text-amber-200">
                {missingAssetsList.map((dep, idx) => (
                  <div key={idx} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-slate-900/60 border border-slate-800/80">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-sans font-medium uppercase">
                      {dep.type}
                    </span>
                    <span className="truncate flex-1">{dep.relativePath}</span>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Click below to open Google Picker, navigate into the subfolder (e.g. <code className="text-slate-300 font-mono">output_figures/</code>), press <kbd className="px-1 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-[10px] text-white">Ctrl+A</kbd> to select the files, and click Select. They will be mounted automatically at their exact relative paths without changing the root project folder.
            </p>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setMissingAssetsModalOpen(false)}
                className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setMissingAssetsModalOpen(false);
                  handleCompile(true);
                }}
                className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 text-xs font-medium border border-amber-500/30 transition-colors cursor-pointer"
              >
                Compile Anyway
              </button>
              <button
                type="button"
                disabled={isAuthorizingMissing}
                onClick={handleAuthorizeMissingFiles}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs font-semibold flex items-center gap-2 shadow-lg shadow-indigo-600/25 transition-all cursor-pointer disabled:opacity-50"
              >
                {isAuthorizingMissing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FolderSearch className="w-4 h-4" />
                )}
                <span>Authorize Missing Files in Google Drive</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-Flight Journal Submission Warning Modal */}
      <PreFlightModal
        isOpen={preFlightModalState.isOpen}
        onClose={() => setPreFlightModalState((prev) => ({ ...prev, isOpen: false }))}
        exportType={preFlightModalState.exportType}
        counts={preFlightModalState.counts}
        onStopAndReview={() => {
          const firstPendingItem = preFlightModalState.counts?.items?.[0] || null;
          setPreFlightModalState((prev) => ({ ...prev, isOpen: false }));
          setIsReviewPanelOpen(true);
          if (firstPendingItem) {
            setReviewTargetItem(firstPendingItem);
          }
        }}
        onAcceptAllAndDownload={() => {
          const type = preFlightModalState.exportType;
          setPreFlightModalState((prev) => ({ ...prev, isOpen: false }));
          if (type === 'tex') {
            executeCleanTexDownload();
          } else {
            executeCleanZipDownload();
          }
        }}
      />

      {/* Full-Screen Blocking Modal when Google Drive OAuth2 Session Expires */}
      {isSessionExpired && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            background: 'rgba(0, 0, 0, 0.85)',
            pointerEvents: 'all',
          }}
          className="flex items-center justify-center p-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="session-expired-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl text-center space-y-5">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div className="space-y-2">
              <h2 id="session-expired-title" className="text-lg font-semibold text-white">
                Sesión de Google Drive Expirada
              </h2>
              <p className="text-sm text-slate-300 leading-relaxed">
                La sesión de Google Drive ha expirado por inactividad. Para evitar sobrescribir cambios de otros colaboradores, reconecta tu cuenta para recargar la última versión del proyecto desde Google Drive antes de continuar editando.
              </p>
            </div>
            {driveError && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {driveError}
              </div>
            )}
            <button
              type="button"
              disabled={isReconnecting}
              onClick={handleReconnectAndReloadFromDrive}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isReconnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Reconectando y actualizando...</span>
                </>
              ) : (
                <span>Reconectar y Actualizar desde Google Drive</span>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
