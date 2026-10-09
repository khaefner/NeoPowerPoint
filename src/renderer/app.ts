import { DeckManifest, SlideMetadata } from '../types/deck';
import { ElectronAPI } from '../preload/preload';

declare const window: Window & { electronAPI: ElectronAPI };

class PresentationApp {
  private deckPath: string | null = null;
  private manifest: DeckManifest | null = null;
  private currentIndex: number = 0;
  private isPresentationMode: boolean = false;
  private isEditMode: boolean = true;
  private currentScaleFactor: number = 1;
  private floatingControlsTimer: any = null;

  // DOM Elements
  private emptyStateEl = document.getElementById('empty-state')!;
  private slideWrapperEl = document.getElementById('slide-wrapper')!;
  private slideBoxEl = document.getElementById('slide-box')!;
  private slideFrameA = document.getElementById('slide-frame-a') as HTMLIFrameElement;
  private slideFrameB = document.getElementById('slide-frame-b') as HTMLIFrameElement;
  private activeFrameIndex: 0 | 1 = 0;
  private transitionTimer: any = null;
  private navSequence: number = 0;
  private currentTransitionOverride: string | null = null;

  get slideFrameEl(): HTMLIFrameElement {
    return this.activeFrameIndex === 0 ? this.slideFrameA : this.slideFrameB;
  }

  get idleFrameEl(): HTMLIFrameElement {
    return this.activeFrameIndex === 0 ? this.slideFrameB : this.slideFrameA;
  }
  private stageEl = document.getElementById('viewport-stage')!;
  private sidebarEl = document.getElementById('sidebar-slides')!;
  private slidesListEl = document.getElementById('slides-list')!;
  private deckTitleEl = document.getElementById('deck-title')!;
  private slideCounterEl = document.getElementById('slide-counter')!;
  private notesEditorEl = document.getElementById('slide-notes-editor') as HTMLElement;
  private modalNotesEditorEl = document.getElementById('modal-notes-editor') as HTMLElement;
  private notesModalEl = document.getElementById('notes-modal')!;
  private notesSaveStatusEl = document.getElementById('notes-save-status');
  private notesResizerEl = document.getElementById('notes-resizer')!;
  private sidebarNotesPanelEl = document.getElementById('sidebar-notes-panel')!;
  private notesAutoSaveTimer: any = null;
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
  private editorToolbarEl = document.getElementById('editor-toolbar')!;

  // WYSIWYG Editor Selection State
  private currentActiveElement: HTMLElement | null = null;
  private currentSelectedRange: Range | null = null;

  // Slide Sorter State
  private draggedIndex: number | null = null;
  private sidebarDraggedIndex: number | null = null;
  private selectedOverviewIndex: number = 0;

