import { DeckManifest, SlideMetadata } from '../types/deck';
import { ElectronAPI } from '../preload/preload';

declare const window: Window & { electronAPI: ElectronAPI };

class PresentationApp {
  private deckPath: string | null = null;
  private manifest: DeckManifest | null = null;
  private currentIndex: number = 0;
  private isPresentationMode: boolean = false;
  private floatingControlsTimer: any = null;

  // DOM Elements
  private emptyStateEl = document.getElementById('empty-state')!;
  private slideWrapperEl = document.getElementById('slide-wrapper')!;
  private slideBoxEl = document.getElementById('slide-box')!;
  private slideFrameEl = document.getElementById('slide-frame') as HTMLIFrameElement;
  private stageEl = document.getElementById('viewport-stage')!;
  private sidebarEl = document.getElementById('sidebar-slides')!;
  private slidesListEl = document.getElementById('slides-list')!;
  private deckTitleEl = document.getElementById('deck-title')!;
  private slideCounterEl = document.getElementById('slide-counter')!;
  private notesEditorEl = document.getElementById('slide-notes-editor') as HTMLTextAreaElement;
  private liveBadgeEl = document.getElementById('live-badge')!;

  // Floating controls
  private floatingControlsEl = document.getElementById('floating-controls')!;
  private floatCounterEl = document.getElementById('float-counter')!;
  private floatPrevBtn = document.getElementById('float-prev')!;
  private floatNextBtn = document.getElementById('float-next')!;
  private floatExitBtn = document.getElementById('float-exit')!;

  // Modals & Menus
  private dropdownMenuEl = document.getElementById('dropdown-menu')!;
  private overviewModalEl = document.getElementById('overview-modal')!;
  private overviewGridEl = document.getElementById('overview-grid')!;
  private shortcutsModalEl = document.getElementById('shortcuts-modal')!;

  constructor() {
    this.setupEventListeners();
    this.setupScaler();
    this.setupIPCListeners();
    this.setupIframeMessageBridge();
  }

