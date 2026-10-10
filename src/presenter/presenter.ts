import { InkOverlay } from '../common/ink-overlay';
import { InkSyncAction } from '../types/ink';

declare global {
  interface Window {
    presenterAPI: {
      onSyncState: (callback: (state: any) => void) => () => void;
      navigateSlide: (index: number) => void;
      nextSlide: () => void;
      prevSlide: () => void;
      onInkAction: (callback: (action: InkSyncAction) => void) => () => void;
      sendInkAction: (action: InkSyncAction) => void;
      getAdbStatus: () => Promise<any>;
      launchTabletBrowser: () => Promise<{ success: boolean; error?: string }>;
      onAdbDevicesChanged: (callback: (devices: any[]) => void) => () => void;
    };
  }
}

export {};

let currentState: any = null;
let timerSeconds = 0;
let timerRunning = true;
let timerInterval: any = null;
let notesFontSize = 1.1; // rem

// DOM Elements
const deckTitleEl = document.getElementById('p-deck-title')!;
const slideCounterEl = document.getElementById('p-slide-counter')!;
const timerDisplayEl = document.getElementById('timer-display')!;
const clockDisplayEl = document.getElementById('clock-display')!;
const btnTimerPause = document.getElementById('btn-timer-pause')!;
const btnTimerReset = document.getElementById('btn-timer-reset')!;

const currentSlideNameEl = document.getElementById('current-slide-name')!;
const currentViewportEl = document.getElementById('current-viewport')!;
const currentScalerEl = document.getElementById('current-scaler')!;
const currentFrameEl = document.getElementById('current-frame') as HTMLIFrameElement;

const nextSlideNameEl = document.getElementById('next-slide-name')!;
const nextViewportEl = document.getElementById('next-viewport')!;
const nextScalerEl = document.getElementById('next-scaler')!;
const nextFrameEl = document.getElementById('next-frame') as HTMLIFrameElement;

const notesContentEl = document.getElementById('p-notes-content')!;
const btnNotesSmaller = document.getElementById('btn-notes-smaller')!;
const btnNotesLarger = document.getElementById('btn-notes-larger')!;

const btnPrev = document.getElementById('btn-p-prev')!;
const btnNext = document.getElementById('btn-p-next')!;
const slideStripEl = document.getElementById('slide-strip')!;

// ADB Elements
const adbDotEl = document.getElementById('adb-dot')!;
const adbLabelEl = document.getElementById('adb-label')!;
const btnAdbLaunch = document.getElementById('btn-adb-launch') as HTMLButtonElement;

// Ink Elements
const btnInkUndo = document.getElementById('btn-p-ink-undo');
const btnInkClear = document.getElementById('btn-p-ink-clear');

// Setup Ink Overlay on current slide preview
const inkOverlay = new InkOverlay({
  container: currentScalerEl,
  isInteractive: false,
});

// Wall Clock
function updateClock() {
  const now = new Date();
  clockDisplayEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// Elapsed Timer
function formatTime(totalSeconds: number): string {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (timerRunning) {
      timerSeconds++;
      timerDisplayEl.textContent = formatTime(timerSeconds);
    }
  }, 1000);
}
startTimer();

btnTimerPause.addEventListener('click', () => {
  timerRunning = !timerRunning;
  btnTimerPause.textContent = timerRunning ? '⏸' : '▶';
});

btnTimerReset.addEventListener('click', () => {
  timerSeconds = 0;
  timerDisplayEl.textContent = formatTime(0);
});