  constructor() {
    this.setupEventListeners();
    this.setupNotesResizer();
    this.setupNotesControls();
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
    document.getElementById('btn-toggle-edit-mode')?.addEventListener('click', () => this.toggleEditMode());
    document.getElementById('btn-save-slide')?.addEventListener('click', () => this.saveSlideHtml());
    document.getElementById('btn-overview-grid')!.addEventListener('click', () => this.toggleOverview(true));
    document.getElementById('btn-windowed-mode')!.addEventListener('click', () => this.toggleWindowedPresentation());
    document.getElementById('btn-fullscreen-mode')!.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('btn-presenter-mode')!.addEventListener('click', () => window.electronAPI.openPresenterWindow());

    // Editor Toolbar Controls
    document.getElementById('btn-add-textbox')?.addEventListener('click', () => this.addNewTextBox());
    document.getElementById('btn-font-smaller')?.addEventListener('click', () => this.adjustFontSize(-1));
    document.getElementById('btn-font-larger')?.addEventListener('click', () => this.adjustFontSize(1));
    document.getElementById('select-font-size')?.addEventListener('change', (e) => {
      this.setFontSize((e.target as HTMLSelectElement).value);
    });
    document.getElementById('btn-format-bold')?.addEventListener('click', () => this.formatText('bold'));
    document.getElementById('btn-format-italic')?.addEventListener('click', () => this.formatText('italic'));
    document.getElementById('btn-format-underline')?.addEventListener('click', () => this.formatText('underline'));
    document.getElementById('input-font-color')?.addEventListener('input', (e) => {
      this.setFontColor((e.target as HTMLInputElement).value);
    });
    document.querySelectorAll('.color-swatch').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const color = (e.currentTarget as HTMLElement).dataset.color;
        if (color) this.setFontColor(color);
      });
    });
    document.getElementById('btn-delete-element')?.addEventListener('click', () => this.deleteSelectedElement());
    document.getElementById('btn-editor-done')?.addEventListener('click', () => this.toggleEditMode());
    document.getElementById('btn-editor-save')?.addEventListener('click', () => this.saveSlideHtml());

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
    document.getElementById('menu-toggle-edit')?.addEventListener('click', () => this.toggleEditMode());
    document.getElementById('menu-save-slide')?.addEventListener('click', () => this.saveSlideHtml());
    document.getElementById('menu-trans-fade')?.addEventListener('click', () => this.setDeckTransition('fade'));
    document.getElementById('menu-trans-slide')?.addEventListener('click', () => this.setDeckTransition('slide-left'));
    document.getElementById('menu-trans-zoom')?.addEventListener('click', () => this.setDeckTransition('zoom'));
    document.getElementById('menu-trans-none')?.addEventListener('click', () => this.setDeckTransition('none'));
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
    document.getElementById('btn-expand-notes')?.addEventListener('click', () => this.toggleNotesModal(true));
    document.getElementById('btn-close-notes-modal')?.addEventListener('click', () => this.toggleNotesModal(false));
    document.getElementById('btn-notes-modal-save')?.addEventListener('click', () => {
      this.saveNotes();
      this.toggleNotesModal(false);
    });

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
      const activeEl = iframeDoc.activeElement as HTMLElement;
      const isEditing = activeEl && (activeEl.isContentEditable || activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');

      if (isEditing) {
        // Allow formatting shortcuts
        if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
          e.preventDefault();
          iframeDoc.execCommand('bold');
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
          e.preventDefault();
          iframeDoc.execCommand('italic');
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U')) {
          e.preventDefault();
          iframeDoc.execCommand('underline');
          return;
        }

        // Handle Save or Toggle shortcuts while editing
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
        if (e.key === 'Escape') {
          activeEl.blur();
          return;
        }

        // Stop all other editing keys (Space, Backspace, Arrow keys, Enter, etc.) from triggering slide navigation
        e.stopPropagation();
        return;
      }

      this.handleKeyDown(e);
    });
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      this.toggleEditMode();
      return;
    }
    if (this.isEditMode && (e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      this.saveSlideHtml();
      return;
    }

    // Ignore navigation shortcuts when editing text notes or inputs
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || (activeEl as HTMLElement).isContentEditable)) {
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
      if (!this.notesModalEl.classList.contains('hidden')) {
        this.toggleNotesModal(false);
      } else if (!this.overviewModalEl.classList.contains('hidden')) {
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

    this.isEditMode = true;
    this.editorToolbarEl?.classList.remove('hidden');
    document.getElementById('btn-save-slide')?.classList.remove('hidden');
    const labelToggle = document.getElementById('label-toggle-edit');
    if (labelToggle) labelToggle.textContent = 'Test Scripts';

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

  setDeckTransition(trans: 'fade' | 'slide-left' | 'zoom' | 'none'): void {
    this.currentTransitionOverride = trans;
    if (this.manifest) {
      this.manifest.defaultTransition = trans;
    }
  }

  goToSlide(index: number, forceInstant: boolean = false): void {
    if (!this.manifest || this.manifest.slides.length === 0) return;
    if (index < 0) index = 0;
    if (index >= this.manifest.slides.length) index = this.manifest.slides.length - 1;

    const previousIndex = this.currentIndex;
    this.currentIndex = index;
    const currentSlide = this.manifest.slides[this.currentIndex];
    const isForward = index >= previousIndex;

    // Update Counter
    const total = this.manifest.slides.length;
    this.slideCounterEl.textContent = `${this.currentIndex + 1} / ${total}`;
    this.floatCounterEl.textContent = `${this.currentIndex + 1} / ${total}`;

    // Update Sidebar Selection & Notes immediately
    this.updateSidebarSelection();
    const rawNotes = currentSlide.notes || '';
    this.notesEditorEl.innerHTML = rawNotes;
    if (this.modalNotesEditorEl) {
      this.modalNotesEditorEl.innerHTML = rawNotes;
    }

    // Synchronize to Presenter View
    this.syncPresenterState();

    const slideUrl = `neopres://deck/${currentSlide.path}`;
    const seq = ++this.navSequence;

    // Determine transition type
    const isInitial = !this.slideFrameEl.src || this.slideFrameEl.src === 'about:blank' || this.slideFrameEl.src === '';
    const transitionType = (forceInstant || isInitial)
      ? 'none'
      : (this.currentTransitionOverride || currentSlide.transition || this.manifest.defaultTransition || 'fade');

    console.log(`[NeoDeck] goToSlide(${index}): Loading ${slideUrl} (transition: ${transitionType})`);

    if (transitionType === 'none') {
      const activeFrame = this.slideFrameEl;
      activeFrame.style.transition = 'none';
      activeFrame.style.opacity = '1';
      activeFrame.style.transform = 'none';
      activeFrame.style.zIndex = '2';
      activeFrame.style.pointerEvents = 'auto';
      activeFrame.classList.add('slide-frame-active');
      activeFrame.classList.remove('slide-frame-idle');

      const idleFrame = this.idleFrameEl;
      idleFrame.style.transition = 'none';
      idleFrame.style.opacity = '0';
      idleFrame.style.zIndex = '1';
      idleFrame.style.pointerEvents = 'none';
      idleFrame.classList.remove('slide-frame-active');
      idleFrame.classList.add('slide-frame-idle');

      activeFrame.src = slideUrl;
      activeFrame.onload = () => {
        if (this.navSequence !== seq) return;
        const doc = activeFrame.contentDocument;
        if (doc) {
          this.setupIframeKeyDownBridge(doc);
          if (this.isEditMode && !this.isPresentationMode) {
            this.enableEditModeFeatures();
          }
        }
      };
      window.dispatchEvent(new Event('resize'));
      return;
    }

    // Double-buffered smooth transition
    const currentActiveFrame = this.slideFrameEl;
    const incomingFrame = this.idleFrameEl;

    // Remove edit overlays from outgoing frame to prevent ghosting
    this.disableEditModeFeatures();

    // Prepare incoming frame positioning before load
    incomingFrame.style.transition = 'none';
    if (transitionType === 'slide-left' || transitionType === 'slide') {
      incomingFrame.style.transform = isForward ? 'translate3d(100%, 0, 0)' : 'translate3d(-100%, 0, 0)';
      incomingFrame.style.opacity = '1';
    } else if (transitionType === 'zoom') {
      incomingFrame.style.transform = 'scale(1.06)';
      incomingFrame.style.opacity = '0';
    } else {
      // Default: 'fade'
      incomingFrame.style.transform = 'scale(1)';
      incomingFrame.style.opacity = '0';
    }
    incomingFrame.style.zIndex = '2';
    incomingFrame.style.pointerEvents = 'none';

    incomingFrame.src = slideUrl;

    incomingFrame.onload = () => {
      if (this.navSequence !== seq) return;

      // Force browser reflow to register initial position
      void incomingFrame.offsetHeight;

      // Apply smooth transition
      const duration = '0.35s';
      const easing = 'cubic-bezier(0.25, 1, 0.5, 1)';
      incomingFrame.style.transition = `opacity ${duration} ${easing}, transform ${duration} ${easing}`;
      currentActiveFrame.style.transition = `opacity ${duration} ${easing}, transform ${duration} ${easing}`;

      // Animate incoming to active
      incomingFrame.style.opacity = '1';
      incomingFrame.style.transform = 'translate3d(0, 0, 0) scale(1)';
      incomingFrame.style.pointerEvents = 'auto';
      incomingFrame.classList.add('slide-frame-active');
      incomingFrame.classList.remove('slide-frame-idle');

      // Animate current outgoing frame
      currentActiveFrame.style.pointerEvents = 'none';
      currentActiveFrame.style.zIndex = '1';
      if (transitionType === 'slide-left' || transitionType === 'slide') {
        currentActiveFrame.style.transform = isForward ? 'translate3d(-100%, 0, 0)' : 'translate3d(100%, 0, 0)';
        currentActiveFrame.style.opacity = '1';
      } else if (transitionType === 'zoom') {
        currentActiveFrame.style.transform = 'scale(0.94)';
        currentActiveFrame.style.opacity = '0';
      } else {
        // Fade
        currentActiveFrame.style.opacity = '0';
      }
      currentActiveFrame.classList.remove('slide-frame-active');
      currentActiveFrame.classList.add('slide-frame-idle');

      // Swap active buffer index
      this.activeFrameIndex = this.activeFrameIndex === 0 ? 1 : 0;

      // Setup DOM bridge & edit mode on the new active frame
      const doc = incomingFrame.contentDocument;
      if (doc) {
        this.setupIframeKeyDownBridge(doc);
        if (this.isEditMode && !this.isPresentationMode) {
          this.enableEditModeFeatures();
        }
      }

      // Cleanup idle frame after transition ends
      if (this.transitionTimer) clearTimeout(this.transitionTimer);
      this.transitionTimer = setTimeout(() => {
        try {
          const oldDoc = currentActiveFrame.contentDocument;
          if (oldDoc) {
            oldDoc.querySelectorAll('audio, video').forEach(m => (m as HTMLMediaElement).pause());
          }
        } catch (_) {}
        currentActiveFrame.style.transform = 'none';
      }, 380);
    };

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

  private setupNotesResizer(): void {
    // Restore saved height from local storage if exists
    const savedH = localStorage.getItem('neo-notes-height');
    if (savedH) {
      this.sidebarNotesPanelEl.style.setProperty('--notes-panel-height', `${savedH}px`);
    }

    let isResizing = false;
    let startY = 0;
    let startH = 0;

    this.notesResizerEl.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      isResizing = true;
      startY = e.clientY;
      startH = this.sidebarNotesPanelEl.clientHeight;
      this.notesResizerEl.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      const onMouseMove = (me: MouseEvent) => {
        if (!isResizing) return;
        const delta = startY - me.clientY;
        const newH = Math.max(100, Math.min(window.innerHeight * 0.75, startH + delta));
        this.sidebarNotesPanelEl.style.setProperty('--notes-panel-height', `${newH}px`);
      };

      const onMouseUp = () => {
        if (isResizing) {
          isResizing = false;
          this.notesResizerEl.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          const finalH = this.sidebarNotesPanelEl.clientHeight;
          localStorage.setItem('neo-notes-height', String(finalH));
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        }
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  private setupNotesControls(): void {
    // Sidebar Toolbar Buttons
    document.getElementById('btn-notes-bold')?.addEventListener('click', () => this.execNotesCommand('bold'));
    document.getElementById('btn-notes-italic')?.addEventListener('click', () => this.execNotesCommand('italic'));
    document.getElementById('btn-notes-underline')?.addEventListener('click', () => this.execNotesCommand('underline'));
    document.getElementById('btn-notes-bullet')?.addEventListener('click', () => this.execNotesCommand('insertUnorderedList'));
    document.getElementById('btn-notes-number')?.addEventListener('click', () => this.execNotesCommand('insertOrderedList'));
    document.getElementById('btn-notes-font-down')?.addEventListener('click', () => this.adjustNotesFontSize(-1, 'sidebar'));
    document.getElementById('btn-notes-font-up')?.addEventListener('click', () => this.adjustNotesFontSize(1, 'sidebar'));

    // Modal Toolbar Buttons
    document.getElementById('btn-m-notes-bold')?.addEventListener('click', () => this.execNotesCommand('bold'));
    document.getElementById('btn-m-notes-italic')?.addEventListener('click', () => this.execNotesCommand('italic'));
    document.getElementById('btn-m-notes-underline')?.addEventListener('click', () => this.execNotesCommand('underline'));
    document.getElementById('btn-m-notes-bullet')?.addEventListener('click', () => this.execNotesCommand('insertUnorderedList'));
    document.getElementById('btn-m-notes-number')?.addEventListener('click', () => this.execNotesCommand('insertOrderedList'));
    document.getElementById('btn-m-notes-font-down')?.addEventListener('click', () => this.adjustNotesFontSize(-1, 'modal'));
    document.getElementById('btn-m-notes-font-up')?.addEventListener('click', () => this.adjustNotesFontSize(1, 'modal'));

    // Live Typing & Auto-saving
    this.notesEditorEl?.addEventListener('input', () => this.onNotesInput('sidebar'));
    this.modalNotesEditorEl?.addEventListener('input', () => this.onNotesInput('modal'));
  }

  private execNotesCommand(cmd: string, val: string | undefined = undefined): void {
    document.execCommand(cmd, false, val);
    this.onNotesInput('sidebar');
  }

  private adjustNotesFontSize(dir: number, target: 'sidebar' | 'modal'): void {
    const editor = target === 'sidebar' ? this.notesEditorEl : this.modalNotesEditorEl;
    if (!editor) return;
    const style = window.getComputedStyle(editor);
    const curr = parseFloat(style.fontSize) || 14;
    const next = Math.max(11, Math.min(36, curr + (dir * 2)));
    editor.style.fontSize = `${next}px`;
  }

  private onNotesInput(source: 'sidebar' | 'modal'): void {
    if (this.notesSaveStatusEl) {
      this.notesSaveStatusEl.textContent = 'Saving...';
      this.notesSaveStatusEl.classList.add('saving');
    }
    if (source === 'sidebar' && this.modalNotesEditorEl) {
      this.modalNotesEditorEl.innerHTML = this.notesEditorEl.innerHTML;
    } else if (source === 'modal' && this.notesEditorEl) {
      this.notesEditorEl.innerHTML = this.modalNotesEditorEl.innerHTML;
    }

    if (this.notesAutoSaveTimer) clearTimeout(this.notesAutoSaveTimer);
    this.notesAutoSaveTimer = setTimeout(() => {
      this.saveNotes();
    }, 700);
  }

  toggleNotesModal(force?: boolean): void {
    const isVisible = !this.notesModalEl.classList.contains('hidden');
    const target = force !== undefined ? force : !isVisible;
    if (target) {
      const slideTitle = this.manifest?.slides[this.currentIndex]?.title || `Slide ${this.currentIndex + 1}`;
      const subtitleEl = document.getElementById('notes-modal-slide-title');
      if (subtitleEl) subtitleEl.textContent = `${this.currentIndex + 1}. ${slideTitle}`;
      if (this.modalNotesEditorEl) {
        this.modalNotesEditorEl.innerHTML = this.notesEditorEl.innerHTML;
      }
      this.notesModalEl.classList.remove('hidden');
      this.modalNotesEditorEl?.focus();
    } else {
      this.notesModalEl.classList.add('hidden');
      this.saveNotes();
    }
  }

  private async saveNotes(): Promise<void> {
    if (!this.manifest || !this.manifest.slides[this.currentIndex]) return;
    const cur = this.manifest.slides[this.currentIndex];
    cur.notes = this.notesEditorEl.innerHTML;
    await window.electronAPI.saveManifest(this.manifest);
    this.syncPresenterState();
    if (this.notesSaveStatusEl) {
      this.notesSaveStatusEl.textContent = 'Saved ✓';
      this.notesSaveStatusEl.classList.remove('saving');
    }
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

    if (this.isPresentationMode) {
      this.disableEditModeFeatures();
      this.editorToolbarEl?.classList.add('hidden');
    } else {
      if (this.isEditMode) {
        this.editorToolbarEl?.classList.remove('hidden');
        this.enableEditModeFeatures();
      }
    }

    window.electronAPI.setWindowedPresentation(this.isPresentationMode);
    window.dispatchEvent(new Event('resize'));
  }

  async toggleFullscreen(): Promise<void> {
    const isFs = await window.electronAPI.toggleFullscreen();
    this.isPresentationMode = isFs;
    document.body.classList.toggle('mode-presentation', isFs);
    this.floatingControlsEl.classList.toggle('hidden', !isFs);

    if (this.isPresentationMode) {
      this.disableEditModeFeatures();
      this.editorToolbarEl?.classList.add('hidden');
    } else {
      if (this.isEditMode) {
        this.editorToolbarEl?.classList.remove('hidden');
        this.enableEditModeFeatures();
      }
    }

    window.dispatchEvent(new Event('resize'));
  }

  exitPresentationMode(): void {
    this.isPresentationMode = false;
    document.body.classList.remove('mode-presentation');
    this.floatingControlsEl.classList.add('hidden');
    window.electronAPI.setWindowedPresentation(false);

    if (this.isEditMode) {
      this.editorToolbarEl?.classList.remove('hidden');
      this.enableEditModeFeatures();
    }

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
    console.log(`[NeoEditor] toggleEditMode -> isEditMode is now: ${this.isEditMode}`);
    const btnToggle = document.getElementById('btn-toggle-edit-mode');
    const labelToggle = document.getElementById('label-toggle-edit');
    const btnSave = document.getElementById('btn-save-slide');

    if (this.isEditMode) {
      this.editorToolbarEl?.classList.remove('hidden');
      if (labelToggle) labelToggle.textContent = 'Test Scripts';
      if (btnToggle) {
        btnToggle.title = 'Switch to Interactive Script Test Mode (Ctrl+E)';
        btnToggle.classList.remove('active');
        btnToggle.style.backgroundColor = '';
        btnToggle.style.color = '';
      }
      btnSave?.classList.remove('hidden');
      this.enableEditModeFeatures();
    } else {
      this.editorToolbarEl?.classList.add('hidden');
      if (labelToggle) labelToggle.textContent = 'Edit Slide';
      if (btnToggle) {
        btnToggle.title = 'Switch to Slide Authoring / Edit Mode (Ctrl+E)';
        btnToggle.classList.add('active');
        btnToggle.style.backgroundColor = 'var(--accent-primary)';
        btnToggle.style.color = '#fff';
      }
      btnSave?.classList.add('hidden');
      this.disableEditModeFeatures();
    }
  }

  private enableEditModeFeatures(): void {
    let doc: Document | null = null;
    try {
      doc = this.slideFrameEl.contentDocument;
    } catch (e: any) {
      console.error(`[NeoEditor] Cannot read contentDocument:`, e.message);
    }
    if (!doc) {
      console.warn(`[NeoEditor] enableEditModeFeatures: contentDocument is null!`);
      return;
    }

    console.log(`[NeoEditor] enableEditModeFeatures: Applying to document "${doc.title}"...`);

    // Make text elements contenteditable
    const textElements = doc.querySelectorAll(
      'p, h1, h2, h3, h4, h5, h6, li, span, a, b, strong, em, i, u, label, button, th, td, blockquote, figcaption, .badge, [class*="title"], [class*="desc"], [class*="subtitle"], [class*="header"], [class*="text"], [class*="card"], [class*="label"], [class*="pill"], [class*="stat"], [class*="kicker"], [class*="category"], [class*="note"], .tb, .textbox'
    );
    console.log(`[NeoEditor] Found ${textElements.length} editable text elements.`);
    textElements.forEach(el => {
      (el as HTMLElement).setAttribute('contenteditable', 'true');
      (el as HTMLElement).classList.add('editor-editable-text');
    });

    // Calculate scale factor using bounding boxes as requested
    const scaleFactor = this.slideFrameEl.getBoundingClientRect().width / this.slideFrameEl.offsetWidth;
    this.currentScaleFactor = scaleFactor;

    // Make positioned elements draggable
    const positionedElements = doc.querySelectorAll('.abs, .tb, img, .pic, .editor-draggable, [style*="position: absolute"], [style*="position: fixed"]');
    console.log(`[NeoEditor] Found ${positionedElements.length} positioned draggable elements.`);
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

        const onMouseUp = (_upEvent: MouseEvent) => {
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

    // Intercept clicks in edit mode so slide scripts don't conflict with text editing
    const onEditClickCapture = (e: MouseEvent) => {
      if (!this.isEditMode) return;
      const target = e.target as HTMLElement;
      if (target && target.closest('.editor-editable-text')) {
        e.stopPropagation();
      }
    };
    (doc as any)._onEditClickCapture = onEditClickCapture;
    doc.addEventListener('click', onEditClickCapture, true);

    // Track active selection and element for formatting toolbar and selection handles
    const onSelectionOrFocus = () => {
      const sel = doc.defaultView?.getSelection();
      if (sel && sel.rangeCount > 0) {
        this.currentSelectedRange = sel.getRangeAt(0).cloneRange();
      }
      const active = doc.activeElement as HTMLElement;
      if (active && (active.isContentEditable || active.classList.contains('editor-editable-text') || active.classList.contains('editor-draggable'))) {
        this.currentActiveElement = active;
        this.renderSelectionOverlay(active);
      }
    };
    (doc as any)._onSelectionOrFocus = onSelectionOrFocus;
    doc.addEventListener('selectionchange', onSelectionOrFocus);
    doc.addEventListener('mouseup', onSelectionOrFocus);
    doc.addEventListener('keyup', onSelectionOrFocus);
    doc.addEventListener('focusin', onSelectionOrFocus);
    doc.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const editable = target.closest('.editor-editable-text, .editor-draggable, .tb, p, h1, h2, h3, h4, h5, h6, span, div') as HTMLElement;
      if (editable && editable !== doc.body && editable !== doc.documentElement) {
        this.currentActiveElement = editable;
        this.renderSelectionOverlay(editable);
      }
    });

    // Inject temporary styles for outlines and drag/resize handles
    let styleEl = doc.getElementById('neo-editor-styles');
    if (!styleEl) {
      styleEl = doc.createElement('style');
      styleEl.id = 'neo-editor-styles';
      styleEl.textContent = `
        .editor-editable-text { outline: 1px dashed rgba(56, 189, 248, 0.4) !important; cursor: text !important; }
        .editor-editable-text:focus { outline: 2px solid #38bdf8 !important; background: rgba(56, 189, 248, 0.08) !important; }
        .editor-draggable { cursor: move; }
        .neo-move-handle {
          position: absolute;
          top: -30px;
          left: 0;
          background: #0284c7;
          color: #ffffff;
          padding: 3px 8px;
          font-size: 11px;
          font-weight: 700;
          border-radius: 4px;
          cursor: move;
          pointer-events: auto;
          display: flex;
          align-items: center;
          gap: 4px;
          user-select: none;
          box-shadow: 0 2px 6px rgba(0,0,0,0.5);
          white-space: nowrap;
          z-index: 100000;
        }
        .neo-move-handle:hover { background: #0ea5e9; }
        .neo-resize-handle {
          position: absolute;
          width: 10px;
          height: 10px;
          background: #ffffff;
          border: 2px solid #0284c7;
          border-radius: 2px;
          pointer-events: auto;
          box-shadow: 0 1px 4px rgba(0,0,0,0.5);
          z-index: 100000;
          transition: transform 0.1s ease;
        }
        .neo-resize-handle:hover {
          background: #0284c7;
          border-color: #ffffff;
          transform: scale(1.25);
        }
        .neo-rh-nw { top: -6px; left: -6px; cursor: nwse-resize; }
        .neo-rh-n  { top: -6px; left: calc(50% - 5px); cursor: ns-resize; }
        .neo-rh-ne { top: -6px; right: -6px; cursor: nesw-resize; }
        .neo-rh-e  { top: calc(50% - 5px); right: -6px; cursor: ew-resize; }
        .neo-rh-se { bottom: -6px; right: -6px; cursor: nwse-resize; }
        .neo-rh-s  { bottom: -6px; left: calc(50% - 5px); cursor: ns-resize; }
        .neo-rh-sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
        .neo-rh-w  { top: calc(50% - 5px); left: -6px; cursor: ew-resize; }
      `;
      doc.head.appendChild(styleEl);
    }
    console.log(`[NeoEditor] Outlines and editor styles injected successfully.`);
  }

  private renderSelectionOverlay(targetEl: HTMLElement): void {
    const doc = this.slideFrameEl.contentDocument;
    if (!doc || !this.isEditMode) return;
    if (targetEl === doc.body || targetEl === doc.documentElement) return;

    let overlay = doc.getElementById('neo-selection-overlay') as HTMLElement;
    if (!overlay) {
      overlay = doc.createElement('div');
      overlay.id = 'neo-selection-overlay';
      doc.body.appendChild(overlay);
    }

    const rect = targetEl.getBoundingClientRect();
    const bodyRect = doc.body.getBoundingClientRect();
    const left = rect.left - bodyRect.left;
    const top = rect.top - bodyRect.top;
    const width = rect.width;
    const height = rect.height;

    overlay.style.cssText = `
      position: absolute;
      left: ${left}px;
      top: ${top}px;
      width: ${width}px;
      height: ${height}px;
      border: 2px solid #0284c7;
      pointer-events: none;
      z-index: 99999;
      box-sizing: border-box;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4);
    `;

    overlay.innerHTML = `
      <div class="neo-move-handle" title="Drag to move text box / element">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>
        <span>Move</span>
      </div>
      <div class="neo-resize-handle neo-rh-nw" data-dir="nw" title="Resize"></div>
      <div class="neo-resize-handle neo-rh-n" data-dir="n" title="Resize"></div>
      <div class="neo-resize-handle neo-rh-ne" data-dir="ne" title="Resize"></div>
      <div class="neo-resize-handle neo-rh-e" data-dir="e" title="Resize"></div>
      <div class="neo-resize-handle neo-rh-se" data-dir="se" title="Resize"></div>
      <div class="neo-resize-handle neo-rh-s" data-dir="s" title="Resize"></div>
      <div class="neo-resize-handle neo-rh-sw" data-dir="sw" title="Resize"></div>
      <div class="neo-resize-handle neo-rh-w" data-dir="w" title="Resize"></div>
    `;

    const moveHandle = overlay.querySelector('.neo-move-handle') as HTMLElement;
    if (moveHandle) {
      moveHandle.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const style = doc.defaultView?.getComputedStyle(targetEl);

        let startLeft = parseFloat(style?.left || `${left}`);
        let startTop = parseFloat(style?.top || `${top}`);

        if (style?.position !== 'absolute' && style?.position !== 'fixed') {
          targetEl.style.position = 'absolute';
          startLeft = left;
          startTop = top;
          targetEl.style.left = `${startLeft}px`;
          targetEl.style.top = `${startTop}px`;
        }

        const onMouseMove = (me: MouseEvent) => {
          me.preventDefault();
          const dx = (me.clientX - startX) / this.currentScaleFactor;
          const dy = (me.clientY - startY) / this.currentScaleFactor;

          const newLeft = startLeft + dx;
          const newTop = startTop + dy;

          targetEl.style.left = `${newLeft}px`;
          targetEl.style.top = `${newTop}px`;

          overlay.style.left = `${left + dx}px`;
          overlay.style.top = `${top + dy}px`;
        };

        const onMouseUp = () => {
          doc.removeEventListener('mousemove', onMouseMove, true);
          doc.removeEventListener('mouseup', onMouseUp, true);
          this.renderSelectionOverlay(targetEl);
        };

        doc.addEventListener('mousemove', onMouseMove, true);
        doc.addEventListener('mouseup', onMouseUp, true);
      });
    }

    // Attach resize listeners
    overlay.querySelectorAll('.neo-resize-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const dir = (handle as HTMLElement).dataset.dir || 'se';
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = targetEl.offsetWidth;
        const startH = targetEl.offsetHeight;
        const style = doc.defaultView?.getComputedStyle(targetEl);
        const startL = parseFloat(style?.left || `${left}`) || left;
        const startT = parseFloat(style?.top || `${top}`) || top;

        if (style?.position !== 'absolute' && style?.position !== 'fixed') {
          targetEl.style.position = 'absolute';
          targetEl.style.left = `${startL}px`;
          targetEl.style.top = `${startT}px`;
        }

        const onResizeMove = (me: MouseEvent) => {
          me.preventDefault();
          const dx = (me.clientX - startX) / this.currentScaleFactor;
          const dy = (me.clientY - startY) / this.currentScaleFactor;

          let newW = startW;
          let newH = startH;
          let newL = startL;
          let newT = startT;

          if (dir.includes('e')) newW = Math.max(40, startW + dx);
          if (dir.includes('s')) newH = Math.max(20, startH + dy);
          if (dir.includes('w')) {
            newW = Math.max(40, startW - dx);
            newL = startL + (startW - newW);
          }
          if (dir.includes('n')) {
            newH = Math.max(20, startH - dy);
            newT = startT + (startH - newH);
          }

          targetEl.style.width = `${newW}px`;
          targetEl.style.height = `${newH}px`;
          targetEl.style.left = `${newL}px`;
          targetEl.style.top = `${newT}px`;

          overlay.style.width = `${newW}px`;
          overlay.style.height = `${newH}px`;
          overlay.style.left = `${newL}px`;
          overlay.style.top = `${newT}px`;
        };

        const onResizeUp = () => {
          doc.removeEventListener('mousemove', onResizeMove, true);
          doc.removeEventListener('mouseup', onResizeUp, true);
          this.renderSelectionOverlay(targetEl);
        };

        doc.addEventListener('mousemove', onResizeMove, true);
        doc.addEventListener('mouseup', onResizeUp, true);
      });
    });
  }

  private disableEditModeFeatures(): void {
    console.log(`[NeoEditor] disableEditModeFeatures called.`);
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    const overlay = doc.getElementById('neo-selection-overlay');
    if (overlay) overlay.remove();

    if ((doc as any)._onEditClickCapture) {
      doc.removeEventListener('click', (doc as any)._onEditClickCapture, true);
      delete (doc as any)._onEditClickCapture;
    }

    if ((doc as any)._onSelectionOrFocus) {
      doc.removeEventListener('selectionchange', (doc as any)._onSelectionOrFocus);
      doc.removeEventListener('mouseup', (doc as any)._onSelectionOrFocus);
      doc.removeEventListener('keyup', (doc as any)._onSelectionOrFocus);
      doc.removeEventListener('focusin', (doc as any)._onSelectionOrFocus);
      delete (doc as any)._onSelectionOrFocus;
    }

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

  // --- WYSIWYG Editor Actions ---

  addNewTextBox(): void {
    if (!this.isEditMode) {
      this.toggleEditMode();
    }
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    const tb = doc.createElement('div');
    tb.className = 'tb abs editor-editable-text editor-draggable';

    // Staggered positioning
    const left = 160 + (Math.floor(Math.random() * 6) * 40);
    const top = 160 + (Math.floor(Math.random() * 6) * 40);

    tb.style.position = 'absolute';
    tb.style.left = `${left}px`;
    tb.style.top = `${top}px`;
    tb.style.fontSize = '2.5rem';
    tb.style.fontWeight = '600';
    tb.style.color = '#38bdf8';
    tb.style.fontFamily = 'system-ui, -apple-system, sans-serif';
    tb.style.padding = '8px 16px';
    tb.style.minWidth = '240px';
    tb.style.minHeight = '48px';
    tb.style.boxSizing = 'border-box';
    tb.style.zIndex = '100';
    tb.setAttribute('contenteditable', 'true');
    tb.textContent = 'Click to edit text';

    doc.body.appendChild(tb);
    this.currentActiveElement = tb;

    // Refresh editing capabilities for the newly added element
    this.enableEditModeFeatures();

    // Focus and select text in the new text box
    tb.focus();
    const range = doc.createRange();
    range.selectNodeContents(tb);
    const sel = doc.defaultView?.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
      this.currentSelectedRange = range.cloneRange();
    }
  }

  setFontSize(size: string): void {
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    // If text inside iframe is actively selected, format or wrap selection
    const sel = doc.defaultView?.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const span = doc.createElement('span');
      span.style.fontSize = size;
      try {
        span.appendChild(range.extractContents());
        range.insertNode(span);
        return;
      } catch (_) {}
    }

    if (this.currentActiveElement) {
      this.currentActiveElement.style.fontSize = size;
    }
  }

  adjustFontSize(direction: number): void {
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    const targetEl = this.currentActiveElement || (doc.activeElement as HTMLElement);
    if (!targetEl || targetEl === doc.body || targetEl === doc.documentElement) return;

    const compStyle = doc.defaultView?.getComputedStyle(targetEl);
    const currentPx = parseFloat(compStyle?.fontSize || '28') || 28;
    const newPx = Math.max(10, Math.min(240, Math.round(currentPx + (direction * 4))));

    targetEl.style.fontSize = `${newPx}px`;

    const select = document.getElementById('select-font-size') as HTMLSelectElement;
    if (select) {
      select.value = `${newPx / 16}rem`;
    }
  }

  setFontColor(color: string): void {
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    // If text is selected in slide
    const sel = doc.defaultView?.getSelection();
    if (sel && !sel.isCollapsed) {
      doc.execCommand('styleWithCSS', false, 'true');
      doc.execCommand('foreColor', false, color);
    }

    if (this.currentActiveElement) {
      this.currentActiveElement.style.color = color;
    }

    const inputColor = document.getElementById('input-font-color') as HTMLInputElement;
    if (inputColor && color.startsWith('#')) {
      inputColor.value = color;
    }
  }

  formatText(command: 'bold' | 'italic' | 'underline'): void {
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    if (this.currentSelectedRange) {
      const sel = doc.defaultView?.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(this.currentSelectedRange);
      }
    }

    doc.execCommand(command);
  }

  deleteSelectedElement(): void {
    const doc = this.slideFrameEl.contentDocument;
    if (!doc) return;

    if (this.currentActiveElement && this.currentActiveElement !== doc.body && this.currentActiveElement !== doc.documentElement) {
      this.currentActiveElement.remove();
      this.currentActiveElement = null;
    }
  }

  private async saveSlideHtml(): Promise<void> {
    if (!this.manifest || !this.manifest.slides[this.currentIndex]) return;
    console.log(`[NeoEditor] saveSlideHtml: saving slide index ${this.currentIndex}...`);
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

    const overlayEl = clone.querySelector('#neo-selection-overlay');
    if (overlayEl) overlayEl.remove();

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
      // Ensure the thumbnail in sidebar is updated after saving
      const currentItem = this.slidesListEl.children[this.currentIndex];
      if (currentItem) {
        const frame = currentItem.querySelector('.slide-item-preview-frame') as HTMLIFrameElement;
        if (frame) {
          frame.src = `neopres://deck/${currentSlide.path}?t=${Date.now()}`;
        }
      }
      this.syncPresenterState();
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
