/**
 * @fileoverview P2P Collaboration Service powered by Yjs, y-webrtc, and y-indexeddb.
 *
 * CRITICAL ARCHITECTURAL INVARIANTS:
 * 1. Unified Folder Room ID: The Yjs WebRTC room is keyed by the shared Google Drive
 *    `folderId` (`room-${folderId}`), NEVER by individual file IDs. This guarantees that
 *    all collaborators who open the same shared folder join the exact same P2P room.
 * 2. Shared Project Metadata (`Y.Map('projectMeta')`): Stores the canonical
 *    `mainTexFileId`, `mainTexFileName`, `folderId`, and `folderName` inside `Y.Doc`
 *     alongside `Y.Map('auxFiles')` so peers joining a shared folder immediately know
 *    the canonical file IDs and MEMFS assets over WebRTC—even before authorizing
 *    individual files in Google Picker under `drive.file`.
 * 3. Real Google User Profile in Awareness: Broadcasts the authenticated user's real
 *    `name`, `email`, and `picture` from `/oauth2/v3/userinfo`.
 */

import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  getAuthenticatedUserProfile,
  inferImageMimeType,
  isImageAssetFile,
  isValidDriveId,
  normalizeBinaryContent,
} from './driveService';

/**
 * Default public WebRTC signaling servers used for peer discovery.
 * Can be overridden via `VITE_SIGNALING_SERVERS` (comma-separated URLs).
 *
 * @type {string[]}
 */
export const DEFAULT_SIGNALING_SERVERS = [
  'wss://signaling.yjs.dev',
  'wss://y-webrtc-eu.fly.dev',
];

/**
 * Debounce interval (30 seconds) after document edits before the elected
 * Save Leader commits a snapshot `PATCH` to Google Drive.
 *
 * @type {number}
 */
export const AUTO_SAVE_DEBOUNCE_MS = 30000;

/**
 * Curated palette of high-contrast colors for collaborator cursors and badges.
 *
 * @type {Array<{name: string, color: string, colorLight: string}>}
 */
const PEER_COLOR_PALETTE = [
  { name: 'Indigo', color: '#6366f1', colorLight: 'rgba(99, 102, 241, 0.28)' },
  { name: 'Emerald', color: '#10b981', colorLight: 'rgba(16, 185, 129, 0.28)' },
  { name: 'Amber', color: '#f59e0b', colorLight: 'rgba(245, 158, 11, 0.28)' },
  { name: 'Rose', color: '#f43f5e', colorLight: 'rgba(244, 63, 94, 0.28)' },
  { name: 'Cyan', color: '#06b6d4', colorLight: 'rgba(6, 182, 212, 0.28)' },
  { name: 'Purple', color: '#a855f7', colorLight: 'rgba(168, 85, 247, 0.28)' },
  { name: 'Sky', color: '#0ea5e9', colorLight: 'rgba(14, 165, 233, 0.28)' },
  { name: 'Orange', color: '#f97316', colorLight: 'rgba(249, 115, 22, 0.28)' },
];

/**
 * Extracts the collaboration room identifier (the shared Google Drive `folderId`)
 * from `window.location.hash`. Returns `null` if no room is present in the URL hash
 * so the application starts on the clean "Welcome / Open Drive Folder" screen.
 *
 * @returns {string | null} Sanitized folder room identifier, or `null` if none is active.
 */
