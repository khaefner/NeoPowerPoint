# NeoPowerPoint 📽️⚡

> A cross-platform, PowerPoint-style presentation app that renders full HTML/CSS/JavaScript pages as interactive slides.

NeoPowerPoint lets you create presentations using standard web technologies. Because slides run on Chromium via Electron, every slide is an isolated, real web environment supporting **100% full JavaScript execution**, Canvas graphics, 3D WebGL, CSS animations, WebSockets, and third-party libraries (e.g. Three.js, Chart.js, D3.js).

---

## ✨ Features

- **Full JavaScript Execution**: Each slide runs standard JavaScript, handles DOM events, clicks, mouse tracking, and asynchronous tasks.
- **Cross-Platform**: Runs with identical Chromium rendering on **macOS**, **Linux**, and **Windows**.
- **Dual Presentation Format**:
  - **Project Directory**: Simple folder containing `deck.json` and slide HTML files for easy editing and version control with Git.
  - **Single Portable Archive (`.neopres`)**: Export or import complete presentation packages as single ZIP files to easily move decks between computers.
- **Windowed Presentation Mode**: Fills the current window cleanly without OS menu bars or borders — ideal for screen-sharing in Zoom, Google Meet, or Microsoft Teams.
- **Fullscreen Presentation Mode**: Distraction-free presentation on your projector or main display (`F11` or `F`).
- **Multi-Monitor Presenter View**: Separate synchronized presenter console featuring:
  - Live preview of the current slide
  - Preview of the upcoming next slide
  - Elapsed stopwatch timer with Pause & Reset
  - Real wall clock
  - Speaker notes with adjustable font size
  - Quick-jump slide thumbnail strip
- **Slide Overview Grid**: Bird's-eye thumbnail matrix (`O` or `Esc`) to jump directly to any slide during Q&A.
- **Live File Watcher**: Edits to HTML, CSS, or JS files in your favorite editor (e.g., VS Code) immediately hot-reload the current slide without resetting presentation state.

---

## 🚀 Quick Start

### Prerequisites
- Node.js (v18+) & npm

### Development
```bash
# Clone and enter the repository
git clone https://github.com/khaefner/NeoPowerPoint.git
cd NeoPowerPoint

# Install dependencies
npm install

# Run the app
npm start
```

When the app opens, click **"🚀 Load Interactive Demo"** to see live Canvas physics, animated data visualizers, and algorithmic sorting slides in action!

---

## 📁 Presentation Structure

A presentation project is simply a folder with a `deck.json` manifest:

```text
my-presentation/
├── deck.json                 # Presentation manifest
├── assets/                   # Shared images, fonts, styles, or libraries
│   ├── logo.svg
│   └── shared.css
└── slides/
    ├── 01-welcome/
    │   └── index.html
    ├── 02-interactive-chart/
    │   ├── index.html
    │   └── chart.js
    └── 03-conclusion/
        └── index.html
```

### Manifest Format (`deck.json`)

```json
{
  "version": "1.0.0",
  "title": "My Interactive Talk",
  "aspectRatio": "16:9",
  "customWidth": 1920,
  "customHeight": 1080,
  "theme": "dark",
  "slides": [
    {
      "id": "slide-1",
      "title": "Welcome",
      "path": "slides/01-welcome/index.html",
      "notes": "Introduce myself and explain the agenda."
    },
    {
      "id": "slide-2",
      "title": "Interactive Demo",
      "path": "slides/02-interactive-chart/index.html",
      "notes": "Click on the cloud subscription metric to demonstrate."
    }
  ]
}
```

> **Tip:** You can also point NeoPowerPoint at **any folder with HTML files** and it will automatically generate a `deck.json` for you!

---

## 🕹️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `→` / `Space` / `PageDown` | Next slide |
| `←` / `Backspace` / `PageUp` | Previous slide |
| `Home` / `End` | Jump to first / last slide |
| `W` | Toggle **Windowed Presentation Mode** (fills current window) |
| `F11` / `F` | Toggle **Fullscreen Mode** |
| `P` | Open **Presenter View** (speaker notes + timer + next slide preview) |
| `O` / `Esc` | Toggle **Slide Overview Grid** |
| `R` | Reload current slide (live refresh) |
| `S` | Toggle slide sidebar manager |
| `?` | Show keyboard shortcuts cheat sheet |

---

## 🔌 In-Slide JavaScript API

Slides can optionally communicate with the NeoPowerPoint container by posting messages:

```javascript
// Navigate to next slide from a button inside your slide
window.parent.postMessage({ type: 'NEODECK_NEXT' }, '*');

// Navigate to previous slide
window.parent.postMessage({ type: 'NEODECK_PREV' }, '*');

// Jump directly to slide index (0-based)
window.parent.postMessage({ type: 'NEODECK_GOTO', index: 3 }, '*');

// Toggle presentation mode
window.parent.postMessage({ type: 'NEODECK_TOGGLE_PRESENT' }, '*');
```

---

## 📦 Building Installers (Cross-Platform)

Packaged distribution executables can be built using `electron-builder`:

```bash
# Build for current OS
npm run dist

# Build Linux AppImage / tar.gz
npm run dist:linux

# Build macOS DMG / ZIP
npm run dist:mac

# Build Windows NSIS installer / portable exe
npm run dist:win
```

Installers and binaries will be written to the `release/` folder.