import { InkOverlay } from '../common/ink-overlay';
import { InkSyncAction, SlideScrollAction, SlideDomSyncAction, SlideInteractionAction } from '../types/ink';

declare global {
  interface Window {
    presenterAPI: {
      onSyncState: (callback: (state: any) => void) => () => void;
      navigateSlide: (index: number) => void;
      nextSlide: () => void;
      prevSlide: () => void;
      onInkAction: (callback: (action: InkSyncAction) => void) => () => void;
      sendInkAction: (action: InkSyncAction) => void;
      sendInteraction: (action: SlideInteractionAction) => void;
      onInteraction: (callback: (action: SlideInteractionAction) => void) => () => void;
      sendSlideScroll: (action: SlideScrollAction) => void;
      onSlideScroll: (callback: (action: SlideScrollAction) => void) => () => void;
      sendSlideDom: (action: SlideDomSyncAction) => void;
      onSlideDomSync: (callback: (action: SlideDomSyncAction) => void) => () => void;
      onSlideFrame: (callback: (frame: { slideIndex: number; data: string }) => void) => () => void;
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
const currentMirrorEl = document.getElementById('current-mirror') as HTMLImageElement;
const liveAudienceSyncBadge = document.getElementById('live-audience-sync-badge');
const btnToggleMirror = document.getElementById('btn-toggle-mirror');
let isMirrorEnabled = true;
let lastMirroredFrame: string | null = null;

if (btnToggleMirror) {
  btnToggleMirror.addEventListener('click', () => {
    isMirrorEnabled = !isMirrorEnabled;
    btnToggleMirror.classList.toggle('active', isMirrorEnabled);
    if (currentMirrorEl) {
      currentMirrorEl.style.display = isMirrorEnabled && lastMirroredFrame ? 'block' : 'none';
    }
  });
}

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
      lastMirroredFrame = null;
      if (currentMirrorEl) currentMirrorEl.style.display = 'none';
      currentFrameEl.onload = () => {
        const doc = currentFrameEl.contentDocument;
        if (doc) {
          setupPresenterInteractionBridge(currentFrameEl, doc);
        }
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
      const doc = currentFrameEl.contentDocument;
      if (doc) {
        setupPresenterInteractionBridge(currentFrameEl, doc);
      }
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
function updateAdbUi(data: any) {
  const devices: any[] = Array.isArray(data) ? data : (data?.devices || []);
  const isInstalled = data?.installed !== undefined ? data.installed : true;
  const activeDevice = devices?.find((d: any) => d.state === 'device');
  const unauthDevice = devices?.find((d: any) => d.state === 'unauthorized');
  const offlineDevice = devices?.find((d: any) => d.state === 'offline');

  if (activeDevice) {
    adbDotEl.className = 'adb-dot connected';
    adbLabelEl.textContent = `${activeDevice.isBoox ? 'Boox' : 'Tablet'}: ${activeDevice.model || 'Connected'}`;
    btnAdbLaunch.disabled = false;
    btnAdbLaunch.textContent = 'Open on Boox';
    btnAdbLaunch.title = `Connected to ${activeDevice.model}. Click to launch companion view.`;
  } else if (unauthDevice) {
    adbDotEl.className = 'adb-dot unauthorized';
    adbLabelEl.textContent = `Boox: Unauthorized`;
    btnAdbLaunch.disabled = true;
    btnAdbLaunch.textContent = 'Allow on Tablet';
    btnAdbLaunch.title = `Tablet detected (${unauthDevice.model}). Please unlock tablet screen and tap "Allow USB debugging".`;
  } else if (offlineDevice) {
    adbDotEl.className = 'adb-dot unauthorized';
    adbLabelEl.textContent = `Boox: Offline`;
    btnAdbLaunch.disabled = true;
    btnAdbLaunch.textContent = 'Offline';
    btnAdbLaunch.title = `Tablet is offline. Reconnect USB cable or wake tablet screen.`;
  } else if (!isInstalled) {
    adbDotEl.className = 'adb-dot not-installed';
    adbLabelEl.textContent = `ADB: Not Installed`;
    btnAdbLaunch.disabled = true;
    btnAdbLaunch.textContent = 'Install ADB';
    btnAdbLaunch.title = `Android Debug Bridge (adb) was not found. Install via Homebrew: brew install android-platform-tools`;
  } else {
    adbDotEl.className = 'adb-dot disconnected';
    adbLabelEl.textContent = 'Boox: Disconnected';
    btnAdbLaunch.disabled = true;
    btnAdbLaunch.textContent = 'Open on Boox';
    btnAdbLaunch.title = 'No Android tablet connected via USB. Ensure USB Debugging is enabled on your Boox.';
  }
}

window.presenterAPI.getAdbStatus().then((status) => {
  updateAdbUi(status);
}).catch(() => {});

window.presenterAPI.onAdbDevicesChanged((devices) => {
  window.presenterAPI.getAdbStatus().then((status) => {
    updateAdbUi(status || devices);
  }).catch(() => {
    updateAdbUi(devices);
  });
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

// --- Two-Way Presenter & Presentation Synchronization ---

function getElementSelector(el: HTMLElement, rootDoc: Document): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el === rootDoc.body) return 'body';
  if (el === rootDoc.documentElement) return ':root';

  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).filter(Boolean);
    if (classes.length > 0) {
      const clsSel = `${el.tagName.toLowerCase()}.${classes.map(c => CSS.escape(c)).join('.')}`;
      try {
        if (rootDoc.querySelectorAll(clsSel).length === 1) return clsSel;
      } catch (_) {}
    }
  }

  const path: string[] = [];
  let curr: HTMLElement | null = el;
  while (curr && curr !== rootDoc.body && curr !== rootDoc.documentElement) {
    if (curr.id) {
      path.unshift(`#${CSS.escape(curr.id)}`);
      break;
    }
    let piece = curr.tagName.toLowerCase();
    if (curr.parentElement) {
      const siblings = Array.from(curr.parentElement.children).filter(c => c.tagName === curr!.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(curr) + 1;
        piece += `:nth-of-type(${idx})`;
      }
    }
    path.unshift(piece);
    curr = curr.parentElement;
  }
  return path.join(' > ') || 'body';
}

function setupPresenterKeyDownBridge(iframeDoc: Document): void {
  iframeDoc.addEventListener('keydown', (e: KeyboardEvent) => {
    const activeEl = iframeDoc.activeElement as HTMLElement;
    const isEditing = activeEl && (activeEl.isContentEditable || activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');

    if (isEditing) {
      if (e.key === 'Escape') activeEl.blur();
      return;
    }

    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      window.presenterAPI.nextSlide();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      window.presenterAPI.prevSlide();
    }
  });
}

function setupPresenterInteractionBridge(frame: HTMLIFrameElement, doc: Document): void {
  if (!doc || (doc as any).__presenterSyncAttached) return;
  (doc as any).__presenterSyncAttached = true;

  const slideIndex = currentState?.currentIndex ?? 0;

  setupPresenterKeyDownBridge(doc);

  // 1. Click Interaction Forwarding
  doc.addEventListener('click', (e: MouseEvent) => {
    if ((e as any).__isRemoteSync) return;
    const target = e.target as HTMLElement;
    if (!target) return;

    const selector = getElementSelector(target, doc);
    const rect = doc.documentElement?.getBoundingClientRect();
    const normX = rect && rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    const normY = rect && rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;

    window.presenterAPI.sendInteraction({
      type: 'slide:interaction',
      slideIndex: currentState?.currentIndex ?? slideIndex,
      actionType: 'click',
      selector,
      normX,
      normY
    });
  }, { capture: true, passive: true });

  // 2. Throttled Scroll Forwarding
  let scrollThrottle: any = null;
  const emitScroll = (target: any) => {
    if (!target) return;
    if (scrollThrottle) return;
    scrollThrottle = setTimeout(() => {
      scrollThrottle = null;
    }, 25);

    const isDocOrWin = target === doc || target === doc.defaultView || target === doc.documentElement || target === doc.body;
    let selector = 'window';
    let scrollTop = 0;
    let scrollLeft = 0;
    let ratioX = 0;
    let ratioY = 0;

    if (isDocOrWin) {
      const win = doc.defaultView || window;
      scrollTop = win.scrollY || doc.documentElement.scrollTop || doc.body?.scrollTop || 0;
      scrollLeft = win.scrollX || doc.documentElement.scrollLeft || doc.body?.scrollLeft || 0;
      const maxScrollX = Math.max(0, doc.documentElement.scrollWidth - win.innerWidth);
      const maxScrollY = Math.max(0, doc.documentElement.scrollHeight - win.innerHeight);
      ratioX = maxScrollX > 0 ? scrollLeft / maxScrollX : 0;
      ratioY = maxScrollY > 0 ? scrollTop / maxScrollY : 0;
    } else if (target instanceof HTMLElement) {
      selector = getElementSelector(target, doc);
      scrollTop = target.scrollTop;
      scrollLeft = target.scrollLeft;
      const maxScrollX = Math.max(0, target.scrollWidth - target.clientWidth);
      const maxScrollY = Math.max(0, target.scrollHeight - target.clientHeight);
      ratioX = maxScrollX > 0 ? scrollLeft / maxScrollX : 0;
      ratioY = maxScrollY > 0 ? scrollTop / maxScrollY : 0;
    } else {
      return;
    }

    window.presenterAPI.sendSlideScroll({
      type: 'slide:scroll',
      slideIndex: currentState?.currentIndex ?? slideIndex,
      selector,
      scrollTop,
      scrollLeft,
      ratioX,
      ratioY
    });
  };

  doc.addEventListener('scroll', (e) => emitScroll(e.target), { capture: true, passive: true });
  if (doc.defaultView) {
    doc.defaultView.addEventListener('scroll', (e) => emitScroll(e.target), { passive: true });
  }

  // Nested frame scrolling (e.g. #web-frame inside web slides)
  const attachNested = () => {
    doc.querySelectorAll('iframe').forEach(nested => {
      const setupNested = () => {
        try {
          const nDoc = nested.contentDocument;
          const nWin = nested.contentWindow;
          if (nDoc && !(nDoc as any).__presenterNestedAttached) {
            (nDoc as any).__presenterNestedAttached = true;
            const emitNested = () => {
              const win = nWin || nDoc.defaultView;
              const scrollTop = win?.scrollY || nDoc.documentElement?.scrollTop || 0;
              const scrollLeft = win?.scrollX || nDoc.documentElement?.scrollLeft || 0;
              const maxScrollX = Math.max(0, nDoc.documentElement.scrollWidth - (win?.innerWidth || 0));
              const maxScrollY = Math.max(0, nDoc.documentElement.scrollHeight - (win?.innerHeight || 0));
              window.presenterAPI.sendSlideScroll({
                type: 'slide:scroll',
                slideIndex: currentState?.currentIndex ?? slideIndex,
                selector: nested.id ? `#${CSS.escape(nested.id)}` : 'iframe',
                scrollTop,
                scrollLeft,
                ratioX: maxScrollX > 0 ? scrollLeft / maxScrollX : 0,
                ratioY: maxScrollY > 0 ? scrollTop / maxScrollY : 0,
              });
            };
            nDoc.addEventListener('scroll', emitNested, { capture: true, passive: true });
            if (nWin) nWin.addEventListener('scroll', emitNested, { passive: true });
          }
        } catch (_) {}
      };
      setupNested();
      nested.addEventListener('load', setupNested);
    });
  };
  attachNested();

  // 3. Form Input Forwarding
  const handleInput = (e: Event) => {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
      const inputEl = target as HTMLInputElement;
      const selector = getElementSelector(inputEl, doc);
      window.presenterAPI.sendSlideDom({
        type: 'slide:dom-sync',
        slideIndex: currentState?.currentIndex ?? slideIndex,
        inputs: [{
          selector,
          value: inputEl.value,
          checked: inputEl.type === 'checkbox' || inputEl.type === 'radio' ? inputEl.checked : undefined
        }]
      });
    }
  };
  doc.addEventListener('input', handleInput, { capture: true });
  doc.addEventListener('change', handleInput, { capture: true });

  // 4. Media Events Forwarding
  const handleMedia = (e: Event) => {
    const target = e.target;
    if (target instanceof HTMLMediaElement) {
      const selector = getElementSelector(target, doc);
      window.presenterAPI.sendSlideDom({
        type: 'slide:dom-sync',
        slideIndex: currentState?.currentIndex ?? slideIndex,
        media: [{
          selector,
          currentTime: target.currentTime,
          paused: target.paused
        }]
      });
    }
  };
  doc.addEventListener('play', handleMedia, { capture: true });
  doc.addEventListener('pause', handleMedia, { capture: true });
  doc.addEventListener('seeked', handleMedia, { capture: true });
}

function applyScrollToCurrent(action: SlideScrollAction): void {
  try {
    const doc = currentFrameEl.contentDocument;
    const win = currentFrameEl.contentWindow as any;
    if (!doc) return;

    if (action.selector === '#web-frame' || action.selector === 'iframe') {
      const nestedFrame = doc.querySelector(action.selector) as HTMLIFrameElement;
      if (nestedFrame) {
        try {
          const nestedWin = nestedFrame.contentWindow;
          const nestedDoc = nestedFrame.contentDocument;
          if (nestedWin) {
            nestedWin.scrollTo({ left: action.scrollLeft, top: action.scrollTop, behavior: 'instant' as any });
          }
          if (nestedDoc) {
            nestedDoc.documentElement.scrollTop = action.scrollTop;
            nestedDoc.documentElement.scrollLeft = action.scrollLeft;
            if (nestedDoc.body) {
              nestedDoc.body.scrollTop = action.scrollTop;
              nestedDoc.body.scrollLeft = action.scrollLeft;
            }
          }
          return;
        } catch (_) {
          const scaler = doc.getElementById('web-frame-scaler');
          if (scaler) scaler.style.transform = `translateY(-${action.scrollTop}px)`;
          return;
        }
      }
    }

    if (action.selector && action.selector !== 'window' && action.selector !== ':root' && action.selector !== 'body') {
      let targetEl = doc.querySelector(action.selector) as HTMLElement;
      if (!targetEl && action.selector === '#web-viewport') {
        targetEl = doc.getElementById('web-viewport')!;
      }
      if (targetEl) {
        const maxScrollY = targetEl.scrollHeight - targetEl.clientHeight;
        const maxScrollX = targetEl.scrollWidth - targetEl.clientWidth;
        targetEl.scrollTop = action.ratioY !== undefined && maxScrollY > 0 ? action.ratioY * maxScrollY : action.scrollTop;
        targetEl.scrollLeft = action.ratioX !== undefined && maxScrollX > 0 ? action.ratioX * maxScrollX : action.scrollLeft;
        return;
      }
    }

    if (win) {
      win.scrollTo({ left: action.scrollLeft, top: action.scrollTop, behavior: 'instant' as any });
    }
    if (doc.documentElement) {
      doc.documentElement.scrollTop = action.scrollTop;
      doc.documentElement.scrollLeft = action.scrollLeft;
    }
    if (doc.body) {
      doc.body.scrollTop = action.scrollTop;
      doc.body.scrollLeft = action.scrollLeft;
    }
  } catch (_) {}
}

function applyDomSyncToCurrent(action: SlideDomSyncAction): void {
  try {
    const doc = currentFrameEl.contentDocument;
    const win = currentFrameEl.contentWindow as any;
    if (!doc) return;

    if (typeof action.bodyClass === 'string' && doc.body) {
      if (doc.body.className !== action.bodyClass) {
        doc.body.className = action.bodyClass;
        if (typeof win?.setFitMode === 'function') {
          win.setFitMode(!action.bodyClass.includes('mode-scroll'));
        }
        win?.dispatchEvent?.(new Event('resize'));
      }
    }

    if (typeof action.animStep === 'number') {
      if (typeof win?.goToAnimStep === 'function') {
        win.goToAnimStep(action.animStep, false);
      }
    }

    if (action.attributes && action.attributes.length > 0) {
      for (const attr of action.attributes) {
        const el = doc.querySelector(attr.selector) as HTMLElement;
        if (el) {
          if (attr.value === null) el.removeAttribute(attr.name);
          else el.setAttribute(attr.name, attr.value);
        }
      }
    }

    if (action.inputs && action.inputs.length > 0) {
      for (const inp of action.inputs) {
        const el = doc.querySelector(inp.selector) as HTMLInputElement;
        if (el) {
          if (inp.value !== undefined) el.value = inp.value;
          if (inp.checked !== undefined) el.checked = inp.checked;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }

    if (action.media && action.media.length > 0) {
      for (const m of action.media) {
        const el = doc.querySelector(m.selector) as HTMLMediaElement;
        if (el) {
          if (Math.abs(el.currentTime - m.currentTime) > 0.5) el.currentTime = m.currentTime;
          if (m.paused && !el.paused) el.pause();
          else if (!m.paused && el.paused) el.play().catch(() => {});
        }
      }
    }
  } catch (_) {}
}

function applyInteractionToCurrent(action: SlideInteractionAction): void {
  try {
    const doc = currentFrameEl.contentDocument;
    const win = currentFrameEl.contentWindow as any;
    if (!doc) return;

    if (action.actionType === 'step' && typeof action.step === 'number') {
      if (typeof win?.goToAnimStep === 'function') {
        win.goToAnimStep(action.step, true);
      }
      return;
    }

    if (action.actionType === 'click') {
      let el: HTMLElement | null = null;
      if (action.selector) {
        try {
          el = doc.querySelector(action.selector) as HTMLElement;
        } catch (_) {}
      }
      if (!el && typeof action.normX === 'number' && typeof action.normY === 'number') {
        const x = action.normX * (doc.documentElement?.clientWidth || 1920);
        const y = action.normY * (doc.documentElement?.clientHeight || 1080);
        el = doc.elementFromPoint(x, y) as HTMLElement;
      }

      if (el) {
        (el as any).__isRemoteSync = true;
        el.click();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: win }));
        setTimeout(() => { delete (el as any).__isRemoteSync; }, 100);
      }
    }
  } catch (_) {}
}

// Incoming sync listeners from main presentation
window.presenterAPI.onInteraction((action) => {
  if (currentState && action.slideIndex === currentState.currentIndex) {
    applyInteractionToCurrent(action);
  }
});

window.presenterAPI.onSlideScroll((action) => {
  if (currentState && action.slideIndex === currentState.currentIndex) {
    applyScrollToCurrent(action);
  }
});

window.presenterAPI.onSlideDomSync((action) => {
  if (currentState && action.slideIndex === currentState.currentIndex) {
    applyDomSyncToCurrent(action);
  }
});

window.presenterAPI.onSlideFrame((frame) => {
  if (frame && frame.data) {
    lastMirroredFrame = frame.data;
    if (isMirrorEnabled && currentMirrorEl) {
      currentMirrorEl.src = frame.data;
      currentMirrorEl.style.display = 'block';
    }
    if (liveAudienceSyncBadge) {
      liveAudienceSyncBadge.style.opacity = '1';
    }
  }
});

window.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'NEODECK_STEP_CHANGED') {
    window.presenterAPI.sendInteraction({
      type: 'slide:interaction',
      slideIndex: currentState?.currentIndex ?? 0,
      actionType: 'step',
      step: event.data.currentStep
    });
  }
});