  private setupEventListeners(): void {
    // Toolbar buttons
    document.getElementById('btn-prev-slide')!.addEventListener('click', () => this.prevSlide());
    document.getElementById('btn-next-slide')!.addEventListener('click', () => this.nextSlide());
    document.getElementById('btn-toggle-sidebar')!.addEventListener('click', () => this.toggleSidebar());
    document.getElementById('btn-overview-grid')!.addEventListener('click', () => this.toggleOverview(true));
    document.getElementById('btn-windowed-mode')!.addEventListener('click', () => this.toggleWindowedPresentation());
    document.getElementById('btn-fullscreen-mode')!.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('btn-presenter-mode')!.addEventListener('click', () => window.electronAPI.openPresenterWindow());

    // Dropdown menu
    const btnMenuMore = document.getElementById('btn-menu-more')!;
    btnMenuMore.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dropdownMenuEl.classList.toggle('hidden');
    });
    window.addEventListener('click', () => {
      this.dropdownMenuEl.classList.add('hidden');
    });

    // Menu Actions
    document.getElementById('menu-open-folder')!.addEventListener('click', () => this.openFolder());
    document.getElementById('menu-open-package')!.addEventListener('click', () => this.openPackage());
    document.getElementById('menu-export-package')!.addEventListener('click', () => this.exportPackage());
    document.getElementById('menu-new-deck')!.addEventListener('click', () => this.newDeck());
    document.getElementById('menu-new-slide')!.addEventListener('click', () => this.promptNewSlide());
    document.getElementById('menu-reload-slide')!.addEventListener('click', () => this.reloadCurrentSlide());
    document.getElementById('menu-help-shortcuts')!.addEventListener('click', () => this.toggleShortcuts(true));

    // Empty state actions
    document.getElementById('btn-welcome-sample')!.addEventListener('click', () => this.loadSampleDeck());
    document.getElementById('btn-welcome-open-folder')!.addEventListener('click', () => this.openFolder());
    document.getElementById('btn-welcome-open-package')!.addEventListener('click', () => this.openPackage());
    document.getElementById('btn-welcome-new')!.addEventListener('click', () => this.newDeck());

    // Sidebar & Notes
    document.getElementById('btn-sidebar-add-slide')!.addEventListener('click', () => this.promptNewSlide());
    document.getElementById('btn-save-notes')!.addEventListener('click', () => this.saveNotes());

    // Modals
    document.getElementById('btn-close-overview')!.addEventListener('click', () => this.toggleOverview(false));
    document.getElementById('btn-close-shortcuts')!.addEventListener('click', () => this.toggleShortcuts(false));

    // Floating Controls
    this.floatPrevBtn.addEventListener('click', () => this.prevSlide());
    this.floatNextBtn.addEventListener('click', () => this.nextSlide());
    this.floatExitBtn.addEventListener('click', () => this.exitPresentationMode());

    // Mouse movement in presentation mode for floating controls
    window.addEventListener('mousemove', () => {
      if (this.isPresentationMode) {
        this.floatingControlsEl.classList.add('active');
        if (this.floatingControlsTimer) clearTimeout(this.floatingControlsTimer);
        this.floatingControlsTimer = setTimeout(() => {
          this.floatingControlsEl.classList.remove('active');
        }, 2200);
      }
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
  }

  private setupScaler(): void {
    const updateScale = () => {
      if (!this.manifest) return;
      const stageW = this.stageEl.clientWidth;
      const stageH = this.stageEl.clientHeight;
      if (stageW <= 0 || stageH <= 0) return;

      const baseW = this.manifest.customWidth || 1920;
      const baseH = this.manifest.customHeight || 1080;

      // In presentation mode (windowed or fullscreen), fill available stage
      const paddingFactor = this.isPresentationMode ? 1.0 : 0.96;
      const scale = Math.min((stageW * paddingFactor) / baseW, (stageH * paddingFactor) / baseH);

      this.slideBoxEl.style.width = `${baseW}px`;
      this.slideBoxEl.style.height = `${baseH}px`;
      this.slideBoxEl.style.transform = `scale(${scale})`;
      this.slideBoxEl.style.left = `${(stageW - baseW) / 2}px`;
      this.slideBoxEl.style.top = `${(stageH - baseH) / 2}px`;
    };

    const ro = new ResizeObserver(updateScale);
    ro.observe(this.stageEl);
    window.addEventListener('resize', updateScale);
  }

  private setupIPCListeners(): void {
    // Live File Watcher
    window.electronAPI.onFileChanged(({ filePath, eventType }) => {
      this.flashLiveBadge();
      console.log(`[NeoPowerPoint Watcher] ${eventType}: ${filePath}`);
      if (filePath.toLowerCase().endsWith('deck.json')) {
        // Manifest updated
        this.reloadManifest();
      } else {
        // Slide or asset changed, reload current slide iframe
        this.reloadCurrentSlide();
      }
    });

    // Remote navigation from Presenter window or main menu
    window.electronAPI.onNavigateSlide((target: any) => {
      if (target === 'next') this.nextSlide();
      else if (target === 'prev') this.prevSlide();
      else if (target === 'last') this.goToSlide(this.manifest ? this.manifest.slides.length - 1 : 0);
      else if (typeof target === 'number') this.goToSlide(target);
    });

    window.electronAPI.onToggleFullscreenEvent(() => {
      this.toggleFullscreen();
    });

    window.electronAPI.onToggleWindowedEvent(() => {
      this.toggleWindowedPresentation();
    });

    window.electronAPI.onReloadSlideEvent(() => {
      this.reloadCurrentSlide();
    });
  }

  private setupIframeMessageBridge(): void {
    window.addEventListener('message', (event) => {
      if (!event.data) return;
      if (event.data.type === 'NEODECK_NEXT') {
        this.nextSlide();
      } else if (event.data.type === 'NEODECK_PREV') {
        this.prevSlide();
      } else if (event.data.type === 'NEODECK_GOTO') {
        this.goToSlide(event.data.index);
      } else if (event.data.type === 'NEODECK_TOGGLE_PRESENT') {
        this.toggleWindowedPresentation();
      }
    });
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Ignore navigation shortcuts when editing text notes
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      if (e.key === 'Escape') {
        (activeEl as HTMLElement).blur();
      }
      return;
    }

    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      this.nextSlide();
    } else if (e.key === 'ArrowLeft' || e.key === 'Backspace' || e.key === 'PageUp') {
      e.preventDefault();
      this.prevSlide();
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.goToSlide(0);
    } else if (e.key === 'End' && this.manifest) {
      e.preventDefault();
      this.goToSlide(this.manifest.slides.length - 1);
    } else if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      this.toggleWindowedPresentation();
    } else if (e.key === 'f' || e.key === 'F' || e.key === 'F11') {
      e.preventDefault();
      this.toggleFullscreen();
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      window.electronAPI.openPresenterWindow();
    } else if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      this.toggleOverview();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      this.reloadCurrentSlide();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      this.toggleSidebar();
    } else if (e.key === '?') {
      e.preventDefault();
      this.toggleShortcuts();
    } else if (e.key === 'Escape') {
      if (!this.overviewModalEl.classList.contains('hidden')) {
        this.toggleOverview(false);
      } else if (!this.shortcutsModalEl.classList.contains('hidden')) {
        this.toggleShortcuts(false);
      } else if (this.isPresentationMode) {
        this.exitPresentationMode();
      }
    }
  }

  // File & Deck Operations
  async openFolder(): Promise<void> {
    const res = await window.electronAPI.openFolderDialog();
    if (res) this.loadDeck(res.deckPath, res.manifest);
  }

  async openPackage(): Promise<void> {
    const res = await window.electronAPI.openPackageDialog();
    if (res) this.loadDeck(res.deckPath, res.manifest);
  }

  async exportPackage(): Promise<void> {
    if (!this.deckPath) return;
    const dest = await window.electronAPI.exportPackageDialog();
    if (dest) {
      alert(`Presentation exported successfully to:\n${dest}`);
    }
  }

  async newDeck(): Promise<void> {
    const res = await window.electronAPI.createNewDeckDialog();
    if (res) this.loadDeck(res.deckPath, res.manifest);
  }

  async loadSampleDeck(): Promise<void> {
    const res = await window.electronAPI.loadSampleDeck();
    if (res) this.loadDeck(res.deckPath, res.manifest);
  }

  private loadDeck(deckPath: string, manifest: DeckManifest): void {
    this.deckPath = deckPath;
    this.manifest = manifest;
    this.currentIndex = 0;

    this.deckTitleEl.textContent = manifest.title || 'Presentation';
    this.liveBadgeEl.classList.remove('hidden');
    this.emptyStateEl.classList.add('hidden');
    this.slideWrapperEl.classList.remove('hidden');

    this.renderSidebarSlides();
    this.goToSlide(0);
  }

  private renderSidebarSlides(): void {
    if (!this.manifest) return;
    this.slidesListEl.innerHTML = '';

    this.manifest.slides.forEach((slide, idx) => {
      const item = document.createElement('div');
      item.className = `slide-item ${idx === this.currentIndex ? 'active' : ''}`;
      item.innerHTML = `
        <span class="slide-item-num">${idx + 1}</span>
        <span class="slide-item-title">${slide.title || 'Slide'}</span>
      `;
      item.addEventListener('click', () => this.goToSlide(idx));
      this.slidesListEl.appendChild(item);
    });
  }

  goToSlide(index: number): void {
    if (!this.manifest || this.manifest.slides.length === 0) return;
    if (index < 0) index = 0;
    if (index >= this.manifest.slides.length) index = this.manifest.slides.length - 1;

    this.currentIndex = index;
    const currentSlide = this.manifest.slides[this.currentIndex];

    // Update Counter
    const total = this.manifest.slides.length;
    this.slideCounterEl.textContent = `${this.currentIndex + 1} / ${total}`;
    this.floatCounterEl.textContent = `${this.currentIndex + 1} / ${total}`;

    // Update Iframe Source
    const slideUrl = `neopres://deck/${currentSlide.path}`;
    this.slideFrameEl.src = slideUrl;

    // Update Sidebar Selection & Notes
    this.updateSidebarSelection();
    this.notesEditorEl.value = currentSlide.notes || '';

    // Synchronize to Presenter View
    this.syncPresenterState();

    // Trigger Scaler adjustment
    window.dispatchEvent(new Event('resize'));
  }

  nextSlide(): void {
    if (this.manifest && this.currentIndex < this.manifest.slides.length - 1) {
      this.goToSlide(this.currentIndex + 1);
    }
  }

  prevSlide(): void {
    if (this.currentIndex > 0) {
      this.goToSlide(this.currentIndex - 1);
    }
  }

  reloadCurrentSlide(): void {
    if (!this.manifest || !this.manifest.slides[this.currentIndex]) return;
    const cur = this.manifest.slides[this.currentIndex];
    this.slideFrameEl.src = `neopres://deck/${cur.path}?t=${Date.now()}`;
    this.syncPresenterState();
  }

  private async reloadManifest(): Promise<void> {
    if (!this.deckPath) return;
    // Manifest reload
    const res = await window.electronAPI.openFolderDialog();
    if (res) {
      this.manifest = res.manifest;
      this.renderSidebarSlides();
      this.goToSlide(this.currentIndex);
    }
  }

  private updateSidebarSelection(): void {
    const items = this.slidesListEl.querySelectorAll('.slide-item');
    items.forEach((item, idx) => {
      if (idx === this.currentIndex) {
        item.classList.add('active');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('active');
      }
    });
  }

  private async saveNotes(): Promise<void> {
    if (!this.manifest || !this.manifest.slides[this.currentIndex]) return;
    const cur = this.manifest.slides[this.currentIndex];
    cur.notes = this.notesEditorEl.value;
    await window.electronAPI.saveManifest(this.manifest);
    this.syncPresenterState();
  }

  private async promptNewSlide(): Promise<void> {
    if (!this.deckPath) {
      alert('Please open or create a presentation first.');
      return;
    }
    const title = prompt('Enter new slide title:', 'New Slide');
    if (!title) return;

    const updatedManifest = await window.electronAPI.addNewSlide(title);
    if (updatedManifest) {
      this.manifest = updatedManifest;
      this.renderSidebarSlides();
      this.goToSlide(this.manifest.slides.length - 1);
    }
  }

  private toggleSidebar(): void {
    this.sidebarEl.classList.toggle('collapsed');
    window.dispatchEvent(new Event('resize'));
  }

  // Presentation Modes
  toggleWindowedPresentation(): void {
    this.isPresentationMode = !this.isPresentationMode;
    document.body.classList.toggle('mode-presentation', this.isPresentationMode);
    this.floatingControlsEl.classList.toggle('hidden', !this.isPresentationMode);
    window.electronAPI.setWindowedPresentation(this.isPresentationMode);
    window.dispatchEvent(new Event('resize'));
  }

  async toggleFullscreen(): Promise<void> {
    const isFs = await window.electronAPI.toggleFullscreen();
    this.isPresentationMode = isFs;
    document.body.classList.toggle('mode-presentation', isFs);
    this.floatingControlsEl.classList.toggle('hidden', !isFs);
    window.dispatchEvent(new Event('resize'));
  }

  exitPresentationMode(): void {
    this.isPresentationMode = false;
    document.body.classList.remove('mode-presentation');
    this.floatingControlsEl.classList.add('hidden');
    window.electronAPI.setWindowedPresentation(false);
    window.dispatchEvent(new Event('resize'));
  }

  // Modals
  toggleOverview(force?: boolean): void {
    const show = force !== undefined ? force : this.overviewModalEl.classList.contains('hidden');
    if (show && this.manifest) {
      this.renderOverviewGrid();
      this.overviewModalEl.classList.remove('hidden');
    } else {
      this.overviewModalEl.classList.add('hidden');
    }
  }

  private renderOverviewGrid(): void {
    if (!this.manifest) return;
    this.overviewGridEl.innerHTML = '';

    this.manifest.slides.forEach((slide, idx) => {
      const card = document.createElement('div');
      card.className = `overview-card ${idx === this.currentIndex ? 'active' : ''}`;
      card.innerHTML = `
        <span class="overview-card-num">${idx + 1}</span>
        <div class="overview-card-title">${slide.title || 'Slide'}</div>
      `;
      card.addEventListener('click', () => {
        this.goToSlide(idx);
        this.toggleOverview(false);
      });
      this.overviewGridEl.appendChild(card);
    });
  }

  toggleShortcuts(force?: boolean): void {
    const show = force !== undefined ? force : this.shortcutsModalEl.classList.contains('hidden');
    if (show) {
      this.shortcutsModalEl.classList.remove('hidden');
    } else {
      this.shortcutsModalEl.classList.add('hidden');
    }
  }

  private syncPresenterState(): void {
    if (!this.manifest) return;
    window.electronAPI.syncStateToPresenter({
      manifest: this.manifest,
      currentIndex: this.currentIndex,
      totalSlides: this.manifest.slides.length
    });
  }

  private flashLiveBadge(): void {
    this.liveBadgeEl.style.transform = 'scale(1.15)';
    setTimeout(() => {
      this.liveBadgeEl.style.transform = 'scale(1)';
    }, 250);
  }
}

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  new PresentationApp();
});
