/**
 * @fileoverview Collapsible Left Sidebar for OpenDriveTeX.
 * Displays:
 *   1. Project Files Explorer (`.tex`, `.bib`, `.sty`, `.cls`, subfolders, and figures)
 *      with single `Sync with Drive` button and `+ New File`, `+ New Folder`, `+ Upload` actions.
 *   2. Minimalist Drive Sync Status footer card showing Last Saved time, Live Auto-Save Countdown
 *      timer, Light/Dark Theme toggle, and Sign Out button.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  FolderOpen,
  FolderSearch,
  FileCode2,
  BookOpen,
  Image,
  HardDrive,
  ChevronRight,
  ChevronDown,
  FilePlus2,
  RefreshCw,
  LogOut,
  CheckCircle2,
  AlertCircle,
  Upload,
  FolderPlus,
  Package,
  Trash2,
  Sun,
  Moon,
  Clock,
  Loader2,
} from 'lucide-react';
import { isImageAssetFile } from '../services/driveService';

/**
 * Collapsible Project Sidebar component.
 */
export default function Sidebar({
  isOpen,
  collabSession,
  activeFile = 'main.tex',
  onSelectFile,
  auxFiles = [],
  expandedFolders: propExpandedFolders,
  setExpandedFolders: propSetExpandedFolders,
  onUploadLocalAuxFile,
  onDeleteProjectFile,
  onCreateSubfolder,
  onCreateProjectFile,
  onSyncFromDrive,
  isSyncingFromDrive = false,
  isDriveAuthenticated = false,
  driveFileId = null,
  driveFileName = 'main.tex',
  driveFolderId = null,
  driveFolderName = '',
  driveSaveStatus = 'idle',
  driveError = null,
  lastSavedAt = null,
  nextAutoSaveAt = null,
  onConnectDrive,
  onDisconnectDrive,
  onOpenGooglePicker,
  theme = 'dark',
  onToggleTheme,
}) {
  const [isFilesExpanded, setIsFilesExpanded] = useState(true);
  const [localExpandedFolders, setLocalExpandedFolders] = useState(
    () => new Set(['output_figures'])
  );
  const expandedFolders = propExpandedFolders || localExpandedFolders;
  const setExpandedFolders = propSetExpandedFolders || setLocalExpandedFolders;
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadTargetSubfolder, setUploadTargetSubfolder] = useState('');
  const [countdownSec, setCountdownSec] = useState(null);

  const fileInputRef = useRef(null);
  const subfolderFileInputRef = useRef(null);

  // Update 30-second auto-save countdown ticker when document has unsaved edits
  useEffect(() => {
    if (!nextAutoSaveAt || driveSaveStatus !== 'dirty') {
      setCountdownSec(null);
      return undefined;
    }

    const updateTicker = () => {
      const remaining = Math.max(0, Math.ceil((nextAutoSaveAt - Date.now()) / 1000));
      setCountdownSec(remaining);
    };

    updateTicker();
    const interval = window.setInterval(updateTicker, 500);
    return () => window.clearInterval(interval);
  }, [nextAutoSaveAt, driveSaveStatus]);

  if (!isOpen) {
    return null;
  }

  const toggleFolder = (folderName) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderName)) {
        next.delete(folderName);
      } else {
        next.add(folderName);
      }
      return next;
    });
  };

  const handleCreateNewFilePrompt = () => {
    const fileName = window.prompt(
      'Enter new file name with extension (e.g., section1.tex, references.bib, custom.sty):',
      'section1.tex'
    );
    if (!fileName || !fileName.trim()) return;
    const cleanName = fileName.trim().replace(/^\.+\//, '');
    if (cleanName && onCreateProjectFile) {
      onCreateProjectFile(cleanName);
    }
  };

  const handleCreateSubfolderPrompt = () => {
    const folderName = window.prompt(
      'Enter new subfolder name (e.g., output_figures):',
      'output_figures'
    );
    if (!folderName || !folderName.trim()) return;
    const clean = folderName.replace(/[\\/]/g, '').trim();
    if (clean && onCreateSubfolder) {
      onCreateSubfolder(clean);
      setExpandedFolders((prev) => new Set([...prev, clean]));
    }
  };

  const handleUploadToSubfolderClick = (subfolderName) => {
    setUploadTargetSubfolder(subfolderName);
    subfolderFileInputRef.current?.click();
  };

  const handleSubfolderFilePicked = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0 || !onUploadLocalAuxFile) return;
    for (const file of files) {
      const relPath = uploadTargetSubfolder
        ? `${uploadTargetSubfolder}/${file.name}`
        : file.name;
      onUploadLocalAuxFile(file, relPath);
    }
    e.target.value = '';
    setUploadTargetSubfolder('');
  };

  const handleLocalFilePicked = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0 || !onUploadLocalAuxFile) return;
    for (const file of files) {
      onUploadLocalAuxFile(file);
    }
    e.target.value = '';
  };

  // Drag and Drop folder/file upload handling
  const handleDropFileOrFolder = async (e) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!onUploadLocalAuxFile) return;

    const items = e.dataTransfer.items;
    if (!items || items.length === 0) return;

    const readEntry = (entry, basePath = '') => {
      if (entry.isFile) {
        entry.file((file) => {
          const fullPath = basePath ? `${basePath}/${file.name}` : file.name;
          onUploadLocalAuxFile(file, fullPath);
        });
      } else if (entry.isDirectory) {
        const nextBase = basePath ? `${basePath}/${entry.name}` : entry.name;
        if (onCreateSubfolder) {
          onCreateSubfolder(nextBase);
        }
        setExpandedFolders((prev) => new Set([...prev, nextBase]));
        const dirReader = entry.createReader();
        dirReader.readEntries((entries) => {
          for (const child of entries) {
            readEntry(child, nextBase);
          }
        });
      }
    };

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        readEntry(entry);
      } else {
        const file = item.getAsFile ? item.getAsFile() : null;
        if (file) {
          onUploadLocalAuxFile(file);
        }
      }
    }
  };

  const mainTexName = driveFileName || 'main.tex';

  return (
    <aside
      className="w-72 bg-slate-900/95 border-r border-slate-800 flex flex-col justify-between shrink-0 select-none overflow-y-auto"
      aria-label="Project Files and Drive Status"
    >
      {/* Top Section: Project Files Tree & Action Toolbar */}
      <div className="p-3 space-y-3">
        {/* Project Header with Single Sync with Drive Button */}
        <div className="flex items-center justify-between px-1.5 py-1 gap-2">
          <button
            type="button"
            onClick={() => setIsFilesExpanded((prev) => !prev)}
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-300 hover:text-white transition-colors truncate cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span className="truncate">
              {driveFolderName ? driveFolderName : 'Project Files'}
            </span>
            {isFilesExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
            )}
          </button>

          {collabSession && isDriveAuthenticated && driveFolderId && onSyncFromDrive && (
            <button
              type="button"
              onClick={onSyncFromDrive}
              disabled={isSyncingFromDrive}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-[11px] font-medium cursor-pointer shrink-0 disabled:opacity-60 transition-colors"
              title="Sync with Google Drive"
              data-testid="sync-from-drive-button"
            >
              <RefreshCw
                className={`w-3 h-3 ${isSyncingFromDrive ? 'animate-spin' : ''}`}
              />
              <span>{isSyncingFromDrive ? 'Syncing...' : 'Sync with Drive'}</span>
            </button>
          )}
        </div>

        {/* Project Creation & Upload Toolbar (+ New File, + New Folder, + Upload) */}
        {collabSession && (
          <div className="space-y-1.5 px-1">
            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={handleCreateNewFilePrompt}
                className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-medium cursor-pointer transition-colors"
                title="Create a new file (.tex, .bib, .sty, .cls) in Drive and MEMFS"
                data-testid="new-file-button"
              >
                <FilePlus2 className="w-3 h-3 text-indigo-400 shrink-0" />
                <span>+ New File</span>
              </button>

              <button
                type="button"
                onClick={handleCreateSubfolderPrompt}
                className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-medium cursor-pointer transition-colors"
                title="Create a new subfolder (e.g., output_figures/)"
                data-testid="create-subfolder-button"
              >
                <FolderPlus className="w-3 h-3 text-sky-400 shrink-0" />
                <span>+ Folder</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-medium cursor-pointer transition-colors"
                title="Upload local files (.bib, .sty, .cls, images)"
                data-testid="upload-aux-button"
              >
                <Upload className="w-3 h-3 text-emerald-400 shrink-0" />
                <span>+ Upload</span>
              </button>
            </div>

            {isDriveAuthenticated && driveFolderId && onOpenGooglePicker && (
              <button
                type="button"
                onClick={() => onOpenGooglePicker('files')}
                className="w-full py-1 px-2 rounded-md bg-slate-950/80 hover:bg-slate-800 border border-slate-800 text-sky-300 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                title="Authorize existing files in this Google Drive folder via Google Picker"
                data-testid="import-authorize-drive-files-button"
              >
                <FolderSearch className="w-3 h-3" />
                <span>Authorize Drive Files</span>
              </button>
            )}

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".tex,.bib,.sty,.cls,.bst,.txt,.png,.jpg,.jpeg,.gif,.svg,.webp,.pdf"
              onChange={handleLocalFilePicked}
              className="hidden"
            />
            <input
              ref={subfolderFileInputRef}
              type="file"
              multiple
              accept=".tex,.bib,.sty,.cls,.bst,.txt,.png,.jpg,.jpeg,.gif,.svg,.webp,.pdf"
              onChange={handleSubfolderFilePicked}
              className="hidden"
            />
          </div>
        )}

        {/* File Tree List */}
        {isFilesExpanded && (
          <>
            {!collabSession ? (
              <div className="mx-1 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 text-xs text-slate-400 leading-relaxed">
                No project loaded. Sign in with Google Drive and open or create a project to view its files.
              </div>
            ) : (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDropFileOrFolder}
                className={`transition-colors rounded-lg ${
                  isDragOver
                    ? 'bg-indigo-950/40 border border-dashed border-indigo-400/80 p-1'
                    : ''
                }`}
              >
                <ul className="space-y-1 pl-1">
                  {/* Primary LaTeX Manuscript */}
                  <li className="flex items-center gap-1 group">
                    <button
                      type="button"
                      onClick={() => onSelectFile && onSelectFile(mainTexName)}
                      className={`flex-1 min-w-0 flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                        activeFile === mainTexName
                          ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40 font-medium'
                          : 'text-slate-300 hover:bg-slate-800/70'
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <FileCode2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                        <span className="truncate">{mainTexName}</span>
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-300 font-sans shrink-0">
                        Main
                      </span>
                    </button>

                    {onDeleteProjectFile && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteProjectFile({
                            path: mainTexName,
                            name: mainTexName,
                            id: driveFileId,
                            isMain: true,
                          });
                        }}
                        className="p-1.5 rounded-md text-slate-500 hover:text-rose-400 hover:bg-rose-950/50 transition-colors cursor-pointer shrink-0 opacity-70 group-hover:opacity-100"
                        title={`Delete ${mainTexName}`}
                        aria-label={`Delete ${mainTexName}`}
                        data-testid="delete-file-main-tex"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>

                  {/* Root Level Auxiliary Files (.tex, .bib, .sty, .cls, figures) */}
                  {auxFiles
                    .filter(
                      (f) =>
                        !f.path.includes('/') &&
                        f.mimeType !== 'application/vnd.google-apps.folder' &&
                        !f.isFolder &&
                        !expandedFolders.has(f.path)
                    )
                    .map((aux) => {
                      const isBib = aux.path.endsWith('.bib');
                      const isTex = aux.path.endsWith('.tex');
                      const isFigure =
                        aux.category === 'figure' ||
                        isImageAssetFile(aux.path, aux.mimeType);
                      const isSelected = activeFile === aux.path;

                      return (
                        <li key={aux.path} className="flex items-center gap-1 group">
                          <button
                            type="button"
                            onClick={() => onSelectFile && onSelectFile(aux.path)}
                            className={`flex-1 min-w-0 flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                              isSelected
                                ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40 font-medium'
                                : 'text-slate-300 hover:bg-slate-800/70'
                            }`}
                            title={
                              isFigure
                                ? `Click to preview image ${aux.path}`
                                : `Click to edit ${aux.path}`
                            }
                          >
                            <span className="flex items-center gap-2 truncate">
                              {isBib ? (
                                <BookOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              ) : isFigure ? (
                                <Image className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                              ) : isTex ? (
                                <FileCode2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                              ) : (
                                <Package className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                              )}
                              <span className="truncate">{aux.path}</span>
                            </span>
                          </button>

                          {onDeleteProjectFile && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteProjectFile(aux);
                              }}
                              className="p-1.5 rounded-md text-slate-500 hover:text-rose-400 hover:bg-rose-950/50 transition-colors cursor-pointer shrink-0 opacity-70 group-hover:opacity-100"
                              title={`Delete ${aux.path}`}
                              aria-label={`Delete ${aux.path}`}
                              data-testid={`delete-file-${aux.path}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </li>
                      );
                    })}

                  {/* Subfolders (e.g., output_figures/) */}
                  {(() => {
                    const subfolderMap = new Map();
                    expandedFolders.forEach((f) => {
                      if (!subfolderMap.has(f)) subfolderMap.set(f, []);
                    });
                    auxFiles.forEach((f) => {
                      if (f.path.includes('/')) {
                        const parts = f.path.split('/');
                        const folderName = parts[0];
                        if (!subfolderMap.has(folderName)) {
                          subfolderMap.set(folderName, []);
                        }
                        subfolderMap.get(folderName).push(f);
                      }
                    });

                    const sortedFolders = Array.from(subfolderMap.entries()).sort(([a], [b]) =>
                      a.localeCompare(b)
                    );

                    return sortedFolders.map(([folderName, filesInFolder]) => {
                      const isFolderExpanded = expandedFolders.has(folderName);

                      return (
                        <li key={`subfolder-${folderName}`} className="space-y-1 pt-1">
                          {/* Subfolder Header */}
                          <div className="flex items-center justify-between px-2 py-1 rounded bg-slate-950/60 border border-slate-800/80 text-xs">
                            <button
                              type="button"
                              onClick={() => toggleFolder(folderName)}
                              className="flex items-center gap-1.5 font-medium text-slate-300 hover:text-white truncate cursor-pointer"
                            >
                              {isFolderExpanded ? (
                                <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
                              ) : (
                                <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
                              )}
                              <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              <span className="font-mono truncate">{folderName}/</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleUploadToSubfolderClick(folderName)}
                              className="p-1 rounded text-slate-400 hover:text-sky-300 hover:bg-slate-800 transition-colors text-[10px] flex items-center gap-1 cursor-pointer"
                              title={`Upload files into ${folderName}/`}
                            >
                              <Upload className="w-2.5 h-2.5" />
                              <span>+ File</span>
                            </button>
                          </div>

                          {/* Subfolder Contents */}
                          {isFolderExpanded && (
                            <ul className="pl-3.5 space-y-1 border-l border-slate-800/60 ml-2">
                              {filesInFolder.length === 0 ? (
                                <li className="px-2 py-1 text-[11px] text-slate-500 italic">
                                  Empty subfolder
                                </li>
                              ) : (
                                filesInFolder.map((aux) => {
                                  const leafName = aux.path.split('/').slice(1).join('/');
                                  const isFigure =
                                    aux.category === 'figure' ||
                                    isImageAssetFile(aux.path, aux.mimeType);
                                  const isSelected = activeFile === aux.path;

                                  return (
                                    <li key={aux.path} className="flex items-center gap-1 group">
                                      <button
                                        type="button"
                                        onClick={() => onSelectFile && onSelectFile(aux.path)}
                                        className={`flex-1 min-w-0 flex items-center justify-between px-2 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                                          isSelected
                                            ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40 font-medium'
                                            : 'text-slate-300 hover:bg-slate-800/70'
                                        }`}
                                        title={
                                          isFigure
                                            ? `Preview image ${aux.path}`
                                            : `Edit ${aux.path}`
                                        }
                                      >
                                        <span className="flex items-center gap-2 truncate">
                                          {isFigure ? (
                                            <Image className="w-3 h-3 text-cyan-400 shrink-0" />
                                          ) : (
                                            <Package className="w-3 h-3 text-purple-400 shrink-0" />
                                          )}
                                          <span className="truncate">{leafName}</span>
                                        </span>
                                      </button>

                                      {onDeleteProjectFile && (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            onDeleteProjectFile(aux);
                                          }}
                                          className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-950/50 transition-colors cursor-pointer shrink-0 opacity-70 group-hover:opacity-100"
                                          title={`Delete ${aux.path}`}
                                          aria-label={`Delete ${aux.path}`}
                                          data-testid={`delete-file-${aux.path}`}
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      )}
                                    </li>
                                  );
                                })
                              )}
                            </ul>
                          )}
                        </li>
                      );
                    });
                  })()}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom Section: Minimalist Drive Sync Status Card & Theme Switcher */}
      <div className="p-3 border-t border-slate-800/80 bg-slate-950/60 space-y-2.5">
        {driveError && (
          <div className="p-2 rounded-lg bg-rose-950/60 border border-rose-800/70 text-[11px] text-rose-200 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
            <span className="break-words">{driveError}</span>
          </div>
        )}

        {/* Minimalist Drive Sync Status Card */}
        <div
          className="bg-slate-900/90 border border-slate-800 rounded-xl p-3 space-y-2 text-xs"
          data-testid="drive-sync-status-card"
        >
          {!isDriveAuthenticated ? (
            <button
              type="button"
              onClick={onConnectDrive}
              className="w-full py-2 px-3 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center justify-center gap-2 shadow-sm transition-all cursor-pointer"
              data-testid="connect-drive-button"
            >
              <HardDrive className="w-3.5 h-3.5" />
              <span>Sign in with Google Drive</span>
            </button>
          ) : (
            <>
              {/* Live Auto-Save Countdown Timer or Saved Indicator */}
              <div className="flex items-center justify-between">
                {driveSaveStatus === 'saving' ? (
                  <span className="flex items-center gap-1.5 text-sky-300 font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Saving to Google Drive...</span>
                  </span>
                ) : driveSaveStatus === 'dirty' && countdownSec !== null ? (
                  <span
                    className="flex items-center gap-1.5 text-amber-300 font-medium"
                    data-testid="auto-save-countdown"
                  >
                    <Clock className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                    <span>Auto-saving in {countdownSec}s...</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>All changes saved to Drive</span>
                  </span>
                )}
              </div>

              {/* Subtle countdown progress bar when dirty */}
              {driveSaveStatus === 'dirty' && countdownSec !== null && (
                <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-400 transition-all duration-500"
                    style={{
                      width: `${Math.min(100, Math.max(5, ((30 - countdownSec) / 30) * 100))}%`,
                    }}
                  />
                </div>
              )}

              {/* Last Saved Time */}
              <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
                <span>Last saved:</span>
                <span className="font-mono text-slate-300">
                  {lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : '—'}
                </span>
              </div>

              {/* Sign Out Button */}
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                <button
                  type="button"
                  onClick={onDisconnectDrive}
                  className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                  data-testid="sign-out-drive-button"
                >
                  <LogOut className="w-3 h-3" />
                  <span>Sign Out</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Light / Dark Theme Toggle Button */}
        {onToggleTheme && (
          <button
            type="button"
            onClick={onToggleTheme}
            className="w-full py-1.5 px-3 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white flex items-center justify-between transition-colors cursor-pointer"
            title={
              theme === 'dark' ? 'Switch to Academic Light Mode' : 'Switch to Dark Mode'
            }
            data-testid="theme-toggle-button"
          >
            <span className="flex items-center gap-2">
              {theme === 'dark' ? (
                <Sun className="w-3.5 h-3.5 text-amber-400" />
              ) : (
                <Moon className="w-3.5 h-3.5 text-indigo-400" />
              )}
              <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
            </span>
            <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
              {theme === 'dark' ? 'Dark' : 'Light'}
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}
