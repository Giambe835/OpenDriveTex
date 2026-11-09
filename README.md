# OpenDriveTeX

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Architecture: Zero-Backend](https://img.shields.io/badge/Architecture-Zero--Backend%20P2P-success)](#architecture-overview)
[![Engine: BusyTeX Wasm](https://img.shields.io/badge/Engine-BusyTeX%20TeX%20Live-orange)](#webassembly-latex-engine--git-lfs-assets)
[![Google Drive: drive.file](https://img.shields.io/badge/Google%20Drive-drive.file%20Scope-4285F4?logo=googledrive&logoColor=white)](#google-drive-integration--security)

**OpenDriveTeX** is an open-source, 100% client-side, peer-to-peer (P2P) collaborative LaTeX authoring environment engineered for the global scientific community. It allows researchers, academics, and students to write, review, and compile publication-grade LaTeX manuscripts collaboratively in real time using their own **Google Drive** storage—without proprietary cloud subscriptions, paywalled collaborator caps, compilation timeouts, or third-party servers that access manuscript data.

---

## Why OpenDriveTeX?

Scientific collaboration should not be gated behind artificial limits or closed infrastructure. Commercial cloud LaTeX services run expensive server-side compilation clusters, forcing them to restrict free collaboration and monetize co-author access.

**OpenDriveTeX changes the paradigm:**
* **Zero Server Overhead (Forever Free):** LaTeX compilation executes client-side inside a dedicated Web Worker powered by **WebAssembly (BusyTeX / TeX Live)**. Your local machine compiles your document at native speed.
* **True Academic Privacy:** Unpublished research papers, figure assets, and `.bib` libraries never touch an intermediate application server. Data flows directly between your browser, your Google Drive, and your collaborators via end-to-end encrypted WebRTC channels.
* **Unlimited Real-Time Collaboration:** Powered by Conflict-free Replicated Data Types (**Yjs CRDTs**), any number of co-authors can edit simultaneously with colored presence indicators, awareness badges, and non-conflicting edits.
* **Drive-First Workflow:** Strictly integrated with Google Drive using the least-privilege `drive.file` OAuth scope, automatic session persistence across reloads, and an automated Leader-elected Drive sync.

---

## Architecture Overview

```text
+-----------------------------------------------------------------------------------------+
|                               Researcher's Browser (PWA)                                |
|                                                                                         |
|  +---------------------------+             +-----------------------------------------+  |
|  |     CodeMirror 6 Editor   | <---------> |        Yjs CRDT Document State          |  |
|  |  * Code & WYSIWYG Modes   |             |   * ytext ('codemirror')                |  |
|  |  * Review & Track Changes |             |   * auxFilesMap (Y.Map for .bib/.png)   |  |
|  |  * Context-Aware Search   |             |   * projectMeta (Y.Map for sync state)  |  |
|  +---------------------------+             +--------------------+--------------------+  |
|                |                                                |                       |
|                v (Virtual MEMFS Sync)                           |                       |
|  +---------------------------+                                  |                       |
|  |  LaTeX Web Worker (Wasm)  |                                  |                       |
|  |  * BusyTeX (TeX Live)     |                                  |                       |
|  |  * Serialized Job Queue   |                                  |                       |
|  |  * BibTeX & On-Demand CTAN|                                  |                       |
|  +-------------+-------------+                                  |                       |
|                | (PDF ArrayBuffer)                              |                       |
|                v                                                |                       |
|  +---------------------------+                                  |                       |
|  |     Native PDF Preview    |                                  |                       |
|  |  (Blob Object URL Iframe) |                                  |                       |
|  +---------------------------+                                  |                       |
+-----------------------------------------------------------------+-----------------------+
                                                                  |
                                 +--------------------------------+-----------------+
                                 |                                                  |
                                 v (Encrypted P2P WebRTC)                           v (HTTPS REST API v3)
+--------------------------------------------------+              +------------------------------------+
|               Co-Authors' Browsers               |              |            Google Drive            |
|  * P2P Live Cursors & Awareness                  |              |  * Persistent Cloud Storage        |
|  * Co-Author Comments & Suggestions              |              |  * Least-Privilege drive.file      |
|  * Leader-Elected Save Coordination              |              |  * Drive "Open With" Integration   |
+--------------------------------------------------+              +------------------------------------+
```

---

## Key Features

### 1. Dual Editing Modes: Code & Two-Way Visual Editor
* **Code Editor:** Full syntax highlighting, line numbers, bracket matching, code folding, dark/light themes, and Vim/Emacs-friendly bindings powered by CodeMirror 6.
* **Visual WYSIWYG Editor:** Read and edit manuscripts in a rich visual format without exposing raw LaTeX delimiters:
  * **Interactive Document Header:** Live, editable Title and Author blocks bound bi-directionally to `\title{...}` and `\author{...}`.
  * **Abstract Environment:** Renders `\begin{abstract}` as a clean container while keeping raw syntax hidden.
  * **Interactive Figure Cards:** Live image rendering from virtual MEMFS / Drive with editable caption binding (`\caption{...}`) and toggleable raw LaTeX source.
  * **Bidirectional Table Widget:** Visual interactive HTML `<table>` for `\begin{tabular}` environments with cell navigation (`Tab` / `Shift+Tab`), row/column buttons, and direct character-range synchronisation.

### 2. Academic Review Mode: Comments & Track Changes
* **Silent LaTeX Macro Schema:** All review metadata is preserved directly inside the `.tex` file via lightweight macros that compile cleanly even outside OpenDriveTeX:
  ```latex
  % --- OPENDRIVETEX REVIEW MACROS ---
  \providecommand{\odtcomment}[3]{#3}
  \providecommand{\odtadd}[2]{#2}
  \providecommand{\odtdel}[2]{}
  % --- END OPENDRIVETEX REVIEW MACROS ---
  ```
* **Track Changes ("Suggesting Mode"):**
  * **Insertions** (`\odtadd{Author|Timestamp|ID}{text}`) are rendered with green underlines and accept/reject controls.
  * **Deletions** (`\odtdel{Author|Timestamp|ID}{text}`) are rendered as strikethrough badges without destroying manuscript history.
* **Inline Comments:** Wrap any selected text in `\odtcomment{Author|Timestamp|ID}{Comment}{text}`. Authors and co-authors can review, reply to, and resolve comments inline or in the dedicated Review Sidebar.
* **Google Account Attribution:** Suggestions and comments automatically link to the authenticated Google profile (author name, avatar, and timestamp).

### 3. Pre-Flight Submission Export
* **Export for Journal Submission:** Export clean `.tex` files or whole-project `.zip` archives.
* **Pre-Flight Review Guard:** Scans the manuscript for unresolved comments (`\odtcomment`), pending insertions (`\odtadd`), or unaccepted deletions (`\odtdel`). Displays an interactive modal enabling one-click bulk resolution or jumping directly to pending review items.

### 4. Drive-First Workflow & Google Drive Integration
* **Strict Drive Integration:** No stale local cache conflicts. The document state is fetched directly from Google Drive API on project open or reload.
* **Google Drive "Open With":** Fully registered with Google Drive's UI Integration (`?state={"ids":[...],"action":"open"}`), letting you right-click any `.tex` file or project folder in Google Drive and open it directly in OpenDriveTeX.
* **Google Picker API:** Open project folders, shared drives, or manuscripts via the Google Picker modal.
* **Missing Dependency Scanner:** Automatically parses `\includegraphics{...}` and `\bibliography{...}` commands and guides you to authorize missing assets via Google Picker.
* **Leader-Elected Auto-Save:** Connected collaborators elect a single Save Leader via Yjs Awareness to debounce saves (every 30 seconds or on `Ctrl+S`), preventing Google Drive quota throttling.
* **Session Persistence:** OAuth credentials and profile metadata persist securely across hard browser refreshes (`F5`), keeping pending edits and session context intact.

### 5. Context-Aware Search & Hotkeys
* **Intelligent `Ctrl+F` / `Cmd+F`:** Intercepts browser search and focuses the active context:
  * **In CodeMirror:** opens the native search/replace panel (`@codemirror/search`).
  * **In PDF Preview:** routes focus to the PDF reader's search bar.
* **Compilation Timeout Guard:** Worker compilation jobs are queued and tracked with automatic timer cancellation, eliminating false-positive timeout errors.

---

## WebAssembly LaTeX Engine & Git LFS Assets

OpenDriveTeX utilizes **BusyTeX WebAssembly** (TeX Live) with pre-compiled package bundles:
* `texlive-recommended.data` (~201 MB)
* `texlive-basic.data` (~92 MB)
* `texlive-extra.data` (~341 MB)
* `biber.data` (~21 MB)

These binaries are stored in `public/core/busytex/` and managed using **Git Large File Storage (Git LFS)**.

> [!IMPORTANT]
> When cloning the repository, make sure you have **Git LFS** installed so that `.data` binaries are downloaded completely:
> ```bash
> git lfs install
> git lfs pull
> ```

---

## Getting Started (Local Development)

### Prerequisites
* **Node.js** (v18.0.0 or higher, tested with Node v22+)
* **npm** (v9+ or higher)
* **Git LFS** (required to pull TeX Live WebAssembly data files)

### 1. Clone the Repository
```bash
git clone https://github.com/Giambe835/OpenDriveTex.git
cd OpenDriveTex
```

> [!WARNING]
> Do **not** use GitHub's "Download ZIP" button, as GitHub archives do not resolve Git LFS pointers and will download 130-byte text files instead of the required WebAssembly `.data` binaries. Always clone via Git.

### 2. Pull Git LFS Data Files
Ensure the `.data` packages in `public/core/busytex/` are downloaded:
```bash
git lfs install
git lfs pull
```
*(Verify that files such as `public/core/busytex/texlive-recommended.data` are actual binary files of ~200 MB, rather than 130-byte Git LFS pointer text files).*

### 3. Install Dependencies
```bash
npm install
```

### 4. Configure Google Drive API Credentials
1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new Google Cloud Project.
3. Enable both the **Google Drive API** and **Google Picker API**.
4. Configure your **OAuth Consent Screen** (User Type: External) and add the following scopes:
   * `https://www.googleapis.com/auth/drive.file`
   * `openid`
   * `profile`
   * `email`
5. Create an **OAuth 2.0 Web Client ID**:
   * Add `http://localhost:5173` to **Authorized JavaScript origins**.
6. Create a **Google API Key** (for Google Picker).
7. Create a `.env` file in the project root:
   ```bash
   cp .env.example .env
   ```
   Populate it with your credentials:
   ```env
   VITE_GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
   VITE_GOOGLE_API_KEY=your_api_key_here
   ```

### 5. Start the Development Server
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 6. Production Build
```bash
npm run build
npm run preview
```

---

## Keyboard Shortcuts

| Shortcut | Action | Scope |
| :--- | :--- | :--- |
| `Ctrl + Enter` / `Cmd + Enter` | Compile LaTeX document to PDF | Global |
| `Ctrl + S` / `Cmd + S` | Save manuscript to Google Drive (via Save Leader) | Global |
| `Ctrl + F` / `Cmd + F` | Context-Aware Search (CodeMirror Search / PDF Search) | Global |
| `Tab` / `Shift + Tab` | Navigate between cells | Visual Table Widget |
| `Ctrl + Z` / `Cmd + Z` | Undo edit (scoped per collaborator via Yjs UndoManager)| CodeMirror |
| `Ctrl + Y` / `Cmd + Shift + Z` | Redo edit | CodeMirror |

---

## Google Drive Integration & Security

* **`drive.file` Scope:** OpenDriveTeX **never** requests full Google Drive permissions (`https://www.googleapis.com/auth/drive`). It operates solely under the secure, per-file `drive.file` scope. The application can only read or modify files that you explicitly create within OpenDriveTeX or select via the Google Picker.
* **Shared Folder Collaboration:** Collaborators who open a shared project folder join the same Yjs room (keyed by Google Drive `folderId`), ensuring real-time multi-user synchronisation without backend servers.
* **Clean Submissions:** When preparing manuscripts for arXiv or journal submission, review comments and suggestions are completely stripped to generate clean `.tex` and `.zip` archives.

---

## Contributing

Contributions from physicists, computer scientists, mathematicians, and open-source developers are warmly welcomed!

1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/my-feature`).
3. Commit your changes with descriptive English messages (`git commit -m 'feat: add custom macro auto-complete'`).
4. Push to the branch (`git push origin feature/my-feature`).
5. Open a Pull Request.

---

## Author & Citation

**OpenDriveTeX** was architected and developed by **Dr. Francisco Luis Giambelluca**.

If you use OpenDriveTeX in your research workflow or academic publications, please cite it using the following metadata (DOI to be updated upon Zenodo release):

```bibtex
@software{giambelluca_opendrivetex_2026,
  author       = {Giambelluca, Francisco Luis},
  title        = {{OpenDriveTeX: A Zero-Backend, P2P Collaborative LaTeX Environment for Google Drive}},
  year         = {2026},
  publisher    = {Zenodo},
  url          = {https://github.com/Giambe835/OpenDriveTex}
}
```

---

## License

Copyright © 2026 **Francisco Luis Giambelluca**.  
Distributed under the **MIT License**. Free for academic, personal, and commercial research. See [`LICENSE`](LICENSE) for details.