// Viewport Scaling helper
function setupScaler(viewport: HTMLElement, scaler: HTMLElement) {
  const resize = () => {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (vw <= 0 || vh <= 0) return;
    const baseW = 1920;
    const baseH = 1080;
    const scale = Math.min(vw / baseW, vh / baseH) * 0.96;
    scaler.style.transform = `scale(${scale})`;
    scaler.style.left = `${(vw - baseW) / 2}px`;
    scaler.style.top = `${(vh - baseH) / 2}px`;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(viewport);
  resize();
}

setupScaler(currentViewportEl, currentScalerEl);
setupScaler(nextViewportEl, nextScalerEl);

// Notes Font Size
btnNotesSmaller.addEventListener('click', () => {
  if (notesFontSize > 0.8) {
    notesFontSize -= 0.1;
    notesContentEl.style.fontSize = `${notesFontSize}rem`;
  }
});

btnNotesLarger.addEventListener('click', () => {
  if (notesFontSize < 2.5) {
    notesFontSize += 0.1;
    notesContentEl.style.fontSize = `${notesFontSize}rem`;
  }
});

// Navigation actions
btnPrev.addEventListener('click', () => window.presenterAPI.prevSlide());
btnNext.addEventListener('click', () => window.presenterAPI.nextSlide());

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
    e.preventDefault();
    window.presenterAPI.nextSlide();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault();
    window.presenterAPI.prevSlide();
  }
});

// State Sync from Main
window.presenterAPI.onSyncState((state) => {
  currentState = state;
  renderState(state);
});

function renderState(state: any) {
  if (!state || !state.manifest) return;

  const { manifest, currentIndex, totalSlides, currentAnimStep, totalAnimSteps } = state;
  deckTitleEl.textContent = manifest.title || 'Untitled Presentation';
  if (totalAnimSteps && totalAnimSteps > 0) {
    slideCounterEl.textContent = `Slide ${currentIndex + 1} of ${totalSlides} (Step ${currentAnimStep || 0}/${totalAnimSteps})`;
  } else {
    slideCounterEl.textContent = `Slide ${currentIndex + 1} of ${totalSlides}`;
  }

  const currentSlide = manifest.slides[currentIndex];
  // Next Slide: find next non-hidden slide
  let nextSlide: any = null;
  let nextSlideIndex = -1;
  for (let i = currentIndex + 1; i < manifest.slides.length; i++) {
    if (!manifest.slides[i].hidden) {
      nextSlide = manifest.slides[i];
      nextSlideIndex = i;
      break;
    }
  }

  // Current Slide
  if (currentSlide) {
    const hiddenTag = currentSlide.hidden ? ' (Hidden)' : '';
    currentSlideNameEl.textContent = (currentSlide.title || `Slide ${currentIndex + 1}`) + hiddenTag;
    const curUrl = `neopres://deck/${currentSlide.path}?view=presenter_cur`;
    if (currentFrameEl.src !== curUrl) {
      currentFrameEl.src = curUrl;
      currentFrameEl.onload = () => {
        try {
          if (typeof currentAnimStep === 'number') {
            currentFrameEl.contentWindow?.postMessage({
              type: 'NEODECK_SET_STEP',
              step: currentAnimStep,
              animate: false
            }, '*');
          }
        } catch (_) {}
      };
    } else {
      try {
        if (typeof currentAnimStep === 'number') {
          currentFrameEl.contentWindow?.postMessage({
            type: 'NEODECK_SET_STEP',
            step: currentAnimStep,
            animate: true
          }, '*');
        }
      } catch (_) {}
    }
    // Speaker Notes
    if (currentSlide.notes && currentSlide.notes.trim()) {
      const notes = currentSlide.notes.trim();
      notesContentEl.innerHTML = (notes.startsWith('<') || notes.includes('</'))
        ? notes
        : notes.replace(/\n/g, '<br/>');
    } else {
      notesContentEl.innerHTML = '<p class="notes-placeholder">No speaker notes for this slide.</p>';
    }

    // Set active slide index for ink overlay
    inkOverlay.setSlideIndex(currentIndex);
  }

  // Next Slide
  if (nextSlide) {
    nextSlideNameEl.textContent = nextSlide.title || `Slide ${nextSlideIndex + 1}`;
    const nextUrl = `neopres://deck/${nextSlide.path}?view=presenter_next`;
    if (nextFrameEl.src !== nextUrl) {
      nextFrameEl.src = nextUrl;
      nextFrameEl.onload = () => {
        try {
          nextFrameEl.contentDocument?.body.classList.add('show-all-anims');
        } catch (_) {}
      };
    }
  } else {
    nextSlideNameEl.textContent = 'End of Presentation';
    nextFrameEl.src = 'about:blank';
  }

  // Slide Strip
  slideStripEl.innerHTML = '';
  manifest.slides.forEach((s: any, idx: number) => {
    const item = document.createElement('div');
    item.className = `strip-item ${idx === currentIndex ? 'active' : ''} ${s.hidden ? 'is-hidden' : ''}`;
    item.textContent = `${idx + 1}. ${s.title || 'Slide'}${s.hidden ? ' ⊘' : ''}`;
    item.title = s.hidden ? 'Hidden Slide' : (s.title || '');
    item.addEventListener('click', () => {
      window.presenterAPI.navigateSlide(idx);
    });
    slideStripEl.appendChild(item);
  });
}

