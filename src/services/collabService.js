/**
 * @fileoverview P2P Collaboration Service powered by Yjs, y-webrtc, and y-indexeddb.
 *
 * CRITICAL ARCHITECTURAL INVARIANTS:
 * 1. Deterministic Project Room ID: The Yjs WebRTC room is keyed by a normalized project/workspace
 *    name (e.g. `opendrivetex-workspace-<project_name>`), NEVER by dynamic Google Drive file or folder IDs
 *    which vary per user account. This guarantees that all collaborators working on the same project
 *    connect to the exact same P2P room.
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
import { encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
import {
  getAuthenticatedUserProfile,
  inferImageMimeType,
  isImageAssetFile,
  isValidDriveId,
  normalizeBinaryContent,
} from './driveService';

function uint8ToBase64Safe(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, len));
    for (let j = 0; j < sub.length; j++) {
      binary += String.fromCharCode(sub[j]);
    }
  }
  return btoa(binary);
}

function base64ToUint8Safe(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Default public WebRTC signaling servers used for peer discovery.
 * Priority: Dedicated Cloudflare Workers signaling endpoint.
 * Can be overridden at runtime via `VITE_WEBRTC_SIGNALING` (or legacy `VITE_SIGNALING_SERVERS`).
 *
 * @type {string[]}
 */
