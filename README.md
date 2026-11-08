# OpenDriveTeX

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Architecture: Zero-Backend](https://img.shields.io/badge/Architecture-Zero--Backend%20P2P-success)](#architecture)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

**OpenDriveTeX** is an open-source, 100% client-side, peer-to-peer (P2P) collaborative $\LaTeX$ environment built for the global scientific community. It enables researchers, students, and academics to write and compile $\LaTeX$ manuscripts collaboratively in real time using their existing **Google Drive** storage—without relying on proprietary cloud platforms, paywalled collaborator limits, or third-party servers that harvest academic data.

---

## Why OpenDriveTeX?

Scientific collaboration should not be gated behind recurring subscriptions or artificial limits on the number of co-authors and compilation timeouts. Traditional cloud $\LaTeX$ platforms require expensive server clusters to compile documents, forcing them to monetize collaboration features.

**OpenDriveTeX flips the paradigm:**
* **Zero Server Costs (Forever Free):** $\LaTeX$ compilation happens directly inside your browser using **WebAssembly (Wasm)**. Your CPU compiles your paper.
* **True Data Privacy:** Your unpublished manuscripts, figures, and `.bib` files never touch an intermediate backend server. Files flow strictly between your browser, your Google Drive, and your co-authors' browsers via encrypted WebRTC channels.
* **Unlimited Collaborators:** Powered by Conflict-free Replicated Data Types (**CRDTs** via **Yjs**), any number of co-authors with access to the Google Drive file can edit simultaneously with live cursors.
* **Google Drive Native:** Leverage the cloud storage, folder permissions, and revision history that your lab or university already uses.

---

## Architecture Overview

```text
+-------------------------------------------------------------------------+
|                        Researcher's Browser (PWA)                       |
|                                                                         |
|  +-----------------------+       +-----------------------------------+  |
|  |   CodeMirror 6 UI     | <---> |     Yjs CRDT Document State       |  |
|  |  (LaTeX Syntax & Vim) |       |  (Single Source of Truth in RAM)  |  |
|  +-----------------------+       +-----------------+-----------------+  |
|              |                                     |                    |
|              v (Virtual FS)                        |                    |
|  +-----------------------+                         |                    |
|  |   Web Worker (Wasm)   |                         |                    |
|  |  SwiftLaTeX / BusyTeX |                         |                    |
|  +-----------+-----------+                         |                    |
|              | (PDF Blob)                          |                    |
|              v                                     |                    |
|  +-----------------------+                         |                    |
|  |   Native PDF Viewer   |                         |                    |
|  +-----------------------+                         |                    |
+----------------------------------------------------+--------------------+
                                                     |
                  +----------------------------------+-----------------+
                  |                                                    |
                  v (Encrypted P2P WebRTC)                             v (HTTPS REST API v3)
+-----------------------------------+                +-----------------------------------+
|     Co-Authors' Browsers          |                |           Google Drive            |
|  (Live Cursors & Real-Time Sync)  |                |  (Persistent Storage & Versions)  |
+-----------------------------------+                +-----------------------------------+
```

### Key Technical Pillars
1. **CRDT Synchronization (`Yjs` + `y-webrtc`):** Ensures eventual consistency across all peers without a central database. Offline edits are cached locally in `IndexedDB` and merged seamlessly upon reconnection.
2. **Leader-Elected Drive Persistence:** To prevent API quota exhaustion when multiple authors edit simultaneously, connected peers automatically elect a single "Save Leader" via the Yjs Awareness protocol to commit snapshots back to Google Drive.
3. **Least-Privilege Security (`drive.file`):** OpenDriveTeX only requests access to the specific files or folders you explicitly open or create through the app—never your entire Google Drive.

---

## Getting Started (Local Development)

### Prerequisites
* **Node.js** (v18+ recommended) and `npm`
* A modern web browser with WebAssembly support (Chrome, Firefox, Edge, Brave, Safari)

### 1. Clone and Install
```bash
git clone https://github.com/yourusername/opendrivetex.git
cd opendrivetex
npm install
```

### 2. Configure Google Drive Credentials (Optional for Local Testing)
You can test real-time P2P collaboration and $\LaTeX$ compilation immediately without Google Drive credentials. To enable Google Drive synchronization:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project and enable the **Google Drive API** and **Google Picker API**.
3. Configure the OAuth Consent Screen and add the scope `https://www.googleapis.com/auth/drive.file`.
4. Create an **OAuth 2.0 Client ID** (Web Application) and add `http://localhost:5173` to *Authorized JavaScript origins*.
5. Copy `.env.example` to `.env` and fill in your credentials:
   ```env
   VITE_GOOGLE_CLIENT_ID=your_client_id_here.apps.googleusercontent.com
   VITE_GOOGLE_API_KEY=your_api_key_here
   ```

### 3. Run the Development Server
```bash
npm run dev
```
Open `http://localhost:5173` in two separate browser tabs to see real-time P2P synchronization in action.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl + Enter` (or `Cmd + Enter`) | Compile $\LaTeX$ document to PDF |
| `Ctrl + S` (or `Cmd + S`) | Force immediate snapshot save to Google Drive |

---

## Contributing

Contributions from physicists, mathematicians, computer scientists, and open-source developers are warmly welcomed! Whether it is improving SyncTeX support, adding BibTeX autocompletion, or optimizing WebAssembly package caching:

1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes with clear English comments (`git commit -m 'Add BibTeX citation autocomplete'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

---

## License

Distributed under the **MIT License**. Free for academic, personal, and commercial use. See `LICENSE` for more information.

