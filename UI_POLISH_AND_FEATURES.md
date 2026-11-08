# UI DECLUTTERING, WORKFLOW POLISH & NEW FEATURES (`UI_POLISH_AND_FEATURES.md`)

## 1. Objective
Now that the core CRDT collaboration, Google Drive synchronization, and BusyTeX WebAssembly compilation are working reliably, we need to clean up developer-oriented technical clutter from the UI, streamline redundant controls, and add key user-experience features before public deployment.

All code, UI labels, comments, and documentation MUST be in clear English.

---

## 2. Branding & Custom App Icon
1. **Create Official App Icon & Favicon (`public/icon.svg` and header logo):**
   - Design a clean, modern, high-contrast vector SVG icon representing scientific $\LaTeX$ publishing and cloud collaboration (e.g., a stylized $\TeX$ / $\Sigma$ mathematical symbol integrated with a sleek document/cloud motif in indigo/violet gradient).
   - Reference it as the browser `<link rel="icon" type="image/svg+xml" href="/icon.svg" />` in `index.html` and render it in the top-left brand header, replacing the generic placeholder icon.
2. **Simplify Brand Subtitle & Badges:**
   - Keep the title **OpenDriveTeX**.
   - Change the subtitle from `"Zero-Backend Collaborative LaTeX"` to simply **`"Collaborative LaTeX Editor"`** (remove `"Zero-Backend"` and remove the green `"P2P CRDT"` technical badge next to the logo).

---

## 3. Top Navigation Bar Decluttering
1. **Remove Raw Folder/Document ID Hash:**
   - In the top bar, display ONLY the clean project folder name (e.g., `Paper_1`). Completely remove the raw Drive ID hash (`# 1Z4khsBUAr29F20Nve...`) and its copy button, since sharing happens natively through Google Drive permissions.
2. **Remove Local Cache Badges:**
   - Remove the **`IndexedDB`** badge in the top bar and the **`CRDT Direct Binding (Y.Text)`** badge in the editor sub-header.
3. **Unify "Open from Drive" into a Single Button:**
   - Remove the separate `Browse Drive` and `Open .tex` buttons in the top bar.
   - Replace them with a single, clear **`Open from Drive`** button that opens a unified Google Picker (allowing the user to pick either a project folder OR a `.tex` file in one place) alongside a quick dropdown of recent projects.
4. **Remove `.tex` Export & Deduplicate PDF Download:**
   - Remove the `Export .tex | .pdf` button group from the top bar (since `.tex` files live directly in Google Drive).
   - Keep **only ONE** **`Download PDF`** button located exclusively in the **PDF Preview pane header** (on the right). Do not duplicate PDF export in both the top bar and the sidebar/preview pane.

---

## 4. Left Sidebar Cleanup & Unsaved Changes Protection
1. **Remove Duplicate Sync Button:**
   - Currently, there are two sync buttons right next to each other (`Sync` and `Sync / Refresh from Drive`). Keep **only ONE** clean icon/button (`Sync with Drive`) in the Project Files header.
2. **File & Folder Creation Actions in the Project Header:**
   - In the Project Files header toolbar, provide clear, intuitive buttons for:
     - **`+ New File`**: Prompts for any filename and extension (e.g., `section1.tex`, `references.bib`, `custom.sty`) and creates it in Drive and MEMFS.
     - **`+ New Folder`**: Creates a subfolder (e.g., `output_figures/`).
     - **`+ Upload`**: Uploads local files or authorizes existing Drive files via Picker.
3. **Remove "Collaborator Identity" Section:**
   - Completely remove the `COLLABORATOR IDENTITY` card (with the numeric `ID: ...`, avatar, and email) from the left sidebar, as active collaborators are already shown in the top bar peer pills.
4. **Minimalist Google Drive Status Section & Auto-Save Countdown:**
   - Replace the crowded `GOOGLE DRIVE WORKSPACE` section and the technical `Elected Save Leader` / `Main .tex ID` / `Add New .tex in Folder` boxes at the bottom of the sidebar with a single, clean **Drive Sync Status** footer card showing ONLY:
     - **Last saved time** (e.g., `Last saved: 14:32:10`).
     - **Live Auto-Save Countdown Timer** when there are unsaved modifications (e.g., `Auto-saving in 18s...` with a subtle progress bar or spinner, or `All changes saved to Drive`).
     - **`Sign Out`** button.
   - Completely hide technical internals (`Elected Save Leader`, `Lowest authenticated clientID`, `Main .tex ID`, `GIS Connected` badge).