export const DEFAULT_SIGNALING_SERVERS = [
  'wss://opendrivetex-signaling.opendrivetex-signaling.workers.dev',
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
 * Resolves a clean, deterministic room name for collaboration.
 * Uses a normalized workspace string based on the project or folder name
 * (e.g. `opendrivetex-workspace-<project_name>`), avoiding raw Google Drive IDs
 * so collaborators join the exact same WebRTC room regardless of individual Drive IDs.
 *
 * @param {string | null | undefined} candidateName - Project name, folder name, or room identifier.
 * @returns {string} Deterministic room name (e.g. `opendrivetex-workspace-paper`).
 */
export function getDeterministicRoomName(candidateName) {
  if (!candidateName || typeof candidateName !== 'string') {
    return 'opendrivetex-workspace-default';
  }

  const trimmed = candidateName.trim();
  if (trimmed.startsWith('opendrivetex-workspace-')) {
    return trimmed.toLowerCase();
  }

  // Strip .tex extension if present
  const base = trimmed.replace(/\.tex$/i, '');

  // Normalize: lowercase, replace spaces and special characters with hyphens
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `opendrivetex-workspace-${slug || 'default'}`;
}

/**
 * Extracts the collaboration room identifier from `window.location.hash`.
 * Returns `null` if no room is present in the URL hash so the application
 * starts on the clean "Welcome / Open Drive Folder" screen.
 *
 * @returns {string | null} Sanitized room identifier, or `null` if none is active.
 */
export function getRoomFromUrlHash() {
  const rawHash = window.location.hash.replace(/^#/, '').trim();
  if (!rawHash) {
    return null;
  }

  const params = new URLSearchParams(rawHash);
  const roomParam = params.get('room');
  if (roomParam && roomParam.trim()) {
    return roomParam.trim();
  }

  if (!rawHash.includes('=') && rawHash.trim()) {
    return rawHash.trim();
  }

  return null;
}

/**
 * Updates the URL hash to set the active project room (`#room=${roomName}`),
 * or clears the hash if `roomName` is null/empty.
 *
 * @param {string | null} roomName - Shared collaboration room name.
 */
export function setRoomInUrlHash(roomName) {
  if (!roomName || typeof roomName !== 'string' || !roomName.trim()) {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`
    );
    return;
  }
  const sanitized = roomName.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
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

  const envServers =
    import.meta.env?.VITE_WEBRTC_SIGNALING ||
    import.meta.env?.VITE_SIGNALING_SERVERS;

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
  const candidate =
    (options.roomName && typeof options.roomName === 'string' && options.roomName.startsWith('opendrivetex-workspace-') ? options.roomName : null) ||
    options.projectName ||
    options.folderName ||
    options.roomName ||
    getRoomFromUrlHash() ||
    'default';

  const roomName = getDeterministicRoomName(candidate);

  const signalingUrl =
    (options.signalingServers && options.signalingServers[0]) ||
    import.meta.env?.VITE_WEBRTC_SIGNALING ||
    'wss://opendrivetex-signaling.opendrivetex-signaling.workers.dev';

  console.log(`[Collab] Connecting to signaling: ${signalingUrl} for room: ${roomName}`);
  console.log(`[Collab] Joined shared room: ${roomName}`);

  // 1. Initialize the core Yjs CRDT Document:
  //    - `ytext`: Primary manuscript text buffer ('codemirror')
  //    - `projectMeta`: Canonical project metadata ('mainTexFileId', 'mainTexFileName', 'folderId', 'folderName')
  //    - `auxFilesMap`: Shared auxiliary files map ('.bib', '.sty', '.cls', figures) for Worker MEMFS
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('codemirror');
  const projectMeta = ydoc.getMap('projectMeta');
  const auxFilesMap = ydoc.getMap('auxFiles');

  // 2. Initialize local offline persistence via IndexedDB keyed by roomName
  const persistenceNamespace = `opendrivetex-room-${roomName}`;
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

  // 3. Initialize deterministic P2P WebRTC provider keyed by shared roomName
  const provider = new WebrtcProvider(roomName, ydoc, {
    signaling: [signalingUrl],
    peerOpts: {
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
    },
  });

  provider.on('status', (event) => {
    console.log('[Collab Status]:', event.status);
  });

  provider.on('peers', (event) => {
    console.log('[Collab Peers]: added:', event.added, 'removed:', event.removed, 'total peers:', event.webrtcPeers);
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
    colorLight: localUser.colorLight || `${localUser.color}33`,
    clientId: ydoc.clientID,
    hasDriveToken: Boolean(options.hasDriveToken),
    canWriteDriveFile: true,
    lastDriveSaveAt: null,
    joinedAt: Date.now(),
  });

  // 4b. Direct WebSocket relay to Cloudflare Durable Object (TCP 443 fallback & global sync)
  const baseSignalUrl = signalingUrl.replace(/\/+$/, '');
  const directWsUrl = `${baseSignalUrl}/?room=${encodeURIComponent(roomName)}`;

  let ws = null;
  let pingIntervalId = null;
  let reconnectTimeoutId = null;
  let syncFallbackTimerId = null;
  let isRoomSynced = false;
  let pendingInitialContent = null;
  let isDestroyed = false;

  const applyPendingInitialContentIfEmpty = () => {
    if (!pendingInitialContent) return;
    const { targetYText, content } = pendingInitialContent;
    pendingInitialContent = null;
    if (targetYText && targetYText.length === 0 && typeof content === 'string' && content.length > 0) {
      ydoc.transact(() => {
        if (targetYText.length === 0) {
          targetYText.insert(0, content);
        }
      }, 'initial-load');
    }
  };

  const sendWsJson = (payload) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const connectDirectWs = () => {
    if (isDestroyed) return;
    try {
      ws = new WebSocket(directWsUrl);
    } catch (err) {
      console.warn('[Collab DirectWS] Connection error:', err);
      reconnectTimeoutId = window.setTimeout(connectDirectWs, 3000);
      return;
    }

    ws.onopen = () => {
      if (isDestroyed) {
        try { ws.close(); } catch {}
        return;
      }
      sendWsJson({
        type: 'yjs-sync-step1',
        sv: uint8ToBase64Safe(Y.encodeStateVector(ydoc)),
      });
      if (awareness) {
        sendWsJson({
          type: 'yjs-awareness',
          update: uint8ToBase64Safe(encodeAwarenessUpdate(awareness, [ydoc.clientID])),
        });
      }
      if (!isRoomSynced) {
        if (syncFallbackTimerId !== null) {
          window.clearTimeout(syncFallbackTimerId);
        }
        syncFallbackTimerId = window.setTimeout(() => {
          syncFallbackTimerId = null;
          if (isDestroyed) return;
          if (!isRoomSynced) {
            isRoomSynced = true;
            applyPendingInitialContentIfEmpty();
          }
        }, 1200);
      }
      if (pingIntervalId !== null) {
        window.clearInterval(pingIntervalId);
      }
      pingIntervalId = window.setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || msg.type === 'pong') return;

      if (msg.type === 'yjs-sync-step1' && msg.sv) {
        // 1. Enviar al par lo que le falta de nuestro documento
        const remoteSv = base64ToUint8Safe(msg.sv);
        const diff = Y.encodeStateAsUpdate(ydoc, remoteSv);
        sendWsJson({
          type: 'yjs-sync-step2',
          update: uint8ToBase64Safe(diff),
        });

        // 2. Pedirle al par lo que nos falta a nosotros (si no tenía nuestro state vector)
        if (!msg.isReply) {
          const localSv = Y.encodeStateVector(ydoc);
          sendWsJson({
            type: 'yjs-sync-step1',
            sv: uint8ToBase64Safe(localSv),
            isReply: true,
          });
        }

        // 3. Enviar nuestro estado de Awareness (nombre, color y posición del cursor)
        if (awareness) {
          const awarenessUpdate = encodeAwarenessUpdate(awareness, [ydoc.clientID]);
          sendWsJson({
            type: 'yjs-awareness',
            update: uint8ToBase64Safe(awarenessUpdate),
          });
        }
      } else if ((msg.type === 'yjs-sync-step2' || msg.type === 'yjs-update') && msg.update) {
        const updateBytes = base64ToUint8Safe(msg.update);
        Y.applyUpdate(ydoc, updateBytes, 'remote-ws');

        if (msg.type === 'yjs-sync-step2') {
          isRoomSynced = true;
          if (syncFallbackTimerId !== null) {
            window.clearTimeout(syncFallbackTimerId);
            syncFallbackTimerId = null;
          }
          applyPendingInitialContentIfEmpty();
        }
      } else if (msg.type === 'yjs-awareness' && msg.update && awareness) {
        const awarenessBytes = base64ToUint8Safe(msg.update);
        applyAwarenessUpdate(awareness, awarenessBytes, 'remote-ws');
      }
    };

    ws.onclose = () => {
      if (pingIntervalId !== null) {
        window.clearInterval(pingIntervalId);
        pingIntervalId = null;
      }
      if (!isDestroyed) {
        reconnectTimeoutId = window.setTimeout(connectDirectWs, 3000);
      }
    };

    ws.onerror = () => {
      // onclose handles cleanup and reconnect
    };
  };

  const handleDirectYDocUpdate = (update, origin) => {
    if (origin === 'remote-ws' || origin === 'drive-meta-origin') return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'yjs-update',
        update: uint8ToBase64Safe(update),
      }));
    }
  };

  const handleDirectAwarenessUpdate = ({ added, updated, removed }, origin) => {
    if (origin === 'remote-ws') return;
    const changed = added.concat(updated).concat(removed);
    if (changed.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'yjs-awareness',
        update: uint8ToBase64Safe(encodeAwarenessUpdate(awareness, changed)),
      }));
    }
  };

  ydoc.on('update', handleDirectYDocUpdate);
  if (awareness) {
    awareness.on('update', handleDirectAwarenessUpdate);
  }
  connectDirectWs();

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
   * Normalizes a project file key so all collaborators bind to the exact same `Y.Text`.
   *
   * @param {string} filePathOrName
   * @returns {string}
   */
  const normalizeFileKey = (filePathOrName) => {
    const raw = String(filePathOrName || 'main.tex')
      .replace(/^\.+\//, '')
      .replace(/^\/+/, '')
      .trim()
      .toLowerCase();
    return raw || 'main.tex';
  };

  /**
   * Returns the `Y.Text` instance for a given project file name, optionally seeding
   * `initialContent` ONLY once the room is confirmed synced (or empty after 1200ms).
   *
   * @param {string} fileKey
   * @param {string} [initialContent]
   * @returns {Y.Text}
   */
  const getOrCreateFileText = (fileKey, initialContent) => {
    const normalizedKey = normalizeFileKey(fileKey);
    const canonicalMainName = normalizeFileKey(projectMeta.get('mainTexFileName') || 'main.tex');
    const isMainTex =
      !fileKey ||
      normalizedKey === 'main.tex' ||
      normalizedKey === canonicalMainName ||
      normalizedKey.endsWith('.tex');

    const bindingKey = isMainTex ? 'codemirror' : `file:${normalizedKey}`;
    console.log('[Collab] Binding editor to Y.Text key:', isMainTex ? normalizedKey : bindingKey);

    const targetYText = isMainTex ? ytext : ydoc.getText(bindingKey);

    if (typeof initialContent === 'string' && initialContent.length > 0 && targetYText.length === 0) {
      if (isRoomSynced) {
        ydoc.transact(() => {
          if (targetYText.length === 0) {
            targetYText.insert(0, initialContent);
          }
        }, 'initial-load');
      } else {
        pendingInitialContent = { targetYText, content: initialContent };
      }
    }

    return targetYText;
  };

  /**
   * Returns the `Y.Text` instance for a given project file name.
   *
   * @param {string} filePath
   * @returns {Y.Text}
   */
  const getYTextForFile = (filePath) => getOrCreateFileText(filePath);

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
        parentId: fileObj.parentId || (Array.isArray(fileObj.parents) ? fileObj.parents[0] : existingEntry?.parentId) || null,
        parents: Array.isArray(fileObj.parents) ? fileObj.parents : existingEntry?.parents || undefined,
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
          parentId: fileObj.parentId || (Array.isArray(fileObj.parents) ? fileObj.parents[0] : existingEntry?.parentId) || null,
          parents: Array.isArray(fileObj.parents) ? fileObj.parents : existingEntry?.parents || undefined,
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
        const normalized = normalizeFileKey(pathKey);
        const liveYText =
          ydoc.getText(`file:${normalized}`).length > 0
            ? ydoc.getText(`file:${normalized}`)
            : ydoc.getText(`file:${pathKey}`);
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
      projectMeta.set('lastDriveSaveTimestamp', timestampMs);
      projectMeta.set('lastSavedAt', timestampMs);
      projectMeta.set('saveStatus', 'saved');
    }, 'drive-meta-origin');

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

    // Never overwrite the shared CRDT before room sync completes: wait for yjs-sync-step2
    // or the 1200ms solo-room timeout so a joining peer never clobbers live edits.
    if (!isRoomSynced) {
      if (ytext.length === 0) {
        pendingInitialContent = { targetYText: ytext, content: newTexContent };
      }
      return;
    }

    if (ytext.length === 0) {
      ydoc.transact(() => {
        if (ytext.length === 0) {
          ytext.insert(0, newTexContent);
        }
      }, 'initial-load');
      return;
    }

    if (forceOverwrite && ytext.toString() !== newTexContent) {
      ydoc.transact(() => {
        if (ytext.length > 0) {
          ytext.delete(0, ytext.length);
        }
        ytext.insert(0, newTexContent);
      }, 'drive-load');
    }
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
        transaction?.origin === 'drive-load' ||
        transaction?.origin === 'drive-meta-origin' ||
        transaction?.origin === 'remote-ws'
      ) {
        return;
      }

      triggerAutoSaveTimer();
    };

    const triggerAutoSaveTimer = () => {
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

    const handleYDocUpdate = (_update, origin) => {
      if (
        origin === 'initial-boilerplate' ||
        origin === 'drive-load' ||
        origin === 'folder-reconcile-prune' ||
        origin === 'drive-meta-origin' ||
        origin === 'remote-ws' ||
        origin === 'project-meta-update' ||
        origin === 'manual-save-request' ||
        origin === 'cleanup-folder-keys'
      ) {
        return;
      }
      triggerAutoSaveTimer();
    };

    ytext.observe(handleYTextChange);
    ydoc.on('update', handleYDocUpdate);

    return () => {
      clearPendingTimer();
      ytext.unobserve(handleYTextChange);
      ydoc.off('update', handleYDocUpdate);
    };
  };

  /**
   * Cleanly tears down WebRTC connections, IndexedDB listeners, and the Y.Doc instance.
   */
  const destroy = () => {
    try {
      isDestroyed = true;
      if (pingIntervalId !== null) {
        window.clearInterval(pingIntervalId);
        pingIntervalId = null;
      }
      if (reconnectTimeoutId !== null) {
        window.clearTimeout(reconnectTimeoutId);
        reconnectTimeoutId = null;
      }
      if (syncFallbackTimerId !== null) {
        window.clearTimeout(syncFallbackTimerId);
        syncFallbackTimerId = null;
      }
      ydoc.off('update', handleDirectYDocUpdate);
      if (awareness) {
        awareness.off('update', handleDirectAwarenessUpdate);
      }
      if (ws) {
        try { ws.close(1000, 'Session destroyed'); } catch {}
        ws = null;
      }
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
    getOrCreateFileText,
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