export function getRoomFromUrlHash() {
  const rawHash = window.location.hash.replace(/^#/, '').trim();
  if (!rawHash) {
    return null;
  }

  const params = new URLSearchParams(rawHash);
  const roomParam = params.get('room');
  if (roomParam && isValidDriveId(roomParam)) {
    return roomParam.trim();
  }

  if (!rawHash.includes('=') && isValidDriveId(rawHash)) {
    return rawHash;
  }

  return null;
}

/**
 * Updates the URL hash to set the active folder room (`#room=${folderId}`),
 * or clears the hash if `folderId` is null/empty.
 *
 * @param {string | null} folderId - Shared Google Drive `folderId`.
 */
export function setRoomInUrlHash(folderId) {
  if (!folderId || !isValidDriveId(folderId)) {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`
    );
    return;
  }
  const sanitized = folderId.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  window.location.hash = `room=${sanitized}`;
}

/**
 * Generates or retrieves the local user profile (cursor colors + authenticated Google identity if signed in).
 *
 * @returns {{ name: string, email: string, picture: string, color: string, colorLight: string }}
 */
export function getOrCreateLocalPeerProfile() {
  const colorStorageKey = 'opendrivetex_peer_color_v1';
  let paletteEntry = PEER_COLOR_PALETTE[Math.floor(Math.random() * PEER_COLOR_PALETTE.length)];

  try {
    const cachedColor = sessionStorage.getItem(colorStorageKey);
    if (cachedColor) {
      const parsedColor = JSON.parse(cachedColor);
      if (parsedColor?.color && parsedColor?.colorLight) {
        paletteEntry = parsedColor;
      }
    } else {
      sessionStorage.setItem(colorStorageKey, JSON.stringify(paletteEntry));
    }
  } catch {
    // Ignore sessionStorage errors
  }

  const googleProfile = getAuthenticatedUserProfile();
  if (googleProfile && googleProfile.name) {
    return {
      name: googleProfile.name,
      email: googleProfile.email || '',
      picture: googleProfile.picture || '',
      color: paletteEntry.color,
      colorLight: paletteEntry.colorLight,
    };
  }

  return {
    name: 'Guest Collaborator',
    email: '',
    picture: '',
    color: paletteEntry.color,
    colorLight: paletteEntry.colorLight,
  };
}

/**
 * Resolves the list of WebRTC signaling servers to use.
 *
 * @param {string[]} [customSignaling] - Optional explicit array of signaling server WebSocket URLs.
 * @returns {string[]}
 */
export function resolveSignalingServers(customSignaling) {
  if (Array.isArray(customSignaling) && customSignaling.length > 0) {
    return customSignaling;
  }

  const envServers = import.meta.env?.VITE_SIGNALING_SERVERS;
  if (typeof envServers === 'string' && envServers.trim().length > 0) {
    return envServers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return DEFAULT_SIGNALING_SERVERS;
}

/**
 * Deterministic Save Leader Election algorithm over Yjs Awareness.
 *
 * Selects the connected peer with the **lowest `clientID`** who holds a valid Google OAuth
 * token (`hasDriveToken === true`). Prefers peers who also have confirmed `drive.file` write
 * authorization on the canonical `main.tex` file (`canWriteDriveFile !== false`) so a
 * collaborator who hasn't yet authorized `main.tex` in Google Picker won't trigger a 404 on auto-save.
 *
 * @param {import('y-protocols/awareness').Awareness} awareness - Yjs Awareness instance.
 * @param {number} localClientId - `ydoc.clientID` of the current browser tab.
 */
export function electSaveLeader(awareness, localClientId) {
  if (!awareness) {
    return {
      leaderClientId: null,
      leaderName: null,
      isLocalLeader: false,
      eligiblePeersCount: 0,
    };
  }

  const states = awareness.getStates();
  const writeAuthorizedPeers = [];
  const tokenOnlyPeers = [];

  states.forEach((state, clientId) => {
    if (state?.user?.hasDriveToken === true) {
      const peerObj = {
        clientId,
        name: state.user.name || `User #${clientId}`,
      };
      if (state.user.canWriteDriveFile !== false) {
        writeAuthorizedPeers.push(peerObj);
      } else {
        tokenOnlyPeers.push(peerObj);
      }
    }
  });

  const candidatePool =
    writeAuthorizedPeers.length > 0 ? writeAuthorizedPeers : tokenOnlyPeers;

  if (candidatePool.length === 0) {
    return {
      leaderClientId: null,
      leaderName: null,
      isLocalLeader: false,
      eligiblePeersCount: 0,
    };
  }

  candidatePool.sort((a, b) => a.clientId - b.clientId);
  const leader = candidatePool[0];

  return {
    leaderClientId: leader.clientId,
    leaderName: leader.name,
    isLocalLeader: leader.clientId === localClientId,
    eligiblePeersCount: candidatePool.length,
  };
}

/**
 * Creates and initializes a complete Yjs P2P collaboration session keyed by the shared
 * Google Drive `folderId` (`room-${folderId}`), including `Y.Map('projectMeta')` synchronization.
 *
 * @param {Object} options - Configuration options.
 * @param {string} options.roomName - Shared Google Drive `folderId` used as the room key.
 * @param {string[]} [options.signalingServers] - Custom WebRTC signaling server URLs.
 * @param {boolean} [options.hasDriveToken=false] - Whether the local user holds a valid Google OAuth token.
 * @param {{ name?: string, email?: string, picture?: string }} [options.userProfile] - Authenticated Google user profile.
 */