5. **Accidental Tab Close Protection (`beforeunload` Warning for Last Peer / Unsaved Changes):**
   - Track a boolean `isDirty` (true whenever the Yjs document has changes that have not yet been written to Google Drive via `PATCH`).
   - Add a `window.addEventListener('beforeunload', ...)` handler: if there are unsaved changes (`isDirty === true`), OR especially if the current user is the last connected peer (`peersCount <= 1`) with pending changes not yet saved to Drive, trigger the browser's native confirmation dialog (`e.preventDefault(); e.returnValue = '';`) AND immediately attempt to trigger a Drive save so the user does not accidentally lose work by closing the tab.

---

## 5. New Feature 1: Resizable Split Pane & Toggleable PDF Preview
1. **Draggable Vertical Splitter:**
   - Add an interactive vertical resize handle (`cursor: col-resize`) between the center Editor pane and the right PDF Preview pane.
   - Allow the user to smoothly drag the divider left or right with the mouse to customize the width ratio (e.g., from `20% / 80%` to `80% / 20%`), persisting their preferred ratio in `localStorage`.
2. **Hide / Show PDF Pane Toggle:**
   - Add a **`Hide PDF` / `Show PDF`** toggle button (with an eye or split-panel icon) in the top bar / pane header.
   - When hidden, the PDF pane collapses completely (`0%` width) and the $\LaTeX$ editor expands to `100%` of the workspace width for distraction-free writing.

---

## 6. New Feature 2: Overleaf-Style "Visual Editor" Mode (Local per User)
Implement a local view toggle in the Editor header allowing each user to switch seamlessly between **`Code Editor`** (raw $\LaTeX$) and **`Visual Editor`** (Overleaf-style WYSIWYM / Rich Text mode) without affecting other connected peers:
1. **How Visual Editor Works (CodeMirror 6 Decorations + KaTeX):**
   - Use CodeMirror 6 `ViewPlugin` and `Decoration.replace` / `Decoration.mark` (plus `katex` for live math rendering) on top of the existing `Y.Text`-bound CodeMirror 6 instance (so real-time Yjs collaboration and cursor syncing continue to work identically underneath!):
   - **Cursor-Aware Unfolding:** For any line or token where the user's cursor/selection is NOT currently placed:
     - **Inline & Display Math (`$...$`, `$$...$$`, `\begin{equation}...\end{equation}`):** Render the compiled mathematical formula inline using **KaTeX** widgets. Clicking the rendered equation places the cursor inside it and reveals the raw $\LaTeX$ math source for editing.
     - **Section Headings (`\title{...}`, `\section{...}`, `\subsection{...}`, `\subsubsection{...}`):** Hide the `\section{` and `}` syntax and style the heading text with large, bold typography (`H1`, `H2`, `H3`).
     - **Text Formatting (`\textbf{...}`, `\textit{...}`, `\emph{...}`, `\underline{...}`):** Hide the command wrapper and render the inner text directly in **bold**, *italic*, or <u>underline</u>.
     - **Citations & Lists (`\cite{...}`, `\item`):** Render `\item` as clean bullet points (`•`) and `\cite{key}` as compact, styled citation pills `[key]`.
     - **Preamble Collapsing:** Automatically fold/collapse the `\documentclass...\begin{document}` preamble into a compact expandable banner (`"Document Preamble (Click to expand)"`) so the author focuses directly on the manuscript body.

---

## 7. New Feature 3: Light / Dark Theme Switcher
1. **Default Dark Theme + New Light Theme:**
   - Keep the current dark theme as the default (`dark` mode).
   - Create a clean, high-contrast academic **Light Theme** (`light` mode: warm white/slate-50 backgrounds, crisp dark text, subtle slate borders, and a CodeMirror 6 light syntax theme).
2. **Sidebar Theme Toggle Button:**
   - Add a clear **`Light Mode` / `Dark Mode`** toggle button (Sun/Moon icon + label) in the left sidebar header or footer, storing the user's preference locally in `localStorage`.