// Inking Actions
btnInkUndo?.addEventListener('click', () => {
  if (currentState && typeof currentState.currentIndex === 'number') {
    window.presenterAPI.sendInkAction({
      type: 'ink:undo',
      slideIndex: currentState.currentIndex
    });
  }
});

btnInkClear?.addEventListener('click', () => {
  if (currentState && typeof currentState.currentIndex === 'number') {
    window.presenterAPI.sendInkAction({
      type: 'ink:clear',
      slideIndex: currentState.currentIndex
    });
  }
});

window.presenterAPI.onInkAction((action: InkSyncAction) => {
  switch (action.type) {
    case 'ink:sync-slide':
      if (currentState && action.slideIndex === currentState.currentIndex) {
        inkOverlay.setSlideIndex(action.slideIndex, action.strokes);
      }
      break;
    case 'ink:stroke-start':
      if (currentState && action.stroke.slideIndex === currentState.currentIndex) {
        inkOverlay.startStroke(action.stroke);
      }
      break;
    case 'ink:stroke-update':
      inkOverlay.updateStroke(action.id, action.points);
      break;
    case 'ink:stroke-end':
      inkOverlay.endStroke(action.id);
      break;
    case 'ink:undo':
      if (currentState && action.slideIndex === currentState.currentIndex) {
        inkOverlay.undo();
      }
      break;
    case 'ink:clear':
      if (currentState && action.slideIndex === currentState.currentIndex) {
        inkOverlay.clear();
      }
      break;
  }
});

// ADB Status Handling
function updateAdbUi(devices: any[]) {
  const activeDevice = devices?.find((d: any) => d.state === 'device');
  if (activeDevice) {
    adbDotEl.className = 'adb-dot connected';
    adbLabelEl.textContent = `Boox: ${activeDevice.model || 'Connected'}`;
    btnAdbLaunch.disabled = false;
  } else {
    adbDotEl.className = 'adb-dot disconnected';
    adbLabelEl.textContent = 'Boox: Disconnected';
    btnAdbLaunch.disabled = true;
  }
}

window.presenterAPI.getAdbStatus().then((status) => {
  updateAdbUi(status?.devices || []);
}).catch(() => {});

window.presenterAPI.onAdbDevicesChanged((devices) => {
  updateAdbUi(devices);
});

btnAdbLaunch.addEventListener('click', async () => {
  btnAdbLaunch.textContent = 'Launching...';
  const res = await window.presenterAPI.launchTabletBrowser();
  if (res.success) {
    btnAdbLaunch.textContent = 'Launched! ✓';
    setTimeout(() => { btnAdbLaunch.textContent = 'Open on Boox'; }, 2500);
  } else {
    btnAdbLaunch.textContent = 'Launch Failed';
    setTimeout(() => { btnAdbLaunch.textContent = 'Open on Boox'; }, 2500);
  }
});