export function createCollabSession(options = {}) {
  const roomName = options.roomName || getRoomFromUrlHash();
  if (!roomName) {
    throw new Error('createCollabSession requires a valid non-empty folderId roomName.');
  }

  const signalingServers = resolveSignalingServers(options.signalingServers);

  // 1. Initialize the core Yjs CRDT Document:
  //    - `ytext`: Primary manuscript text buffer ('codemirror')
  //    - `projectMeta`: Canonical project metadata ('mainTexFileId', 'mainTexFileName', 'folderId', 'folderName')
  //    - `auxFilesMap`: Shared auxiliary files map ('.bib', '.sty', '.cls', figures) for Worker MEMFS
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('codemirror');
  const projectMeta = ydoc.getMap('projectMeta');
  const auxFilesMap = ydoc.getMap('auxFiles');

  // 2. Initialize local offline persistence via IndexedDB keyed by folderId
  const persistenceNamespace = `opendrivetex-folder-room-${roomName}`;
  const persistence = new IndexeddbPersistence(persistenceNamespace, ydoc);

  // Automatically prune any legacy folder entries mistakenly saved into auxFilesMap
  persistence.whenSynced.then(() => {
    ydoc.transact(() => {
      auxFilesMap.forEach((meta, key) => {
        if (meta?.mimeType === 'application/vnd.google-apps.folder' || meta?.isFolder) {
          auxFilesMap.delete(key);
        }
      });
    }, 'cleanup-folder-keys');
  }).catch(() => {});

  // 3. Initialize P2P WebRTC provider keyed by `'room-' + folderId`
  const provider = new WebrtcProvider(`room-${roomName}`, ydoc, {
    signaling: signalingServers,
    filterBcConns: false,
  });

  // 4. Configure local user awareness state with real Google user profile if authenticated
  const localUser = getOrCreateLocalPeerProfile();
  if (options.userProfile?.name) {
    localUser.name = options.userProfile.name;
    localUser.email = options.userProfile.email || '';
    localUser.picture = options.userProfile.picture || '';
  }

  const { awareness } = provider;

  awareness.setLocalStateField('user', {
    name: localUser.name,
    email: localUser.email || '',
    picture: localUser.picture || '',
    color: localUser.color,
    colorLight: localUser.colorLight,
    clientId: ydoc.clientID,
    hasDriveToken: Boolean(options.hasDriveToken),
    canWriteDriveFile: true,
    lastDriveSaveAt: null,
    joinedAt: Date.now(),
  });

  /**
   * Updates canonical project metadata (`mainTexFileId`, `mainTexFileName`, `folderId`, `folderName`)
   * inside `Y.Map('projectMeta')` so all connected peers in the folder room learn the exact
   * Google Drive file IDs immediately over WebRTC.
   *
   * @param {{
   *   mainTexFileId?: string,
   *   mainTexFileName?: string,
   *   folderId?: string,
   *   folderName?: string
   * }} metaUpdate
   */
  const updateProjectMeta = (metaUpdate = {}) => {
    ydoc.transact(() => {
      if (metaUpdate.folderId && isValidDriveId(metaUpdate.folderId)) {
        projectMeta.set('folderId', metaUpdate.folderId.trim());
      }
      if (metaUpdate.folderName && metaUpdate.folderName.trim()) {
        projectMeta.set('folderName', metaUpdate.folderName.trim());
      }
      if (metaUpdate.mainTexFileId && isValidDriveId(metaUpdate.mainTexFileId)) {
        projectMeta.set('mainTexFileId', metaUpdate.mainTexFileId.trim());
      }
      if (metaUpdate.mainTexFileName && metaUpdate.mainTexFileName.trim()) {
        projectMeta.set('mainTexFileName', metaUpdate.mainTexFileName.trim());
      }
    }, 'project-meta-update');
  };

  /**
   * Reads the current canonical project metadata from `Y.Map('projectMeta')`.
   *
   * @returns {{
   *   folderId: string | null,
   *   folderName: string | null,
   *   mainTexFileId: string | null,
   *   mainTexFileName: string | null
   * }}
   */
  const getProjectMeta = () => ({
    folderId: projectMeta.get('folderId') || roomName,
    folderName: projectMeta.get('folderName') || null,
    mainTexFileId: projectMeta.get('mainTexFileId') || null,
    mainTexFileName: projectMeta.get('mainTexFileName') || null,
  });

  /**
   * Returns the `Y.Text` instance for a given project file name.
   *
   * @param {string} filePath
   * @returns {Y.Text}
   */
  const getYTextForFile = (filePath) => {
    const canonicalMainName = projectMeta.get('mainTexFileName') || 'main.tex';
    if (
      !filePath ||
      filePath === 'main.tex' ||
      filePath === canonicalMainName ||
      filePath.endsWith('.tex')
    ) {
      return ytext;
    }
    return ydoc.getText(`file:${filePath}`);
  };

  /**
   * Adds or updates an auxiliary project file (`.bib`, `.sty`, `.cls`, or image) in the shared `Y.Map('auxFiles')`
   * so all peers in the folder room and their Web Worker MEMFS receive it automatically over WebRTC.
   *
   * @param {{ id?: string, name: string, path: string, mimeType: string, size?: number, modifiedTime?: string, content: string | Uint8Array }} fileObj
   * @param {boolean} [forceOverwriteText=false]
   */
  const upsertAuxFile = (fileObj, forceOverwriteText = false) => {
    if (!fileObj || !fileObj.path || fileObj.mimeType === 'application/vnd.google-apps.folder' || fileObj.isFolder) {
      return;
    }
    const cleanPath = fileObj.path.replace(/^\.+\//, '').trim();
    if (!cleanPath || cleanPath === '.') return;

    const isImage =
      isImageAssetFile(cleanPath, fileObj.mimeType) || /\.(pdf|eps)$/i.test(cleanPath);
    const category = cleanPath.endsWith('.bib')
      ? 'bib'
      : isImage
      ? 'figure'
      : 'package';
    const resolvedMime = isImage
      ? inferImageMimeType(cleanPath, fileObj.mimeType)
      : fileObj.mimeType || 'text/plain';

    const existingEntry = auxFilesMap.get(cleanPath);
    const rawContent =
      fileObj.content !== undefined && fileObj.content !== null
        ? fileObj.content
        : existingEntry?.content;
    const finalContent = isImage ? normalizeBinaryContent(rawContent) || rawContent : rawContent;

    const byteSize =
      typeof fileObj.size === 'number' && fileObj.size > 0
        ? fileObj.size
        : finalContent instanceof Uint8Array
        ? finalContent.byteLength
        : typeof finalContent === 'string'
        ? finalContent.length
        : 0;

    ydoc.transact(() => {
      auxFilesMap.set(cleanPath, {
        id: fileObj.id || existingEntry?.id || null,
        name: fileObj.name || cleanPath.split('/').pop(),
        path: cleanPath,
        mimeType: resolvedMime,
        size: byteSize,
        modifiedTime: fileObj.modifiedTime || existingEntry?.modifiedTime || null,
        category,
        content: finalContent,
        updatedAt: Date.now(),
      });

      if (!isImage && typeof finalContent === 'string') {
        const fileYText = ydoc.getText(`file:${cleanPath}`);
        if (forceOverwriteText || fileYText.length === 0) {
          if (fileYText.length > 0 && fileYText.toString() !== finalContent) {
            fileYText.delete(0, fileYText.length);
          }
          if (fileYText.length === 0 && finalContent.length > 0) {
            fileYText.insert(0, finalContent);
          }
        }
      }
    }, 'aux-upsert');
  };

  /**
   * Removes an auxiliary file from the shared `Y.Map('auxFiles')`, clears its associated `Y.Text`,
   * and records the removal in `projectMeta` so IndexedDB and all WebRTC peers immediately
   * remove it from their sidebars and MEMFS.
   *
   * @param {string} filePath - Path/name of the auxiliary file to remove.
   */
  const removeAuxFile = (filePath) => {
    if (!filePath) return;
    const cleanPath = filePath.replace(/^\.+\//, '').trim();
    if (!cleanPath) return;

    ydoc.transact(() => {
      auxFilesMap.delete(cleanPath);
      auxFilesMap.delete(filePath);
      const fileYText = ydoc.getText(`file:${cleanPath}`);
      if (fileYText.length > 0) {
        fileYText.delete(0, fileYText.length);
      }
      projectMeta.set('lastDeletedFile', {
        path: cleanPath,
        deletedAt: Date.now(),
      });
    }, 'aux-delete');
  };

  /**
   * Merges auxiliary files fetched from a Google Drive folder into `Y.Map('auxFiles')`
   * without wiping existing CRDT auxiliary files if a peer opened a shared folder where
   * `files.list` returned empty under `drive.file`.
   *
   * @param {Array<{ id?: string, name: string, path: string, mimeType: string, size?: number, modifiedTime?: string, content: string | Uint8Array }>} files
   * @param {boolean} [forceOverwriteText=false]
   */
  const mergeFolderAuxFiles = (files = [], forceOverwriteText = false) => {
    if (!Array.isArray(files) || files.length === 0) return;

    ydoc.transact(() => {
      for (const fileObj of files) {
        if (!fileObj || !fileObj.path || fileObj.mimeType === 'application/vnd.google-apps.folder' || fileObj.isFolder) {
          continue;
        }
        const cleanPath = fileObj.path.replace(/^\.+\//, '').trim();
        if (!cleanPath || cleanPath === '.' || cleanPath.endsWith('.tex')) continue;

        const isImage =
          isImageAssetFile(cleanPath, fileObj.mimeType) || /\.(pdf|eps)$/i.test(cleanPath);
        const category = cleanPath.endsWith('.bib')
          ? 'bib'
          : isImage
          ? 'figure'
          : 'package';
        const resolvedMime = isImage
          ? inferImageMimeType(cleanPath, fileObj.mimeType)
          : fileObj.mimeType || 'text/plain';
        const existingEntry = auxFilesMap.get(cleanPath);
        const isDriveNewer =
          Boolean(fileObj.modifiedTime) &&
          (!existingEntry?.modifiedTime || fileObj.modifiedTime > existingEntry.modifiedTime);

        const rawContent =
          fileObj.content !== undefined && fileObj.content !== null
            ? fileObj.content
            : existingEntry?.content;
        const finalContent = isImage ? normalizeBinaryContent(rawContent) || rawContent : rawContent;

        const byteSize =
          typeof fileObj.size === 'number' && fileObj.size > 0
            ? fileObj.size
            : finalContent instanceof Uint8Array
            ? finalContent.byteLength
            : typeof finalContent === 'string'
            ? finalContent.length
            : 0;

        auxFilesMap.set(cleanPath, {
          id: fileObj.id || existingEntry?.id || null,
          name: fileObj.name || cleanPath.split('/').pop(),
          path: cleanPath,
          mimeType: resolvedMime,
          size: byteSize,
          modifiedTime: fileObj.modifiedTime || existingEntry?.modifiedTime || null,
          category,
          content: finalContent,
          updatedAt: Date.now(),
        });

        if (!isImage && typeof fileObj.content === 'string') {
          const fileYText = ydoc.getText(`file:${cleanPath}`);
          if (forceOverwriteText || isDriveNewer || fileYText.length === 0) {
            if (fileYText.length > 0 && fileYText.toString() !== fileObj.content) {
              fileYText.delete(0, fileYText.length);
            }
            if (fileYText.length === 0 && fileObj.content.length > 0) {
              fileYText.insert(0, fileObj.content);
            }
          }
        }
      }
    }, 'folder-aux-merge');
  };

  /**
   * Reconciles the local Yjs `auxFilesMap` / `projectMeta` / IndexedDB cache against the
   * authoritative Google Drive folder file list:
   *   1. Removes any locally cached auxiliary files in `pathsToRemove` that were trashed or deleted in Drive.
   *   2. Downloads/updates any files present in `driveAuxFiles` into `auxFilesMap` and MEMFS.
   *
   * @param {{
   *   driveAuxFiles?: Array<any>,
   *   pathsToRemove?: string[],
   *   forceOverwriteText?: boolean
   * }} options
   */
  const reconcileFolderWithDrive = ({
    driveAuxFiles = [],
    pathsToRemove = [],
    forceOverwriteText = false,
  } = {}) => {
    ydoc.transact(() => {
      for (const rawPath of pathsToRemove) {
        if (!rawPath) continue;
        const cleanPath = rawPath.replace(/^\.+\//, '').trim();
        auxFilesMap.delete(cleanPath);
        auxFilesMap.delete(rawPath);
        const fileYText = ydoc.getText(`file:${cleanPath}`);
        if (fileYText.length > 0) {
          fileYText.delete(0, fileYText.length);
        }
      }
    }, 'folder-reconcile-prune');

    if (Array.isArray(driveAuxFiles) && driveAuxFiles.length > 0) {
      mergeFolderAuxFiles(driveAuxFiles, forceOverwriteText);
    }
  };

  /**
   * Collects all auxiliary files with their latest contents (reading live `Y.Text` for
   * editable `.bib` / `.sty` / `.cls` files) to pass into the Web Worker's MEMFS before compilation.
   *
   * @returns {Array<{ id?: string, name: string, path: string, mimeType: string, category: string, content: string | Uint8Array }>}
   */
  const getAuxFilesForMemFS = () => {
    const list = [];
    auxFilesMap.forEach((meta, pathKey) => {
      if (!meta || meta.mimeType === 'application/vnd.google-apps.folder' || meta.isFolder) return;
      if (meta.category !== 'figure') {
        const liveYText = ydoc.getText(`file:${pathKey}`);
        const liveStr = liveYText.length > 0 ? liveYText.toString() : meta.content || '';
        list.push({
          ...meta,
          path: pathKey,
          content: liveStr,
        });
      } else {
        const rawContent = meta.content;
        const binContent = normalizeBinaryContent(rawContent) || rawContent;
        list.push({
          ...meta,
          path: pathKey,
          content: binContent,
        });
      }
    });
    return list;
  };

  /**
   * Updates the local user's profile (`name`, `email`, `picture`, `hasDriveToken`, `canWriteDriveFile`)
   * in Yjs Awareness.
   *
   * @param {{
   *   name?: string,
   *   email?: string,
   *   picture?: string,
   *   hasDriveToken?: boolean,
   *   canWriteDriveFile?: boolean
   * }} profileUpdate
   */
  const updateLocalUserProfile = (profileUpdate = {}) => {
    if (profileUpdate.name) {
      localUser.name = profileUpdate.name.trim();
    }
    if (profileUpdate.email !== undefined) {
      localUser.email = profileUpdate.email;
    }
    if (profileUpdate.picture !== undefined) {
      localUser.picture = profileUpdate.picture;
    }

    const currentUserState = awareness.getLocalState()?.user || {};
    awareness.setLocalStateField('user', {
      ...currentUserState,
      name: localUser.name,
      email: localUser.email || '',
      picture: localUser.picture || '',
      hasDriveToken:
        profileUpdate.hasDriveToken !== undefined
          ? Boolean(profileUpdate.hasDriveToken)
          : Boolean(currentUserState.hasDriveToken),
      canWriteDriveFile:
        profileUpdate.canWriteDriveFile !== undefined
          ? Boolean(profileUpdate.canWriteDriveFile)
          : currentUserState.canWriteDriveFile !== false,
    });
  };

  /**
   * Updates the local user's display name in Awareness.
   *
   * @param {string} newName - Updated display name.
   */
  const updateLocalUserName = (newName) => {
    const trimmed = (newName || '').trim();
    if (!trimmed) return;
    updateLocalUserProfile({ name: trimmed });
  };

  /**
   * Updates whether the local peer currently holds a valid Google OAuth 2.0 token.
   *
   * @param {boolean} hasDriveToken
   */
  const setLocalDriveAuthStatus = (hasDriveToken) => {
    const currentUserState = awareness.getLocalState()?.user || {};
    if (Boolean(currentUserState.hasDriveToken) === Boolean(hasDriveToken)) {
      return;
    }
    awareness.setLocalStateField('user', {
      ...currentUserState,
      hasDriveToken: Boolean(hasDriveToken),
    });
  };

  /**
   * Requests an immediate manual Google Drive save from the Elected Save Leader
   * by writing `manualSaveRequestedAt` into `Y.Map('projectMeta')`.
   * Used when a Follower Replica presses `Ctrl+S` or clicks "Save to Drive" so the
   * Follower never triggers a 404 under the `drive.file` scope.
   *
   * @param {number} [timestampMs=Date.now()]
   */
  const requestManualSaveViaLeader = (timestampMs = Date.now()) => {
    ydoc.transact(() => {
      projectMeta.set('saveStatus', 'saving');
      projectMeta.set('manualSaveRequestedAt', timestampMs);
    }, 'manual-save-request');
  };

  /**
   * Broadcasts a timestamp and `'saved'` status to all peers via both `Y.Map('projectMeta')`
   * (`lastSavedAt` and `saveStatus: 'saved'`) and Yjs Awareness when a Google Drive save completes.
   *
   * @param {number} timestampMs
   */
  const broadcastDriveSaveTimestamp = (timestampMs = Date.now()) => {
    ydoc.transact(() => {
      projectMeta.set('lastSavedAt', timestampMs);
      projectMeta.set('saveStatus', 'saved');
    }, 'drive-save-complete');

    const currentUserState = awareness.getLocalState()?.user || {};
    awareness.setLocalStateField('user', {
      ...currentUserState,
      lastDriveSaveAt: timestampMs,
    });
  };

  /**
   * Hydrates the shared `Y.Text` content from Google Drive when a project is opened.
   * By default (`forceOverwrite = false`), only populates `ytext` if it is currently empty
   * so live P2P edits from other peers in the room are never overwritten.
   *
   * @param {string} newTexContent - Raw `.tex` file content fetched from Google Drive.
   * @param {boolean} [forceOverwrite=false] - Whether to overwrite even if `ytext` is non-empty.
   */
  const replaceDocumentFromDrive = (newTexContent, forceOverwrite = false) => {
    if (typeof newTexContent !== 'string' || !newTexContent) return;
    ydoc.transact(() => {
      if (forceOverwrite || ytext.length === 0) {
        if (ytext.length > 0) {
          ytext.delete(0, ytext.length);
        }
        ytext.insert(0, newTexContent);
      }
    }, 'drive-load');
  };

  /**
   * Evaluates the current Save Leader state for this session.
   */
  const getLeaderElectionState = () => electSaveLeader(awareness, ydoc.clientID);

  /**
   * Attaches a 30-second debounced observer to `ytext` that automatically invokes
   * `onLeaderAutoSave(ytext.toString(), canonicalMainTexFileId)` ONLY if the local peer
   * is the elected Save Leader.
   */
  const registerLeaderAutoSave = ({
    isDriveFileLinked,
    onLeaderAutoSave,
    onDirtyStateChange,
    debounceMs = AUTO_SAVE_DEBOUNCE_MS,
  }) => {
    let debounceTimer = null;

    const clearPendingTimer = () => {
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const handleYTextChange = (_event, transaction) => {
      if (
        transaction?.origin === 'initial-boilerplate' ||
        transaction?.origin === 'drive-load'
      ) {
        return;
      }

      if (!isDriveFileLinked || !isDriveFileLinked()) {
        return;
      }

      clearPendingTimer();
      const scheduledTime = Date.now() + debounceMs;

      if (onDirtyStateChange) {
        onDirtyStateChange({ isDirty: true, nextAutoSaveAt: scheduledTime });
      }

      debounceTimer = window.setTimeout(async () => {
        debounceTimer = null;
        if (!isDriveFileLinked()) return;

        const election = electSaveLeader(awareness, ydoc.clientID);
        if (election.isLocalLeader) {
          const canonicalFileId = projectMeta.get('mainTexFileId') || null;
          await onLeaderAutoSave(ytext.toString(), canonicalFileId);
        } else if (onDirtyStateChange) {
          onDirtyStateChange({ isDirty: false, nextAutoSaveAt: null });
        }
      }, debounceMs);
    };

    ytext.observe(handleYTextChange);

    return () => {
      clearPendingTimer();
      ytext.unobserve(handleYTextChange);
    };
  };

  /**
   * Cleanly tears down WebRTC connections, IndexedDB listeners, and the Y.Doc instance.
   */
  const destroy = () => {
    try {
      awareness.setLocalState(null);
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
    } catch (err) {
      console.warn('[OpenDriveTeX] Error while cleaning up collaboration session:', err);
    }
  };

  return {
    roomName,
    ydoc,
    ytext,
    projectMeta,
    auxFilesMap,
    provider,
    persistence,
    awareness,
    localUser,
    updateProjectMeta,
    getProjectMeta,
    getYTextForFile,
    upsertAuxFile,
    removeAuxFile,
    mergeFolderAuxFiles,
    reconcileFolderWithDrive,
    getAuxFilesForMemFS,
    updateLocalUserProfile,
    updateLocalUserName,
    setLocalDriveAuthStatus,
    requestManualSaveViaLeader,
    broadcastDriveSaveTimestamp,
    replaceDocumentFromDrive,
    getLeaderElectionState,
    registerLeaderAutoSave,
    destroy,
  };
}
