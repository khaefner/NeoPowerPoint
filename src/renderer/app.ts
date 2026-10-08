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
  private overviewCountBadgeEl = document.getElementById('overview-count-badge');

  // Slide Sorter State
  private draggedIndex: number | null = null;
  private sidebarDraggedIndex: number | null = null;
  private selectedOverviewIndex: number = 0;

  constructor() {
    this.setupEventListeners();
    this.setupScaler();
    this.setupOverviewScaler();
    this.setupSidebarScaler();
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

    // Slide Sorter thumbnail size controls
    const btnSm = document.getElementById('btn-sorter-size-sm');
    const btnMd = document.getElementById('btn-sorter-size-md');
    const btnLg = document.getElementById('btn-sorter-size-lg');

    const setSorterSize = (size: 'sm' | 'md' | 'lg', minW: string) => {
      [btnSm, btnMd, btnLg].forEach((b) => b?.classList.remove('active'));
      if (size === 'sm') btnSm?.classList.add('active');
      else if (size === 'md') btnMd?.classList.add('active');
      else if (size === 'lg') btnLg?.classList.add('active');

      this.overviewGridEl.style.setProperty('--card-min-width', minW);
      this.updateOverviewScales();
    };

    btnSm?.addEventListener('click', () => setSorterSize('sm', '220px'));
    btnMd?.addEventListener('click', () => setSorterSize('md', '300px'));
    btnLg?.addEventListener('click', () => setSorterSize('lg', '420px'));

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

  private setupOverviewScaler(): void {
    const ro = new ResizeObserver(() => {
      if (!this.overviewModalEl.classList.contains('hidden')) {
        this.updateOverviewScales();
      }
    });
    ro.observe(this.overviewGridEl);
  }

  private updateOverviewScales(): void {
    if (!this.manifest) return;
    const baseW = this.manifest.customWidth || 1920;
    const baseH = this.manifest.customHeight || 1080;

    const containers = this.overviewGridEl.querySelectorAll('.card-preview-container');
    if (containers.length === 0) return;

    const firstContainer = containers[0] as HTMLElement;
    const w = firstContainer.clientWidth;
    if (w <= 0) return;

    const scale = w / baseW;
    this.overviewGridEl.style.setProperty('--preview-scale', String(scale));
    this.overviewGridEl.style.setProperty('--slide-base-w', `${baseW}px`);
    this.overviewGridEl.style.setProperty('--slide-base-h', `${baseH}px`);
    this.overviewGridEl.style.setProperty('--slide-aspect-ratio', `${baseW} / ${baseH}`);
  }

  private setupSidebarScaler(): void {
    const ro = new ResizeObserver(() => {
      this.updateSidebarScales();
    });
    ro.observe(this.slidesListEl);
  }

  private updateSidebarScales(): void {
    if (!this.manifest) return;
    const baseW = this.manifest.customWidth || 1920;
    const baseH = this.manifest.customHeight || 1080;

    const containers = this.slidesListEl.querySelectorAll('.slide-item-preview-container');
    if (containers.length === 0) return;

    const firstContainer = containers[0] as HTMLElement;
    const w = firstContainer.clientWidth;
    if (w <= 0) return;

    const scale = w / baseW;
    this.slidesListEl.style.setProperty('--sidebar-preview-scale', String(scale));
    this.slidesListEl.style.setProperty('--slide-base-w', `${baseW}px`);
    this.slidesListEl.style.setProperty('--slide-base-h', `${baseH}px`);
    this.slidesListEl.style.setProperty('--slide-aspect-ratio', `${baseW} / ${baseH}`);
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
        if (!this.overviewModalEl.classList.contains('hidden')) {
          this.renderOverviewGrid();
        }
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
      // Only process messages from the active presentation stage slide iframe
      if (this.slideFrameEl && event.source !== this.slideFrameEl.contentWindow) {
        return;
      }
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

  private setupIframeKeyDownBridge(iframeDoc: Document): void {
    iframeDoc.addEventListener('keydown', (e: KeyboardEvent) => {
      // If editing text, stop navigation keys from bubbling up
      const activeEl = iframeDoc.activeElement as HTMLElement;
      if (activeEl && activeEl.isContentEditable) {
        if (['Space', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.stopPropagation();
        }

        // Handle bold and italic
        if (e.ctrlKey || e.metaKey) {
          if (e.key === 'b' || e.key === 'B') {
            e.preventDefault();
            iframeDoc.execCommand('bold');
          } else if (e.key === 'i' || e.key === 'I') {
            e.preventDefault();
            iframeDoc.execCommand('italic');
          }
        }
      }

      this.handleKeyDown(e);
    });
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.isEditMode) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        this.saveSlideHtml();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        this.toggleEditMode();
        return;
      }
    }

    // Ignore navigation shortcuts when editing text notes
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      if (e.key === 'Escape') {
        (activeEl as HTMLElement).blur();
      }
      return;
    }

    // When Slide Sorter modal is open
    if (!this.overviewModalEl.classList.contains('hidden') && this.manifest) {
      const total = this.manifest.slides.length;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectedOverviewIndex = (this.selectedOverviewIndex + 1) % total;
        this.highlightOverviewCard(this.selectedOverviewIndex);
        return;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.selectedOverviewIndex = (this.selectedOverviewIndex - 1 + total) % total;
        this.highlightOverviewCard(this.selectedOverviewIndex);
        return;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.goToSlide(this.selectedOverviewIndex);
        this.toggleOverview(false);
        return;
      } else if (e.key === 'Escape' || e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        this.toggleOverview(false);
        return;
      }
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

    const baseW = this.manifest.customWidth || 1920;
    const baseH = this.manifest.customHeight || 1080;
    this.slidesListEl.style.setProperty('--slide-base-w', `${baseW}px`);
    this.slidesListEl.style.setProperty('--slide-base-h', `${baseH}px`);
    this.slidesListEl.style.setProperty('--slide-aspect-ratio', `${baseW} / ${baseH}`);

    this.manifest.slides.forEach((slide, idx) => {
      const item = document.createElement('div');
      item.className = `slide-item ${idx === this.currentIndex ? 'active' : ''}`;
      item.dataset.index = String(idx);
      item.setAttribute('draggable', 'true');

      const slideUrl = `neopres://deck/${slide.path}`;

      item.innerHTML = `
        <div class="slide-item-header">
          <span class="slide-item-num">${idx + 1}</span>
          <span class="slide-item-title" title="${this.escapeHtml(slide.title || 'Slide')}">${this.escapeHtml(slide.title || 'Slide')}</span>
        </div>
        <div class="slide-item-preview-container">
          <div class="slide-item-preview-placeholder">📽️</div>
          <div class="slide-item-preview-scaler">
            <iframe class="slide-item-preview-frame" src="${slideUrl}" sandbox="allow-scripts allow-same-origin allow-forms" tabindex="-1" allow="autoplay 'none'"></iframe>
          </div>
          <div class="slide-item-preview-overlay" title="Slide ${idx + 1}: ${this.escapeHtml(slide.title || 'Slide')}"></div>
        </div>
      `;

      // Mute audio and video in sidebar previews
      const frame = item.querySelector('.slide-item-preview-frame') as HTMLIFrameElement;
      if (frame) {
        frame.addEventListener('load', () => {
          try {
            const doc = frame.contentDocument;
            if (doc) {
              doc.querySelectorAll('audio, video').forEach((media) => {
                (media as HTMLMediaElement).muted = true;
              });
            }
          } catch {
            // ignore
          }
        });
      }

      item.addEventListener('click', () => this.goToSlide(idx));
      this.setupSidebarDragAndDrop(item, idx);

      this.slidesListEl.appendChild(item);
    });

    requestAnimationFrame(() => {
      this.updateSidebarScales();
      requestAnimationFrame(() => this.updateSidebarScales());
    });
  }

  private setupSidebarDragAndDrop(item: HTMLElement, index: number): void {
    item.addEventListener('dragstart', (e) => {
      this.sidebarDraggedIndex = index;
      item.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index));
      }
    });

    item.addEventListener('dragend', () => {
      this.sidebarDraggedIndex = null;
      this.slidesListEl.querySelectorAll('.slide-item').forEach((it) => {
        it.classList.remove('dragging', 'drag-over');
      });
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      if (this.sidebarDraggedIndex !== null && this.sidebarDraggedIndex !== index) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const fromIdx = this.sidebarDraggedIndex;
      const toIdx = index;
      if (fromIdx !== null && fromIdx !== toIdx && this.manifest) {
        await this.reorderSlides(fromIdx, toIdx);
      }
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

    this.slideFrameEl.onload = () => {
      const doc = this.slideFrameEl.contentDocument;
      if (doc) {
        this.setupIframeKeyDownBridge(doc);
        if (this.isEditMode) {
          this.enableEditModeFeatures();
        }
      }
    };

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
    const url = `neopres://deck/${cur.path}?t=${Date.now()}`;
    this.slideFrameEl.src = url;

    // Also refresh the thumbnail in the sidebar
    const currentItem = this.slidesListEl.children[this.currentIndex];
    if (currentItem) {
      const frame = currentItem.querySelector('.slide-item-preview-frame') as HTMLIFrameElement;
      if (frame) {
        frame.src = url;
      }
    }
    this.syncPresenterState();
  }

  private async reloadManifest(): Promise<void> {
    if (!this.deckPath) return;
    const manifest = await window.electronAPI.getManifest();
    if (manifest) {
      this.manifest = manifest;
      this.renderSidebarSlides();
      this.goToSlide(this.currentIndex);
      if (!this.overviewModalEl.classList.contains('hidden')) {
        this.renderOverviewGrid();
      }
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
      this.selectedOverviewIndex = this.currentIndex;
      this.renderOverviewGrid();
      this.overviewModalEl.classList.remove('hidden');
      requestAnimationFrame(() => {
        this.updateOverviewScales();
        requestAnimationFrame(() => this.updateOverviewScales());
      });
    } else {
      this.overviewModalEl.classList.add('hidden');
      // Clean up iframes to release background CPU / GPU while presenting
      this.overviewGridEl.innerHTML = '';
    }
  }

  private renderOverviewGrid(): void {
    if (!this.manifest) return;
    this.overviewGridEl.innerHTML = '';

    const total = this.manifest.slides.length;
    if (this.overviewCountBadgeEl) {
      this.overviewCountBadgeEl.textContent = `${total} slide${total === 1 ? '' : 's'}`;
    }

    const baseW = this.manifest.customWidth || 1920;
    const baseH = this.manifest.customHeight || 1080;
    this.overviewGridEl.style.setProperty('--slide-base-w', `${baseW}px`);
    this.overviewGridEl.style.setProperty('--slide-base-h', `${baseH}px`);
    this.overviewGridEl.style.setProperty('--slide-aspect-ratio', `${baseW} / ${baseH}`);

    this.manifest.slides.forEach((slide, idx) => {
      const card = document.createElement('div');
      card.className = `overview-card ${idx === this.selectedOverviewIndex ? 'active' : ''}`;
      card.dataset.index = String(idx);
      card.setAttribute('draggable', 'true');

      // Notes badge if notes exist
      const notesBadge = slide.notes && slide.notes.trim()
        ? `<span class="card-badge-notes" title="Speaker Notes: ${this.escapeHtml(slide.notes.slice(0, 120))}${slide.notes.length > 120 ? '...' : ''}">📝</span>`
        : '';

      const activeBadge = idx === this.currentIndex
        ? `<span class="card-badge-active">Current</span>`
        : '';

      const slideUrl = `neopres://deck/${slide.path}`;

      card.innerHTML = `
        <div class="card-preview-container">
          <div class="card-preview-placeholder">📽️</div>
          <div class="card-preview-scaler">
            <iframe class="card-preview-frame" src="${slideUrl}" sandbox="allow-scripts allow-same-origin allow-forms" tabindex="-1" allow="autoplay 'none'"></iframe>
          </div>
          <div class="card-preview-overlay" title="Slide ${idx + 1}: ${this.escapeHtml(slide.title || 'Slide')}"></div>
        </div>
        <div class="card-footer">
          <div class="card-meta">
            <span class="card-num">${idx + 1}</span>
            <span class="card-title" title="${this.escapeHtml(slide.title || 'Slide')}">${this.escapeHtml(slide.title || 'Slide')}</span>
          </div>
          <div class="card-badges">
            ${notesBadge}
            ${activeBadge}
          </div>
        </div>
      `;

      // Mute audio and video in previews to prevent background noise
      const frame = card.querySelector('.card-preview-frame') as HTMLIFrameElement;
      if (frame) {
        frame.addEventListener('load', () => {
          try {
            const doc = frame.contentDocument;
            if (doc) {
              doc.querySelectorAll('audio, video').forEach((media) => {
                (media as HTMLMediaElement).muted = true;
              });
            }
          } catch {
            // ignore cross-origin if any
          }
        });
      }

      // Click to navigate and close sorter
      card.addEventListener('click', () => {
        this.goToSlide(idx);
        this.toggleOverview(false);
      });

      // Drag and drop reordering
      this.setupCardDragAndDrop(card, idx);

      this.overviewGridEl.appendChild(card);
    });

    // Scroll selected card into view and update scaling
    requestAnimationFrame(() => {
      this.updateOverviewScales();
      const activeCard = this.overviewGridEl.querySelector('.overview-card.active') as HTMLElement;
      if (activeCard) {
        activeCard.scrollIntoView({ block: 'nearest' });
      }
      requestAnimationFrame(() => this.updateOverviewScales());
    });
  }

  private setupCardDragAndDrop(card: HTMLElement, index: number): void {
    card.addEventListener('dragstart', (e) => {
      this.draggedIndex = index;
      card.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index));
      }
    });

    card.addEventListener('dragend', () => {
      this.draggedIndex = null;
      this.overviewGridEl.querySelectorAll('.overview-card').forEach((c) => {
        c.classList.remove('dragging', 'drag-over');
      });
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      if (this.draggedIndex !== null && this.draggedIndex !== index) {
        card.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const fromIdx = this.draggedIndex;
      const toIdx = index;
      if (fromIdx !== null && fromIdx !== toIdx && this.manifest) {
        await this.reorderSlides(fromIdx, toIdx);
      }
    });
  }

  private async reorderSlides(fromIndex: number, toIndex: number): Promise<void> {
    if (!this.manifest) return;
    const slides = this.manifest.slides;
    if (fromIndex < 0 || fromIndex >= slides.length || toIndex < 0 || toIndex >= slides.length) return;

    // Preserve the currently active slide reference
    const currentSlide = slides[this.currentIndex];

    // Move slide
    const [moved] = slides.splice(fromIndex, 1);
    slides.splice(toIndex, 0, moved);

    // Update currentIndex to follow currentSlide
    const newCurrentIndex = slides.indexOf(currentSlide);
    if (newCurrentIndex !== -1) {
      this.currentIndex = newCurrentIndex;
    }
    this.selectedOverviewIndex = toIndex;

    // Save manifest to file
    await window.electronAPI.saveManifest(this.manifest);

    // Update UI
    this.renderSidebarSlides();
    this.renderOverviewGrid();
    this.syncPresenterState();
  }

  private highlightOverviewCard(index: number): void {
    const cards = this.overviewGridEl.querySelectorAll('.overview-card');
    cards.forEach((c, idx) => {
      if (idx === index) {
        c.classList.add('active');
        c.scrollIntoView({ block: 'nearest' });
      } else {
        c.classList.remove('active');
      }
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  toggleShortcuts(force?: boolean): void {
    const show = force !== undefined ? force : this.shortcutsModalEl.classList.contains('hidden');
    if (show) {
      this.shortcutsModalEl.classList.remove('hidden');
    } else {
      this.shortcutsModalEl.classList.add('hidden');
    }
  }

  toggleEditMode(): void {
    this.isEditMode = !this.isEditMode;
    const btnToggle = document.getElementById('btn-toggle-edit-mode')!;
    const btnSave = document.getElementById('btn-save-slide')!;

    if (this.isEditMode) {
      btnToggle.classList.add('active');
      btnToggle.style.backgroundColor = 'var(--accent-primary)';
      btnToggle.style.color = '#fff';
      btnSave.classList.remove('hidden');
      this.enableEditModeFeatures();
    } else {
      btnToggle.classList.remove('active');
      btnToggle.style.backgroundColor = '';
      btnToggle.style.color = '';
      btnSave.classList.add('hidden');
      this.disableEditModeFeatures();
    }
  }

  private enableEditModeFeatures(): void {
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    // Make text elements contenteditable
    const textElements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, span, .tb, .textbox, .card, .title, .notes');
    textElements.forEach(el => {
      (el as HTMLElement).setAttribute('contenteditable', 'true');
      (el as HTMLElement).classList.add('editor-editable-text');
    });

    // Calculate scale factor using bounding boxes as requested
    const scaleFactor = this.slideFrameEl.getBoundingClientRect().width / this.slideFrameEl.offsetWidth;
    this.currentScaleFactor = scaleFactor;

    // Make positioned elements draggable
    const positionedElements = doc.querySelectorAll('.abs, .tb, img, .pic, .editor-draggable, [style*="position: absolute"], [style*="position: fixed"]');
    positionedElements.forEach(el => {
      const htmlEl = el as HTMLElement;
      // Skip if it's already an editable text element, text editing takes precedence on mousedown
      if (htmlEl.hasAttribute('contenteditable')) return;

      htmlEl.classList.add('editor-draggable');

      let isDragging = false;
      let initialLeft = 0;
      let initialTop = 0;

      const onMouseDown = (e: MouseEvent) => {
        if (!this.isEditMode) return;

        e.preventDefault();
        e.stopPropagation();
        isDragging = true;

        const style = window.getComputedStyle(htmlEl);
        initialLeft = parseFloat(style.left) || 0;
        initialTop = parseFloat(style.top) || 0;

        htmlEl.classList.add('editor-selected');

        const onMouseMove = (moveEvent: MouseEvent) => {
          if (!isDragging) return;
          moveEvent.preventDefault();
          moveEvent.stopPropagation();

          // Divide movement by scale factor for 1:1 tracking
          const dx = moveEvent.movementX / this.currentScaleFactor;
          const dy = moveEvent.movementY / this.currentScaleFactor;

          initialLeft += dx;
          initialTop += dy;
          htmlEl.style.left = `${initialLeft}px`;
          htmlEl.style.top = `${initialTop}px`;
        };

        const onMouseUp = (upEvent: MouseEvent) => {
          isDragging = false;
          htmlEl.classList.remove('editor-selected');
          doc.removeEventListener('mousemove', onMouseMove, true);
          doc.removeEventListener('mouseup', onMouseUp, true);
        };

        doc.addEventListener('mousemove', onMouseMove, true);
        doc.addEventListener('mouseup', onMouseUp, true);
      };

      (htmlEl as any)._editorDragHandler = onMouseDown;
      htmlEl.addEventListener('mousedown', onMouseDown);
    });

    // Inject temporary styles for outlines
    let styleEl = doc.getElementById('neo-editor-styles');
    if (!styleEl) {
      styleEl = doc.createElement('style');
      styleEl.id = 'neo-editor-styles';
      styleEl.textContent = `
        .editor-editable-text { outline: 1px dashed rgba(56, 189, 248, 0.5); }
        .editor-editable-text:focus { outline: 2px solid #38bdf8; background: rgba(56, 189, 248, 0.1); }
        .editor-draggable { cursor: move; }
        .editor-draggable:hover { outline: 1px dashed rgba(248, 113, 113, 0.5); }
        .editor-selected { outline: 2px solid #f87171 !important; z-index: 9999; }
      `;
      doc.head.appendChild(styleEl);
    }
  }

  private disableEditModeFeatures(): void {
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    doc.querySelectorAll('.editor-editable-text').forEach(el => {
      (el as HTMLElement).removeAttribute('contenteditable');
      (el as HTMLElement).classList.remove('editor-editable-text');
    });

    doc.querySelectorAll('.editor-draggable').forEach(el => {
      const htmlEl = el as HTMLElement;
      htmlEl.classList.remove('editor-draggable', 'editor-selected');
      if ((htmlEl as any)._editorDragHandler) {
        htmlEl.removeEventListener('mousedown', (htmlEl as any)._editorDragHandler);
        delete (htmlEl as any)._editorDragHandler;
      }
    });

    const styleEl = doc.getElementById('neo-editor-styles');
    if (styleEl) styleEl.remove();
  }

  private async saveSlideHtml(): Promise<void> {
    if (!this.manifest || !this.manifest.slides[this.currentIndex]) return;
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    // Clone the document to strip out editor attributes safely
    const clone = doc.documentElement.cloneNode(true) as HTMLElement;

    clone.querySelectorAll('.editor-editable-text').forEach(el => {
      el.removeAttribute('contenteditable');
      el.classList.remove('editor-editable-text');
      if (el.className === '') el.removeAttribute('class');
    });

    clone.querySelectorAll('.editor-draggable').forEach(el => {
      el.classList.remove('editor-draggable', 'editor-selected');
      if (el.className === '') el.removeAttribute('class');
    });

    const styleEl = clone.querySelector('#neo-editor-styles');
    if (styleEl) styleEl.remove();

    // Reconstruct with original doctype if possible, otherwise use standard html5
    let doctypeString = '<!DOCTYPE html>\n';
    if (doc.doctype) {
      doctypeString = `<!DOCTYPE ${doc.doctype.name}` +
        (doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : '') +
        (doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : '') +
        '>\n';
    }

    const htmlContent = doctypeString + clone.outerHTML;
    const currentSlide = this.manifest.slides[this.currentIndex];

    const success = await window.electronAPI.saveSlideHtml(currentSlide.path, htmlContent);

    if (success) {
      this.flashLiveBadge(); // Provide visual feedback for save
      // Ensure the thumbnail is updated after saving
      this.reloadCurrentSlide();
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
