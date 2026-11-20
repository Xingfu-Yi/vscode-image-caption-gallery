(() => {
  const vscode = acquireVsCodeApi();
  const galleryView = document.querySelector('#gallery-view');
  const detailView = document.querySelector('#detail-view');
  const gallery = document.querySelector('#gallery');
  const empty = document.querySelector('#empty');
  const search = document.querySelector('#search');
  const sizeInput = document.querySelector('#thumbnail-size');
  const sizeValue = document.querySelector('#thumbnail-size-value');
  const count = document.querySelector('#count');
  const imageStage = document.querySelector('#image-stage');
  let detailImage = document.querySelector('#detail-image');
  const detailVideo = document.querySelector('#detail-video');
  let videoStream = null;
  const videoToolbar = document.querySelector('#video-toolbar');
  const videoQuality = document.querySelector('#video-quality');
  const videoQualityInfo = document.querySelector('#video-quality-info');
  const videoFeedback = document.querySelector('#video-feedback');
  const videoFeedbackMessage = document.querySelector('#video-feedback-message');
  const videoFallback = document.querySelector('#video-fallback');
  const videoPlaybackInfo = document.querySelector('#video-playback-info');
  const mediaKindLabel = document.querySelector('#media-kind-label');
  let currentMediaKind = 'image';
  const detailPath = document.querySelector('#detail-path');
  const imageWidth = document.querySelector('#image-width');
  const imageHeight = document.querySelector('#image-height');
  const detailDimensions = document.querySelector('#detail-dimensions');
  const resetImageZoom = document.querySelector('#reset-image-zoom');
  const captionPane = document.querySelector('.caption-pane');
  const captionPreview = document.querySelector('#caption-preview');
  const captionEditor = document.querySelector('#caption-editor');
  const captionMode = document.querySelector('#caption-mode');
  const splitter = document.querySelector('#splitter');
  const textZoom = document.querySelector('#text-zoom');
  const editingLabel = document.querySelector('#editing-label');
  const editState = document.querySelector('#edit-state');
  const editCaption = document.querySelector('#edit-caption');
  const editActions = document.querySelector('#edit-actions');
  const cancelEdit = document.querySelector('#cancel-edit');
  const saveEdit = document.querySelector('#save-edit');
  const toggleCaption = document.querySelector('#toggle-caption');
  const detailToggleCaption = document.querySelector('#detail-toggle-caption');
  const videoFocusButton = document.querySelector('#video-focus');
  const videoFocusControls = document.querySelector('#video-focus-controls');
  const videoRateSelect = document.querySelector('#video-playback-rate');
  let videoFocused = false;
  let captionBeforeFocus = false;
  let windowFullscreenPending = false, browserOpening = null, videoRecoveryAttempts = 0;
  let applyingVideoRate = false;
  const imageStatus = document.querySelector('#image-status');
  const imageStatusMessage = document.querySelector('#image-status-message');
  const loadOriginal = document.querySelector('#load-original');
  const previewRequests = new Map();
  let previewSequence = 0;
  let currentImageDimensions = null;
  let currentCaptionToken = '';
  // Neighbours are speculative; recently decoded images remain in a bounded LRU.
  const detailEntries = new Map();
  let comparison = null, comparisonIds = [], comparisonBytes = 0, comparisonOpening = '';
  let comparisonValidationTimer;
  let selectedImages = [];
  let comparisonStartTimer = 0;
  const captionRequests = new Map();
  let neighborFrame = 0;
  let detailClock = 0, switchStarted = 0, loadingTimer = 0;
  let transitionImage = null, selectedThumbnail = '';
  const transitionLabel = document.createElement('span');
  transitionLabel.className = 'switch-label hidden'; imageStage.append(transitionLabel);
  let refreshDetail = false;


  const persisted = vscode.getState() || {};
  let videoPlaybackRate = validPlaybackRate(persisted.videoPlaybackRate) ? persisted.videoPlaybackRate : 1;
  let configuredSettings = {};
  try { configuredSettings = JSON.parse(document.body.dataset.gallerySettings || '{}'); } catch { /* Fall back to defaults. */ }
  const savedSettings = persisted.gallerySettings || {};
  const gallerySettings = {
    resolution: validResolution(savedSettings.resolution) ? savedSettings.resolution : validResolution(configuredSettings.resolution) ? configuredSettings.resolution : 2048,
    videoMaxHeight: normalizeVideoQuality(savedSettings.videoQualityVersion === 1 ? savedSettings.videoMaxHeight : configuredSettings.videoMaxHeight),
    videoQualityVersion: 1,
    videoCompatibility: ['auto', 'native'].includes(savedSettings.videoCompatibility) ? savedSettings.videoCompatibility : configuredSettings.videoCompatibility === 'native' ? 'native' : 'auto',
    ffmpegPath: validFfmpegPath(savedSettings.ffmpegPath) ? savedSettings.ffmpegPath : validFfmpegPath(configuredSettings.ffmpegPath) ? configuredSettings.ffmpegPath : 'ffmpeg',
  };
  const settingsDialog = document.querySelector('#settings-dialog');
  const settingsToggles = [...document.querySelectorAll('.settings-toggle')];
  const resolutionSelect = document.querySelector('#preview-resolution');
  const customResolution = document.querySelector('#custom-resolution');
  const sensitivityInput = document.querySelector('#zoom-sensitivity');
  const layoutSelect = document.querySelector('#pane-layout');
  const paneSplit = document.querySelector('#pane-split');
  const imageZoomInput = document.querySelector('#image-zoom-input');
  const ffmpegInput = document.querySelector('#ffmpeg-path');
  const settingsStatus = document.querySelector('#settings-status');
  const concurrencySelect = document.querySelector('#preview-concurrency');
  const previewPerformance = document.querySelector('#preview-performance');
  concurrencySelect.value = String(configuredSettings.concurrency || 0);
  const executionSelect = document.querySelector('#preview-execution-mode');
  executionSelect.value = configuredSettings.executionMode === 'thread' ? 'thread' : 'process';
  let settingsOpener;
  let paneLayout = ['auto', 'side', 'stacked'].includes(persisted.paneLayout) ? persisted.paneLayout : 'auto';
  detailView.dataset.layout = paneLayout;
  const defaultSize = Number(document.body.dataset.defaultThumbnailSize || 220);
  let images = [];
  let filteredImages = [];
  let filteredIndex = new Map();
  let searchTimer;
  let scrollTimer;
  const thumbnailQueue = new Map();
  const activeThumbnails = new Set();
  let thumbnailPumpScheduled = false;
  let thumbnailConcurrency = 4;
  let panelVisible = true;
  let scanning = false;
  let containsVideo = false;
  let incomingImages = [];
  let incomingScan;
  let receivedBatch = false;
  const grid = new window.GalleryGrid(gallery, galleryView, createCard, releaseCard, () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(persistState, 150);
  });
  let restoreScroll = Number(persisted.galleryScrollTop) || 0;
  let currentIndex = -1;
  let currentCaptionRequest = '';
  let captionText = '';
  let renderedCaption = '';
  let captionExists = false;
  let captionRevision = 'missing';
  let captionLoaded = false;
  let isEditing = false;
  let isSaving = false;
  let pendingCaptionEditId = '';
  let lastReportedDirty = false;
  let pendingAction = null;
  let activeDecisionRequest = '';
  let decisionSequence = 0;
  let copySequence = 0;
  const fileCopies = new Map();
  const fileMenu = new window.GalleryFileMenu({ root: document.body, language: document.body.dataset.uiLanguage,
    resolveTarget: event => {
      const card = event.target.closest?.('.image-card');
      if (card && !galleryView.classList.contains('hidden')) {
        cancelComparisonStart();
        return images.find(image => image.id === card.dataset.mediaId);
      }
      const keyboard = event.type === 'keydown' && event.target === detailView;
      if (detailView.classList.contains('hidden') || (!keyboard && !event.target.closest?.('#image-stage, #detail-path'))) return null;
      if ((keyboard || imageStage.contains(event.target)) && !isCurrentVideo() && transitionImage) {
        const retained = [...detailEntries.values()].find(entry => entry.target === transitionImage);
        if (retained) return images.find(image => image.id === retained.id);
      }
      return images.find(image => image.id === currentCaptionRequest);
    }, copy: copyFilePath });

  function copyFilePath(record) {
    return new Promise((resolve, reject) => {
      const requestId = `copy-path-${++copySequence}`;
      const timer = setTimeout(() => { fileCopies.delete(requestId); reject(new Error('Copying the file path timed out.')); }, 10000);
      fileCopies.set(requestId, { id: record.id, resolve, reject, timer });
      vscode.postMessage({ type: 'copyFilePath', id: record.id, requestId });
    });
  }
  let splitRatio = clamp(Number(persisted.splitRatio) || 0.64, 0.3, 0.8);
  let textPaneHidden = typeof persisted.textPaneHidden === 'boolean'
    ? persisted.textPaneHidden
    : document.body.dataset.showCaption === 'false';
  let imageZoomPercent = 100;
  let imageZoomSensitivity = clamp(Number(persisted.zoomSensitivity ?? document.body.dataset.zoomSensitivity) || 5, 0.5, 10);
  let imagePanX = 0;
  let imagePanY = 0;
  let imagePanGesture = null;
  let imageResizeObserver = null;
  let textZoomPercent = clamp(Number(persisted.textZoomPercent) || 100, 70, 180);
  const thumbnailObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(loadVisibleThumbnails, { root: galleryView, rootMargin: '250px 0px' })
    : null;

  sizeInput.value = String(persisted.thumbnailSize || defaultSize);
  search.value = persisted.search || '';
  captionMode.value = ['markdown', 'raw', 'json'].includes(persisted.captionMode)
    ? persisted.captionMode
    : 'markdown';
  textZoom.value = String(textZoomPercent);
  applyThumbnailSize();
  applySplitRatio(splitRatio, false);
  applyTextZoom();
  setTextPaneHidden(textPaneHidden, false);
  updateEditControls();
  syncSettingsControls();

  settingsToggles.forEach((button) => button.addEventListener('click', () => openSettings(button)));
  document.querySelector('#close-settings').addEventListener('click', closeSettings);
  settingsDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeSettings(); });
  settingsDialog.addEventListener('close', () => settingsToggles.forEach((button) => button.setAttribute('aria-expanded', 'false')));
  settingsDialog.addEventListener('click', (event) => {
    const rect = settingsDialog.getBoundingClientRect();
    if (event.target === settingsDialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) { closeSettings(); }
  });
  document.querySelector('#open-default-settings').addEventListener('click', () => {
    closeSettings(); vscode.postMessage({ type: 'openDefaultSettings' });
  });
  resolutionSelect.addEventListener('change', () => {
    document.querySelector('#custom-resolution-field').classList.toggle('hidden', resolutionSelect.value !== 'custom');
    if (resolutionSelect.value === 'custom') { customResolution.focus(); return; }
    changeResolution(Number(resolutionSelect.value));
  });
  customResolution.addEventListener('change', () => {
    const value = Number(customResolution.value);
    if (customResolution.value.trim() && validResolution(value)) { changeResolution(value); }
    else { customResolution.setAttribute('aria-invalid', 'true'); settingsStatus.textContent = document.body.dataset.uiLanguage === 'zh' ? '请输入 0–65536 之间的整数。' : 'Enter a whole number from 0 to 65536.'; }
  });
  sensitivityInput.addEventListener('input', () => {
    imageZoomSensitivity = clamp(Number(sensitivityInput.value) || 5, 0.5, 10);
    document.querySelector('#zoom-sensitivity-value').textContent = `${imageZoomSensitivity}×`;
    persistState();
  });
  imageZoomInput.addEventListener('input', () => applyImageZoom(Number(imageZoomInput.value)));
  layoutSelect.addEventListener('change', () => {
    paneLayout = layoutSelect.value; detailView.dataset.layout = paneLayout;
    syncPaneControls(); persistState(); requestAnimationFrame(updateImageTransform);
  });
  paneSplit.addEventListener('input', () => applySplitRatio(Number(paneSplit.value) / 100));
  document.querySelector('#video-compatibility').addEventListener('change', (event) => {
    gallerySettings.videoCompatibility = event.target.value; persistState(); reloadCurrentVideo();
  });
  videoRateSelect.addEventListener('change', () => {
    if (validPlaybackRate(Number(videoRateSelect.value))) { videoPlaybackRate = Number(videoRateSelect.value); applyVideoRate(); persistState(); }
  });
  videoFocusButton.addEventListener('click', openBrowserMedia);
  document.querySelector('#image-browser-fullscreen').addEventListener('click', () => { closeSettings(); openBrowserMedia(); });
  document.querySelector('#video-focus-settings').addEventListener('click', () => { closeSettings(); requestVideoFocus(); });
  document.querySelector('#exit-video-focus').addEventListener('click', () => setVideoFocus(false));
  for (const button of document.querySelectorAll('#video-window-fullscreen, #focus-window-fullscreen')) { button.addEventListener('click', openBrowserMedia); }

  for (const select of [videoQuality, document.querySelector('#video-max-height')]) { select.addEventListener('change', (event) => {
    gallerySettings.videoMaxHeight = normalizeVideoQuality(Number(event.target.value)); gallerySettings.videoCompatibility = 'auto';
    syncSettingsControls(); persistState(); reloadCurrentVideo();
  }); }
  ffmpegInput.addEventListener('change', () => {
    const value = ffmpegInput.value.trim();
    if (!validFfmpegPath(value)) { ffmpegInput.setAttribute('aria-invalid', 'true'); settingsStatus.textContent = document.body.dataset.uiLanguage === 'zh' ? '请填写 FFmpeg 命令或可执行文件路径。' : 'Enter an FFmpeg command or executable path.'; return; }
    ffmpegInput.removeAttribute('aria-invalid'); settingsStatus.textContent = '';
    gallerySettings.ffmpegPath = value; persistState(); reloadCurrentVideo();
  });

  executionSelect.addEventListener('change', () => vscode.postMessage({ type: 'setPreviewExecutionMode', mode: executionSelect.value }));
  concurrencySelect.addEventListener('change', () => vscode.postMessage({ type: 'setPreviewConcurrency', concurrency: Number(concurrencySelect.value) }));

  sizeInput.addEventListener('input', applyThumbnailSize);
  search.addEventListener('input', () => {
    clearComparisonSelection();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderGallery(true), 120);
  });
  document.querySelector('#refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
  document.querySelector('#compare-selected').addEventListener('click', enterComparison);
  document.querySelector('#clear-comparison').addEventListener('click', clearComparisonSelection);
  document.querySelector('#comparison-help').addEventListener('click', () => {
    document.querySelector('#browser-status').textContent = uiText('Ctrl / ⌘ click two images to compare. Hold Space to show B on the left; release to restore. Esc returns to Gallery with A/B selected; press Esc again to clear.', 'Ctrl / ⌘ 点击两张图片进入对比。按住空格左侧显示 B，松开恢复；Esc 返回 Gallery 并保留 A/B，再按一次 Esc 清空选择。');
  });
  document.querySelector('#back').addEventListener('click', () => requestGuardedAction({ type: 'gallery' }));
  document.querySelector('#previous').addEventListener('click', () => requestGuardedAction({ type: 'move', offset: -1 }));
  document.querySelector('#next').addEventListener('click', () => requestGuardedAction({ type: 'move', offset: 1 }));
  document.querySelector('.image-pane').addEventListener('click', (event) => {
    if (event.target.closest('video, button, select, label')) { return; }
    detailView.focus({ preventScroll: true });
  });
  detailVideo.addEventListener('loadedmetadata', () => {
    if (!isCurrentVideo() || !detailVideo.hasAttribute('src')) { return; }
    restoreVideoPosition();
    applyVideoRate();
    const originalWidth = Number(detailVideo.dataset.originalWidth) || detailVideo.videoWidth;
    const originalHeight = Number(detailVideo.dataset.originalHeight) || detailVideo.videoHeight;
    imageWidth.textContent = String(originalWidth);
    imageHeight.textContent = String(originalHeight);
    document.querySelector('.image-dimensions').title = `Video: ${detailVideo.videoWidth} × ${detailVideo.videoHeight}`;
    detailDimensions.textContent = `${originalWidth} × ${originalHeight}${originalWidth !== detailVideo.videoWidth || originalHeight !== detailVideo.videoHeight ? ` · Preview ${detailVideo.videoWidth} × ${detailVideo.videoHeight}` : ''}`;
    detailDimensions.title = document.querySelector('.image-dimensions').title;
    updateVideoQualityInfo(originalWidth, originalHeight, detailVideo.videoWidth, detailVideo.videoHeight);
  });
  detailVideo.addEventListener('ratechange', () => {
    if (applyingVideoRate) { return; }
    if (validPlaybackRate(detailVideo.playbackRate)) {
      videoPlaybackRate = detailVideo.playbackRate;
      if (detailVideo.defaultPlaybackRate !== videoPlaybackRate) { detailVideo.defaultPlaybackRate = videoPlaybackRate; }
      syncVideoRate(); persistState();
    }
  });
  detailVideo.addEventListener('loadeddata', () => {
    if (isCurrentVideo() && detailVideo.hasAttribute('src')) { clearVideoLoading(); scheduleNeighborPreload(); }
  });
  for (const event of ['canplay', 'seeked']) { detailVideo.addEventListener(event, () => {
    if (isCurrentVideo() && detailVideo.hasAttribute('src') && detailVideo.readyState >= 2) { clearVideoLoading(); resumeVideoPlayback(); }
  }); }
  detailVideo.addEventListener('error', () => {
    if (isCurrentVideo() && detailVideo.hasAttribute('src')) {
      const error = detailVideo.error;
      const detail = [error?.message, detailVideo.dataset.streamError, error?.code ? `Media error ${error.code}` : ''].filter(Boolean).join(' · ');
      handleVideoFailure(`${uiText('Playback failed', '播放失败')}${detail ? `: ${detail}` : ''}`);
      console.error('Gallery video playback failed', { code: error?.code, detail, stream: detailVideo.dataset.stream });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelComparisonStart();
    if (document.hidden) { cancelVideoResume(); if (detailVideo.hasAttribute('src')) { detailVideo.pause(); videoStream?.suspend(); } }
    else if (!document.hidden) { videoStream?.resume(); }
  });
  window.addEventListener('blur', cancelComparisonStart);
  window.addEventListener('pagehide', () => { fileMenu.dispose(); for (const pending of fileCopies.values()) { clearTimeout(pending.timer); pending.reject(new Error('Gallery closed.')); } fileCopies.clear(); cancelComparisonStart(); clearInterval(comparisonValidationTimer); comparison?.dispose(); comparison = null; comparisonIds = []; stopVideo(); clearDetailEntries(); });
  window.addEventListener('focus', validateComparison);
  loadOriginal.addEventListener('click', (event) => {
    event.stopPropagation();
    const image = filteredImages[currentIndex];
    if (!image) { return; }
    if (!isCurrentVideo()) { requestPreview(detailImage, image.id, true, true); }
  });
  videoFallback.addEventListener('click', () => {
    const image = filteredImages[currentIndex]; if (!image || !isCurrentVideo()) { return; }
    const native = videoFallback.dataset.videoAction === 'native';
    requestVideo(image, !native, native, captureVideoPlayback());
  });
  toggleCaption.addEventListener('click', toggleTextPane);
  detailToggleCaption.addEventListener('click', toggleTextPane);
  imageStage.addEventListener('pointerdown', startImagePan);
  imageStage.addEventListener('pointermove', moveImagePan);
  imageStage.addEventListener('pointerup', finishImagePan);
  imageStage.addEventListener('pointercancel', finishImagePan);
  imageStage.addEventListener('dblclick', (event) => {
    if (isCurrentVideo()) { event.preventDefault(); openBrowserMedia(); } else { fitImageToPane(event); }
  });
  resetImageZoom.addEventListener('click', fitImageToPane);
  imageStage.addEventListener('wheel', handleImageWheel, { passive: false });
  captionMode.addEventListener('change', () => {
    renderCaptionView();
    persistState();
  });
  textZoom.addEventListener('change', applyTextZoom);
  captionEditor.addEventListener('input', updateDirtyState);
  editCaption.addEventListener('click', enterEditMode);
  cancelEdit.addEventListener('click', requestCancelEditing);
  saveEdit.addEventListener('click', saveCaption);
  splitter.addEventListener('pointerdown', startSplitResize);
  splitter.addEventListener('pointermove', resizeSplit);
  splitter.addEventListener('pointerup', finishSplitResize);
  splitter.addEventListener('pointercancel', finishSplitResize);
  splitter.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    applySplitRatio(splitRatio + (event.key === 'ArrowLeft' ? -0.02 : 0.02));
  });
  window.addEventListener('resize', () => {
    syncPaneControls();
    applySplitRatio(splitRatio, false);
    if (!detailView.classList.contains('hidden')) {
      requestAnimationFrame(updateImageTransform);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (fileMenu.menu) return;
    if (comparison) { return; }
    if (settingsDialog.open) {
      if (event.key === 'Escape') { event.preventDefault(); closeSettings(); }
      return;
    }
    if (detailView.classList.contains('hidden')) {
      if (event.key === 'Escape' && !event.repeat && selectedImages.length) { event.preventDefault(); clearComparisonSelection(); }
      return;
    }

    if (event.key === 'Escape' && videoFocused) { event.preventDefault(); setVideoFocus(false); return; }

    if (isEditing && (event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
      event.preventDefault();
      saveCaption();
      return;
    }

    if (isEditing && event.key === 'Escape') {
      event.preventDefault();
      requestCancelEditing();
      return;
    }

    const viewingShortcut = !isEditing && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && (!isTypingTarget(event.target) || event.target === detailVideo || event.target instanceof HTMLButtonElement);
    const editShortcut = viewingShortcut && !isTypingTarget(event.target);
    if (editShortcut && event.key.toLowerCase() === 'e') { event.preventDefault(); startCaptionEditingFromShortcut(); return; }
    if (viewingShortcut && event.key.toLowerCase() === 'c') { event.preventDefault(); toggleTextPane(); return; }
    if (viewingShortcut && event.key.toLowerCase() === 'f') { event.preventDefault(); openBrowserMedia(); return; }

    const navigationKey = !isTypingTarget(event.target)
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey;
    if (navigationKey && isCurrentVideo() && (event.code === 'Space' || event.key === ' ')) {
      event.preventDefault();
      toggleVideoPlayback();
    } else if (navigationKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      requestGuardedAction({ type: 'move', offset: -1 });
    } else if (navigationKey && event.key === 'ArrowRight') {
      event.preventDefault();
      requestGuardedAction({ type: 'move', offset: 1 });
    } else if (!isEditing && event.key === 'Escape') {
      event.preventDefault();
      requestGuardedAction({ type: 'gallery' });
    }
  });

  window.addEventListener('message', (event) => {
    if (event.data.type === 'filePathCopied') {
      const message = event.data, pending = fileCopies.get(message.requestId);
      if (!pending || pending.id !== message.id) return;
      clearTimeout(pending.timer); fileCopies.delete(message.requestId);
      if (message.copied) pending.resolve(); else pending.reject(new Error(message.error || 'Could not copy the file path.'));
      return;
    }
    const message = event.data;
    if (message.type === 'browserComparisonOpened') {
      if (message.requestId === comparisonOpening) {
        comparisonOpening = '';
        const button = comparison?.root.querySelector('[data-action=fullscreen]');
        if (button) { button.disabled = false; button.title = message.error || ''; }
        document.querySelector('#browser-status').textContent = message.error || '';
      }
      return;
    }
    if (message.type === 'browserVideoOpened' || message.type === 'browserImagesOpened') {
      if (!browserOpening || message.requestId !== browserOpening.requestId || message.id !== browserOpening.id) { return; }
      windowFullscreenPending = false; browserOpening = null;
      document.querySelector('#browser-status').textContent = message.error || '';
      videoFeedbackMessage.textContent = message.error || '';
      if (message.type === 'browserVideoOpened' && message.opened && currentCaptionRequest === message.id && isCurrentVideo()) { detailVideo.pause(); videoStream?.suspend(); cancelVideoResume(); }
      for (const id of ['video-control-status', 'video-focus-status']) { document.getElementById(id).textContent = message.error || ''; }
      syncVideoControls(); return;
    }
    if (message.type === 'windowFullscreenToggled') {
      windowFullscreenPending = false;
      document.querySelector('#video-control-status').textContent = message.error || '';
      document.querySelector('#video-focus-status').textContent = message.error || '';
      syncVideoControls(); return;
    }
    if (message.type === 'loading') {
      cancelComparisonStart();
      scanning = true;
      refreshDetail = !detailView.classList.contains('hidden');
      if (refreshDetail) { clearDetailEntries(currentCaptionRequest); }
      incomingImages = [];
      incomingScan = message.scanId;
      receivedBatch = false;
      empty.textContent = 'Loading media…';
      empty.classList.remove('hidden');
      return;
    }

    if (message.type === 'imageBatch') {
      if (!scanning || message.scanId !== incomingScan) { return; }
      if (!receivedBatch) {
        receivedBatch = true;
        if (detailView.classList.contains('hidden') && !comparison) {
          images = incomingImages;
          containsVideo = false;
          filteredImages = [];
          filteredIndex.clear();
          grid.setItems(filteredImages);
        }
      }
      const batchQuery = search.value.trim().toLocaleLowerCase();
      for (const image of message.images) {
        containsVideo ||= image.kind === 'video';
        image.searchPath = image.relativePath.toLocaleLowerCase();
        incomingImages.push(image);
        if (images === incomingImages && image.searchPath.includes(batchQuery)) {
          filteredIndex.set(image.id, filteredImages.length);
          filteredImages.push(image);
        }
      }
      if (images === incomingImages) { grid.setItems(filteredImages); updateGalleryCount(); }
      return;
    }

    if (message.type === 'images') {
      if (message.scanId !== undefined && incomingScan !== message.scanId) { return; }
      scanning = false;
      const activeImageId = detailView.classList.contains('hidden') ? '' : currentCaptionRequest;
      images = message.images || (message.order ? message.order.map((index) => incomingImages[index]) : incomingImages);
      for (const image of images) { image.searchPath ??= image.relativePath.toLocaleLowerCase(); }
      const selectedCount = selectedImages.length;
      selectedImages = selectedImages.filter(id => images.some(image => image.id === id && image.kind !== 'video'));
      if (selectedImages.length !== selectedCount) cancelComparisonStart();
      updateComparisonSelection();
      if (comparison) {
        if (comparisonIds.some(id => !selectedImages.includes(id))) { exitComparison(); }
        else { comparison.records = comparisonIds.map(id => images.find(image => image.id === id)); comparison.reload(); }
      }
      if (message.initialImageId) {
        search.value = '';
      }
      incomingImages = [];
      grid.clear();
      renderGallery();
      if (restoreScroll && detailView.classList.contains('hidden')) {
        galleryView.scrollTop = restoreScroll; grid.render();
      }
      restoreScroll = 0;
      const activeIndex = activeImageId
        ? (filteredIndex.get(activeImageId) ?? -1)
        : -1;
      if (activeIndex >= 0) {
        currentIndex = activeIndex;
        updateDetailMetadata();
        trimDetailEntries();
        if (refreshDetail) {
          if (!isCurrentVideo()) { requestPreview(detailImage, activeImageId, true); }
          if (!isEditing && !isSaving) { requestCurrentCaption(); }
        } else { scheduleNeighborPreload(); }
      } else if (message.initialImageId) {
        openDetail(message.initialImageId);
      }
      refreshDetail = false;
      return;
    }

    if (message.type === 'initialImage') {
      images = [message.image];
      search.value = '';
      renderGallery();
      openDetail(message.image.id);
      return;
    }

    if (message.type === 'previewPoolStatus') {
      thumbnailConcurrency = clamp((Number(message.workers) || 2) * 2, 4, 16);
      scheduleThumbnailPump();
      if (Number.isInteger(message.requested) && message.requested >= 0 && message.requested <= 8) { concurrencySelect.value = String(message.requested); }
      const chinese = document.body.dataset.uiLanguage === 'zh';
      if (['process', 'thread'].includes(message.mode)) { executionSelect.value = message.mode; }
      document.querySelector('#preview-pool-status').textContent = chinese ? `当前 ${message.workers} 个${message.backend === 'thread' ? '解码线程' : '解码进程'}` : `${message.workers} decoder ${message.backend === 'thread' ? 'threads' : 'processes'}`;
      return;
    }

    if (message.type === 'zoomConfigurationChanged') {
      imageZoomSensitivity = clamp(Number(message.sensitivity) || 5, 0.5, 10);
      syncSettingsControls();
      return;
    }

    if (message.type === 'previewProgress') {
      const pending = previewRequests.get(message.requestId);
      if (pending && pending.id === message.id && pending.target === detailImage && !pending.prefetch) { scheduleNeighborPreload(true); }
      return;
    }

    if (message.type === 'previewConfigurationChanged') {
      if (validResolution(message.resolution)) { gallerySettings.resolution = message.resolution; syncSettingsControls(); }
      reloadImagePreviews();
      return;
    }

    if (message.type === 'videoConfigurationChanged') {
      if (['auto', 'native'].includes(message.videoCompatibility)) { gallerySettings.videoCompatibility = message.videoCompatibility; }
      if (validFfmpegPath(message.ffmpegPath)) { gallerySettings.ffmpegPath = message.ffmpegPath; }
      if (message.videoMaxHeight !== undefined) { gallerySettings.videoMaxHeight = normalizeVideoQuality(message.videoMaxHeight); }
      syncSettingsControls(); reloadCurrentVideo();
      return;
    }

    if (message.type === 'videoProgress') {
      const pending = previewRequests.get(message.requestId);
      if (pending?.kind === 'video' && pending.id === message.id) {
        videoFeedbackMessage.textContent = `Preparing compatible video… ${Math.max(0, Math.min(99, Number(message.progress) || 0))}%`;
      }
      return;
    }

    if (message.type === 'panelVisibility') {
      panelVisible = message.visible;
      if (!panelVisible) cancelComparisonStart();
      if (comparison) {
        comparison.setVisible(panelVisible);
        if (panelVisible) validateComparison();
        return;
      }
      if (!panelVisible) { cancelVideoResume(); }
      if (!message.visible) {
        if (detailVideo.hasAttribute('src')) { detailVideo.pause(); }
        videoStream?.suspend();
        grid.suspend();
        clearDetailEntries(currentCaptionRequest);
      } else if (detailView.classList.contains('hidden')) { grid.resume(); }
      else { videoStream?.resume(); scheduleNeighborPreload(); }
      scheduleThumbnailPump();
      return;
    }

    if (message.type === 'videoPoster' || message.type === 'videoPosterError') {
      const pending = previewRequests.get(message.requestId);
      if (!pending || pending.kind !== 'poster' || pending.id !== message.id) { return; }
      if (message.type === 'videoPosterError') { failVideoPoster(pending.target, message.message || 'Could not extract the first frame.'); return; }
      pending.timing = message.timing;
      armPosterTimeout(pending.target, 5000, 'The first-frame image could not be displayed.');
      pending.target.src = message.source;
      return;
    }

    if (message.type === 'preview' || message.type === 'previewError' || message.type === 'previewSkipped' || message.type === 'previewInvalidated' || message.type === 'video' || message.type === 'videoError') {
      const pending = previewRequests.get(message.requestId);
      if (!pending || pending.id !== message.id) { return; }
      const entry = pending.detail && pending.kind !== 'video' ? detailEntries.get(pending.id) : null;
      if (message.type === 'previewInvalidated') {
        if (!entry) { return; }
        if (comparisonIds.includes(entry.id)) { comparison?.reload(comparisonIds.indexOf(entry.id)); return; }
        if (detailView.classList.contains('hidden')) { disposeDetailEntry(entry); return; }
        requestPreview(entry.target, entry.id, true, false, entry.target !== detailImage);
        return;
      }
      if (message.type === 'previewSkipped') {
        if (entry && comparisonIds.includes(entry.id)) { comparison?.reload(comparisonIds.indexOf(entry.id)); return; }
        if (entry && pending.target !== detailImage) { entry.skipped = true; releasePreview(pending.target); }
        else if (entry) { requestPreview(pending.target, pending.id, true); }
        return;
      }
      if (message.type === 'previewError' || message.type === 'videoError') {
        if (pending.kind === 'video') { showVideoError(`Could not load video: ${message.message}`); }
        else if (pending.detail) {
          if (entry) { entry.failed = true; settleImageWaiters(entry, new Error(message.message || 'Could not generate preview.')); }
          if (pending.target === detailImage) { showImageError(`Could not generate preview: ${message.message}`); }
        }
        else { failImageThumbnail(pending.target, message.message || 'Could not generate thumbnail.'); }
        return;
      }
      if (!pending.detail && pending.kind !== 'poster') {
        pending.timings = message.timings; pending.inlineBytes = message.inlineBytes; pending.resourceStarted = performance.now();
        armImageThumbnailTimeout(pending.target, 15000, 'Thumbnail display timed out.');
      }
      if (entry) { entry.dimensions = message; entry.resourceStarted = performance.now(); if (pending.target === detailImage) { scheduleNeighborPreload(true); } }
      if (pending.detail && pending.target === detailImage && pending.kind !== 'video') {
        currentImageDimensions = message;
        updateImageDimensions();
      }
      if (pending.kind === 'video') {
        pending.target.dataset.converted = String(Boolean(message.converted));
        videoPlaybackInfo.textContent = message.note || (message.stream ? uiText('Codec compatibility is processed only for requested fragments.', '仅按需转换所需片段以兼容编码。') : uiText('Playing the original file by byte range.', '按字节范围播放原文件。'));
        updateVideoQualityInfo(message.width, message.height, message.previewWidth || message.width, message.previewHeight || message.height);
        pending.target.poster = message.poster || '';
        pending.target.dataset.stream = String(Boolean(message.stream));
        pending.target.dataset.originalWidth = String(message.width || ''); pending.target.dataset.originalHeight = String(message.height || '');
        if (message.stream) {
          try {
            videoStream?.dispose();
            const stream = new window.GalleryVideoStream(pending.target, { ...message.stream, startTime: pending.restore?.time || 0 },
              (error) => { if (pending.target.dataset.previewRequest === message.requestId) { handleVideoFailure(`Could not stream video: ${error}`); } },
              () => { if (pending.target.dataset.previewRequest === message.requestId) { showVideoLoading(uiText('Buffering…', '缓冲中…')); } },
              diagnostics => { if (pending.target.dataset.previewRequest === message.requestId) { vscode.postMessage({ type: 'videoDiagnostic', id: pending.id, requestId: message.requestId, diagnostics }); } });
            videoStream = stream; stream.start();
            if (!panelVisible || document.hidden) { stream.suspend(); }
          } catch (error) { showVideoError(error.message); }
        } else { pending.target.src = message.source; pending.target.load(); }
      } else { pending.target.src = message.source; }
      return;
    }

    if (message.type === 'caption' || message.type === 'captionError') {
      const entry = captionRequests.get(message.requestId);
      if (!entry || entry.id !== message.id || textPaneHidden) { return; }
      captionRequests.delete(message.requestId);
      entry.captionToken = '';
      if (message.type === 'caption') { entry.caption = message; }
      if (detailView.classList.contains('hidden') || message.id !== currentCaptionRequest
        || message.requestId !== currentCaptionToken || isEditing || isSaving) { return; }
      const enterEditing = message.type === 'caption' && pendingCaptionEditId === message.id && !settingsDialog.open;
      if (pendingCaptionEditId === message.id) { pendingCaptionEditId = ''; }
      if (message.type === 'caption') {
        applyCaptionMessage(message);
        exitEditMode();
        if (enterEditing) { enterEditMode(); }
      }
      else if (!captionLoaded) {
        captionPreview.textContent = `Could not load caption: ${message.message}`;
        editCaption.disabled = true;
      }
      return;
    }

    if (message.id && message.id !== currentCaptionRequest) { return; }

    if (message.type === 'captionSaved') {
      const action = pendingAction;
      pendingAction = null;
      isSaving = false;
      applyCaptionMessage(message);
      exitEditMode();
      if (action) {
        performAction(action);
      }
      return;
    }

    if (message.type === 'captionReloaded') {
      pendingAction = null;
      isSaving = false;
      applyCaptionMessage(message);
      captionEditor.value = captionText;
      isEditing = true;
      updateEditControls();
      updateDirtyState();
      setEditStatus('Reloaded', false);
      captionEditor.focus({ preventScroll: true });
      return;
    }

    if (message.type === 'captionSaveCancelled') {
      isSaving = false;
      pendingAction = null;
      updateEditControls();
      setEditStatus(isCaptionDirty() ? 'Unsaved' : '', isCaptionDirty());
      return;
    }

    if (message.type === 'captionSaveError') {
      isSaving = false;
      pendingAction = null;
      updateEditControls();
      setEditStatus(`Save failed: ${message.message}`, true);
      return;
    }

    if (message.type === 'unsavedDecision' && message.requestId === activeDecisionRequest) {
      activeDecisionRequest = '';
      if (message.decision === 'save') {
        saveCaption();
      } else if (message.decision === 'discard') {
        const action = pendingAction;
        pendingAction = null;
        exitEditMode();
        if (action) {
          performAction(action);
        }
      } else {
        pendingAction = null;
      }
      return;
    }

    if (message.type === 'discardDecision' && message.requestId === activeDecisionRequest) {
      activeDecisionRequest = '';
      if (message.decision === 'discard') {
        exitEditMode();
      }
      return;
    }

    if (message.type === 'error') {
      if (message.scanId !== undefined && message.scanId !== incomingScan) { return; }
      scanning = false;
      updateGalleryCount();
      empty.textContent = `Could not load images: ${message.message}`;
      empty.classList.remove('hidden');
    }
  });

  function applyThumbnailSize() {
    const size = Number(sizeInput.value);
    document.documentElement.style.setProperty('--thumbnail-size', `${size}px`);
    sizeValue.value = `${size}px`;
    grid.setSize(size);
    persistState();
  }

  function renderGallery(resetScroll = false) {
    clearTimeout(searchTimer);
    const query = search.value.trim().toLocaleLowerCase();
    filteredImages = query ? images.filter((image) => (image.searchPath ??= image.relativePath.toLocaleLowerCase()).includes(query)) : images.slice();
    filteredIndex = new Map(filteredImages.map((image, index) => [image.id, index]));
    containsVideo = images.some((image) => image.kind === 'video');
    grid.setItems(filteredImages, resetScroll);
    updateGalleryCount();
    persistState();
  }

  function updateGalleryCount() {
    const noun = containsVideo ? 'files' : 'images';
    count.textContent = `${filteredImages.length} / ${images.length} ${noun}${scanning ? ' · scanning…' : ''}`;
    empty.textContent = scanning ? 'Discovering media…' : images.length === 0 ? 'No supported images or videos found.' : 'No matching media.';
    empty.classList.toggle('hidden', filteredImages.length > 0);
    syncVideoControls();
  }

  function createCard(image) {
    const card = document.createElement('button');
    card.className = 'image-card';
    card.type = 'button';
    card.title = image.relativePath;
    let modifiedPointer = false;
    card.addEventListener('pointerdown', event => {
      modifiedPointer = event.button === 0 && (event.ctrlKey || event.metaKey);
      if (modifiedPointer) { event.preventDefault(); toggleComparisonImage(image); }
    });
    card.addEventListener('pointercancel', () => { modifiedPointer = false; });
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { modifiedPointer = false; }
    });
    card.addEventListener('click', event => {
      // A recognized selection owns its trailing click, even if the modifier
      // was released or the Webview delivered click after pointerup's task.
      if (modifiedPointer) { event.preventDefault(); modifiedPointer = false; return; }
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); toggleComparisonImage(image); }
      else openDetail(image.id);
    });
    card.addEventListener('contextmenu', event => {
      if (event.ctrlKey || modifiedPointer) { event.preventDefault(); if (!modifiedPointer) toggleComparisonImage(image); modifiedPointer = true; }
    });
    let thumbnail;
    if (image.kind === 'video') {
      thumbnail = document.createElement('span');
      thumbnail.className = 'video-thumbnail';
      thumbnail.setAttribute('role', 'img');
      thumbnail.setAttribute('aria-label', 'Video');
      const icon = document.createElement('span');
      icon.className = 'video-play-icon';
      icon.textContent = '▶';
      const badge = document.createElement('span');
      badge.className = 'video-kind-badge';
      badge.textContent = `Video · ${image.name.split('.').pop().toUpperCase()}`;
      const poster = document.createElement('img'); poster.className = 'video-poster'; poster.alt = image.name;
      // IntersectionObserver already schedules these requests; a second native
      // lazy loader can leave an absolute-positioned image waiting indefinitely.
      poster.loading = 'eager'; poster.decoding = 'async'; poster.dataset.imageId = image.id; poster.dataset.videoPoster = 'true';
      poster.addEventListener('load', () => { finishVideoPoster(poster); });
      poster.addEventListener('error', () => { if (poster.hasAttribute('src')) { failVideoPoster(poster, 'The first-frame image could not be displayed.'); } });
      if (thumbnailObserver) { thumbnailObserver.observe(poster); } else { queueThumbnail(poster); }
      const status = document.createElement('span'); status.className = 'video-poster-status';
      thumbnail.append(poster, icon, badge, status);
    } else {
      thumbnail = document.createElement('img');
      thumbnail.alt = image.name;
      thumbnail.loading = 'eager'; thumbnail.decoding = 'async'; thumbnail.className = 'gallery-thumbnail';
      thumbnail.dataset.imageId = image.id;
      thumbnail.addEventListener('load', () => finishImageThumbnail(thumbnail));
      thumbnail.addEventListener('error', () => {
        if (thumbnail.hasAttribute('src')) { failImageThumbnail(thumbnail, 'The thumbnail could not be displayed.'); }
      });
      if (thumbnailObserver) { thumbnailObserver.observe(thumbnail); }
      else { queueThumbnail(thumbnail); }
    }
    thumbnail.dataset.relativePath = image.relativePath;
    const filename = document.createElement('span');
    filename.className = 'filename';
    filename.textContent = image.name;
    card.append(thumbnail, filename);
    markComparisonCard(card, image.id);
    return card;
  }

  function markComparisonCard(card, id) {
    const index = selectedImages.indexOf(id);
    card.classList.toggle('comparison-selected', index >= 0); card.setAttribute('aria-pressed', String(index >= 0));
    card.querySelector('.comparison-marker')?.remove();
    if (index >= 0) { const marker = document.createElement('span'); marker.className = 'comparison-marker'; marker.textContent = index ? 'B' : 'A'; card.append(marker); }
  }
  function updateComparisonSelection() {
    document.querySelector('#comparison-selection').classList.toggle('hidden', !selectedImages.length);
    const button = document.querySelector('#compare-selected'); button.disabled = selectedImages.length !== 2;
    button.textContent = `${uiText('Compare', '对比')} ${selectedImages.length}/2`;
    for (const card of gallery.querySelectorAll('.image-card')) markComparisonCard(card, card.dataset.mediaId);
  }
  function toggleComparisonImage(image) {
    cancelComparisonStart();
    if (image.kind === 'video') { document.querySelector('#browser-status').textContent = uiText('Comparison supports images only.', '对比模式仅支持图片。'); return; }
    const index = selectedImages.indexOf(image.id);
    if (index >= 0) selectedImages.splice(index, 1);
    else if (selectedImages.length < 2) selectedImages.push(image.id);
    else { document.querySelector('#browser-status').textContent = uiText('Deselect an image before choosing another.', '请先取消一张选择，再选择其他图片。'); return; }
    updateComparisonSelection();
    if (selectedImages.length === 2 && index < 0) {
      const pair = [...selectedImages];
      // Keep both A/B markers visible before changing views. A subsequent user
      // action can cancel this intent; it must never open a stale selection.
      comparisonStartTimer = setTimeout(() => {
        comparisonStartTimer = 0;
        if (panelVisible && !document.hidden && selectedImages.length === 2 && pair.every((id, i) => selectedImages[i] === id)) enterComparison();
      }, 350);
    }
  }
  function cancelComparisonStart() {
    clearTimeout(comparisonStartTimer); comparisonStartTimer = 0;
  }
  function clearComparisonSelection() {
    cancelComparisonStart(); selectedImages = []; updateComparisonSelection();
  }
  function settleImageWaiters(entry, error) {
    for (const settle of [...(entry.waiters || [])]) settle(error);
  }
  function loadComparisonImage(side, original, signal, force) {
    const image = images.find(image => image.id === comparisonIds[side]), entry = detailEntry(image);
    const variant = `${gallerySettings.resolution}/${original}`;
    if (!force && entry.ready && entry.variant === variant) {
      entry.used = ++detailClock;
      vscode.postMessage({ type: 'validatePreview', id: entry.id, requestId: entry.target.dataset.previewRequest });
      return Promise.resolve({ image: entry.target, dimensions: entry.dimensions });
    }
    if (force || entry.variant !== variant || entry.failed || !entry.target.dataset.previewRequest) requestPreview(entry.target, entry.id, true, original);
    else vscode.postMessage({ type: 'promotePreview', requestId: entry.target.dataset.previewRequest });
    const requestId = entry.target.dataset.previewRequest;
    return new Promise((resolve, reject) => {
      entry.waiters ||= new Set();
      const finish = error => {
        clearTimeout(timer); entry.waiters.delete(finish); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve({ image: entry.target, dimensions: entry.dimensions });
      };
      const abort = () => {
        if (!entry.ready && entry.target.dataset.previewRequest === requestId) releasePreview(entry.target);
        finish(new Error('Image request cancelled.'));
      };
      const timer = setTimeout(() => { if (entry.target.dataset.previewRequest === requestId) releasePreview(entry.target); entry.failed = true; finish(new Error(uiText('Image loading timed out.', '图片加载超时。'))); }, 45000);
      entry.waiters.add(finish); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  function enterComparison() {
    cancelComparisonStart();
    if (comparison || selectedImages.length !== 2 || !detailView.classList.contains('hidden')) return;
    const pair = selectedImages.map(id => images.find(image => image.id === id));
    if (pair.some(image => !image || image.kind === 'video')) return;
    comparisonIds = [...selectedImages]; comparisonBytes = 0;
    cancelAnimationFrame(neighborFrame); neighborFrame = 0; clearImageTransition(); clearTimeout(loadingTimer);
    for (const entry of detailEntries.values()) { releaseCaption(entry); }
    currentCaptionToken = ''; stopVideo(); grid.suspend(); galleryView.classList.add('hidden');
    document.querySelector('#browser-status').textContent = '';
    trimDetailEntries();
    comparison = new window.GalleryCompare({ images: pair, language: document.body.dataset.uiLanguage, load: loadComparisonImage,
      sensitivity: () => imageZoomSensitivity, onClose: exitComparison, onFullscreen: openComparisonBrowser,
      onCopyFilePath: copyFilePath,
      onMemory: bytes => { comparisonBytes = bytes; trimDetailEntries(); } });
    if (!panelVisible) comparison.setVisible(false);
    comparisonValidationTimer = setInterval(validateComparison, 15000);
  }
  function validateComparison() {
    if (!comparison || !panelVisible || document.hidden) return;
    for (const id of comparisonIds) {
      const entry = detailEntries.get(id);
      if (entry?.ready && entry.target.dataset.previewRequest) vscode.postMessage({ type: 'validatePreview', id, requestId: entry.target.dataset.previewRequest });
    }
  }
  function exitComparison() {
    clearInterval(comparisonValidationTimer);
    comparison?.dispose(); comparison = null; comparisonIds = []; comparisonBytes = 0; comparisonOpening = '';
    cancelComparisonStart();
    trimDetailEntries(); galleryView.classList.remove('hidden'); if (panelVisible) grid.resume(); updateComparisonSelection();
    document.querySelector('#comparison-help').focus({ preventScroll: true });
  }
  function openComparisonBrowser(state) {
    if (comparisonOpening || !comparison) return;
    comparisonOpening = `comparison-${++previewSequence}`;
    comparison.root.querySelector('[data-action=fullscreen]').disabled = true;
    vscode.postMessage({ type: 'openComparisonInBrowser', requestId: comparisonOpening, ids: [...comparisonIds], search: search.value.trim(), resolution: gallerySettings.resolution, videoMaxHeight: gallerySettings.videoMaxHeight, ffmpegPath: gallerySettings.ffmpegPath, comparison: state });
  }

  function releaseCard(card) {
    const thumbnail = card.querySelector('img');
    if (!thumbnail) { return; }
    thumbnailObserver?.unobserve(thumbnail);
    releasePreview(thumbnail);
    thumbnail.removeAttribute('src');
  }

  function queueThumbnail(thumbnail, defer = false) {
    if (thumbnail.dataset.previewRequest || thumbnailQueue.has(thumbnail)) { return; }
    thumbnailQueue.set(thumbnail, thumbnail.dataset.imageId);
    if (!defer && thumbnail.isConnected) { pumpThumbnails(); } else { scheduleThumbnailPump(); }
  }

  function scheduleThumbnailPump() {
    if (thumbnailPumpScheduled) { return; }
    thumbnailPumpScheduled = true;
    queueMicrotask(() => { thumbnailPumpScheduled = false; pumpThumbnails(); });
  }

  function finishThumbnail(thumbnail) {
    const pending = previewRequests.get(thumbnail.dataset.previewRequest); if (pending?.timer) { clearTimeout(pending.timer); pending.timer = null; }
    if (activeThumbnails.delete(thumbnail)) { scheduleThumbnailPump(); }
  }

  function pumpThumbnails() {
    if (!panelVisible || grid.suspended || galleryView.classList.contains('hidden')) { return; }
    const rect = galleryView.getBoundingClientRect(), top = rect.top, bottom = top + (galleryView.clientHeight || window.innerHeight);
    const distance = (target) => { const box = target.getBoundingClientRect(); return box.bottom < top ? top - box.bottom : box.top > bottom ? box.top - bottom : 0; };
    const waiting = [...thumbnailQueue].map(([target, id]) => ({ target, id, distance: distance(target) })).sort((a, b) => a.distance - b.distance);
    for (const { target, id } of waiting) {
      if (activeThumbnails.size >= thumbnailConcurrency) { break; }
      thumbnailQueue.delete(target);
      if (!target.isConnected) { continue; }
      if (target.dataset.videoPoster === 'true') { requestVideoPoster(target, id); }
      else { requestPreview(target, id, false); }
      activeThumbnails.add(target);
    }
  }

  function openDetail(id) {
    fileMenu.close();
    cancelComparisonStart();
    clearTimeout(searchTimer);
    currentIndex = filteredIndex.get(id) ?? -1;
    if (currentIndex < 0) {
      return;
    }
    const thumb = [...gallery.querySelectorAll('img')].find(target => target.dataset.imageId === id);
    selectedThumbnail = thumb?.src.startsWith('data:') ? thumb.src : '';
    grid.suspend();
    galleryView.classList.add('hidden');
    detailView.classList.remove('hidden');
    if (!imageResizeObserver) {
      imageResizeObserver = new ResizeObserver(updateImageTransform);
    }
    imageResizeObserver.observe(imageStage);
    applySplitRatio(splitRatio, false);
    setTextPaneHidden(textPaneHidden, false);
    loadCurrentImage();
    detailView.focus({ preventScroll: true });
  }

  function loadCurrentImage() {
    const image = filteredImages[currentIndex];
    if (!image) {
      return;
    }

    switchStarted = performance.now(); videoRecoveryAttempts = 0;
    clearTimeout(loadingTimer);
    exitEditMode();
    stopVideo();
    trimDetailEntries();
    let entry = detailEntry(image);
    if (entry.variant && entry.variant !== `${gallerySettings.resolution}/false`) { disposeDetailEntry(entry); entry = detailEntry(image); }
    if (detailImage !== entry.target) {
      const previous = detailImage; previous.removeAttribute('id');
      if (previous.naturalWidth && !previous.classList.contains('loading') && image.kind !== 'video' && !entry.ready) {
        clearImageTransition(); transitionImage = previous; previous.classList.add('switch-placeholder');
      } else {
        previous.remove();
        if (entry.ready || image.kind === 'video') { clearImageTransition(); }
      }
      detailImage = entry.target;
      detailImage.id = 'detail-image';
      imageStage.prepend(detailImage);
    }
    entry.used = ++detailClock;
    if (!entry.ready && !transitionImage && selectedThumbnail && image.kind !== 'video') {
      transitionImage = document.createElement('img'); transitionImage.src = selectedThumbnail; transitionImage.className = 'switch-placeholder'; imageStage.prepend(transitionImage);
    }
    selectedThumbnail = '';
    transitionLabel.textContent = uiText(`Switching to ${image.name}…`, `正在切换到 ${image.name}…`);
    transitionLabel.classList.toggle('hidden', !transitionImage);
    currentMediaKind = image.kind === 'video' ? 'video' : 'image';
    if (!isCurrentVideo() && videoFocused) { setVideoFocus(false, false); }
    syncVideoControls();
    detailImage.classList.toggle('hidden', isCurrentVideo());
    detailVideo.classList.toggle('hidden', !isCurrentVideo());
    document.querySelector('#image-zoom-field').classList.toggle('hidden', isCurrentVideo());
    imageStage.classList.toggle('video-mode', isCurrentVideo());
    imageStage.parentElement.classList.toggle('video-pane', isCurrentVideo());
    videoToolbar.classList.toggle('hidden', !isCurrentVideo());
    imageStage.classList.remove('can-pan');
    mediaKindLabel.textContent = isCurrentVideo() ? 'Video' : 'Image';
    imageStage.title = isCurrentVideo() ? '' : 'Pinch to zoom · Drag or two-finger scroll to pan · Double-click to reset';
    currentCaptionRequest = image.id;
    pendingCaptionEditId = '';
    captionText = '';
    renderedCaption = '';
    captionExists = false;
    captionRevision = 'missing';
    captionLoaded = false;
    imageZoomPercent = 100;
    resetImageZoom.textContent = '100%';
    imagePanX = 0;
    imagePanY = 0;
    clearImageDimensions();
    if (isCurrentVideo()) { requestVideo(image); }
    else if (entry.ready) {
      displayReadyImage(entry);
      // A metadata-only check preserves warm switches while detecting replaced files.
      vscode.postMessage({ type: 'validatePreview', id: entry.id, requestId: entry.target.dataset.previewRequest });
    }
    else if (entry.target.dataset.previewRequest && !entry.failed) {
      showImageLoading(entry.target);
      const pending = previewRequests.get(entry.target.dataset.previewRequest); if (pending) { pending.prefetch = false; }
      vscode.postMessage({ type: 'promotePreview', requestId: entry.target.dataset.previewRequest });
      scheduleNeighborPreload(true);
    } else { requestPreview(detailImage, image.id, true); }
    detailImage.alt = image.name;
    captionPreview.textContent = '';
    editCaption.disabled = true;
    updateDetailMetadata();
    currentCaptionToken = '';
    if (!textPaneHidden) {
      if (entry.caption) { applyCaptionMessage(entry.caption); }
      requestCurrentCaption();
    }
  }

  function requestCurrentCaption() {
    if (textPaneHidden || detailView.classList.contains('hidden') || !currentCaptionRequest) { return; }
    const entry = detailEntries.get(currentCaptionRequest);
    if (!entry) { return; }
    if (!captionLoaded) {
      editCaption.disabled = true;
      captionPreview.textContent = 'Loading caption…';
    }
    // Revalidate a cached caption quietly. Revision checks still protect edits.
    currentCaptionToken = entry.captionToken || requestEntryCaption(entry);
  }

  function requestEntryCaption(entry) {
    const token = `caption-${++previewSequence}`;
    entry.captionToken = token;
    captionRequests.set(token, entry);
    vscode.postMessage({ type: 'loadCaption', id: entry.id, requestId: token });
    return token;
  }

  function releaseCaption(entry) {
    if (!entry?.captionToken) { return; }
    captionRequests.delete(entry.captionToken);
    vscode.postMessage({ type: 'releaseCaption', requestId: entry.captionToken });
    entry.captionToken = '';
  }

  function detailEntry(image) {
    let entry = detailEntries.get(image.id);
    if (entry) { return entry; }
    const target = document.createElement('img');
    target.alt = image.name;
    target.decoding = 'async';
    target.draggable = false;
    entry = { id: image.id, kind: image.kind, target, ready: false, dimensions: null, caption: null, captionToken: '' };
    detailEntries.set(image.id, entry);
    target.addEventListener('load', async () => {
      const requestId = target.dataset.previewRequest;
      if (!requestId || !target.naturalWidth) { return; }
      const decodeStarted = performance.now();
      entry.transferMs = decodeStarted - (entry.resourceStarted || decodeStarted);
      try { if (target.decode) { await target.decode(); } }
      catch { if (target.dataset.previewRequest === requestId) { imageFailed(); } return; }
      if (target.dataset.previewRequest !== requestId || detailEntries.get(entry.id) !== entry) { return; }
      entry.decodeMs = performance.now() - decodeStarted;
      entry.ready = true; entry.used = ++detailClock;
      settleImageWaiters(entry);
      trimDetailEntries();
      entry.displayMs = performance.now() - (entry.resourceStarted || performance.now());
      if (target === detailImage && !detailView.classList.contains('hidden') && !isCurrentVideo()) { displayReadyImage(entry); }
    });
    function imageFailed() {
      entry.failed = true;
      settleImageWaiters(entry, new Error('Could not display this image.'));
      if (target === detailImage && target.hasAttribute('src')) { showImageError('Could not display this image.'); }
    }
    target.addEventListener('error', imageFailed);
    return entry;
  }

  function displayReadyImage(entry) {
    clearTimeout(loadingTimer); clearImageTransition();
    entry.used = ++detailClock;
    currentImageDimensions = entry.dimensions;
    const started = switchStarted;
    requestAnimationFrame(() => {
      if (detailImage !== entry.target || !entry.ready || switchStarted !== started) { return; }
      entry.switchMs = performance.now() - started;
      imageStage.dataset.switchMs = entry.switchMs.toFixed(2);
      imageStage.dataset.displayedId = entry.id;
      updatePreviewPerformance(entry);
    });
    updatePreviewPerformance(entry);
    imageStatus.classList.add('hidden');
    detailImage.classList.remove('loading');
    updateImageDimensions();
    updateImageTransform();
    scheduleNeighborPreload();
  }

  function updatePreviewPerformance(entry) {
    const timings = entry.dimensions?.timings;
    if (!timings) { previewPerformance.textContent = '—'; return; }
    const zh = document.body.dataset.uiLanguage === 'zh';
    const seconds = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(2)} s`;
    previewPerformance.textContent = timings.cacheHit
      ? `${zh ? '命中服务器缓存' : 'Host cache hit'} · ${seconds(timings.totalMs)}`
      : `${zh ? '排队' : 'Queue'} ${seconds(timings.queueMs)} · ${zh ? '读取' : 'Read'} ${seconds(timings.readMs)}
${zh ? '解码 / 缩放 / 编码' : 'Decode / resize / encode'} ${seconds(timings.processMs)} · ${zh ? '缓存写入' : 'Cache write'} ${seconds(timings.writeMs)}
${zh ? '主机合计' : 'Host total'} ${seconds(timings.totalMs)} (${timings.engine})`;
    previewPerformance.textContent += `
${zh ? '资源加载' : 'Resource load'} ${seconds(entry.transferMs)} · ${zh ? '浏览器解码' : 'Browser decode'} ${seconds(entry.decodeMs)}
${zh ? '切换到绘制' : 'Switch to paint'} ${seconds(entry.switchMs)}`;
  }

  function trimDetailEntries() {
    const neighbours = new Set(filteredImages.slice(Math.max(0, currentIndex - 1), currentIndex + 2).map(image => image.id));
    const activeId = filteredImages[currentIndex]?.id;
    const protectedEntry = entry => comparisonIds.length ? comparisonIds.includes(entry.id) : entry.id === activeId || entry.target === transitionImage;
    const bytes = entry => (entry.target.naturalWidth || entry.dimensions?.width || 0) * (entry.target.naturalHeight || entry.dimensions?.height || 0) * (entry.dimensions?.frameCount || 1) * 4;
    for (const [id, entry] of detailEntries) {
      const unknownAnimation = /\.(gif|webp)$/i.test(entry.target.alt) && !entry.dimensions?.frameCount;
      if (!protectedEntry(entry) && ((!entry.ready && (comparisonIds.length || !neighbours.has(id))) || bytes(entry) > 64 * 1024 * 1024 || (entry.ready && unknownAnimation))) { disposeDetailEntry(entry); }
    }
    let total = comparisonBytes + [...detailEntries.values()].reduce((sum, entry) => sum + bytes(entry), 0);
    const candidates = [...detailEntries.values()].filter(entry => !protectedEntry(entry))
      .sort((a, b) => Number(neighbours.has(a.id)) - Number(neighbours.has(b.id)) || (a.used || 0) - (b.used || 0));
    for (const entry of candidates) {
      if (detailEntries.size + Number(comparisonBytes > 0) <= 7 && total <= 128 * 1024 * 1024) { break; }
      total -= bytes(entry); disposeDetailEntry(entry);
    }
  }

  function clearImageTransition() {
    if (transitionImage) { transitionImage.classList.remove('switch-placeholder'); transitionImage.remove(); transitionImage = null; }
    transitionLabel.classList.add('hidden');
  }

  function disposeDetailEntry(entry) {
    settleImageWaiters(entry, new Error('Image cache released.'));
    releaseCaption(entry);
    releasePreview(entry.target);
    entry.target.removeAttribute('src');
    entry.target.remove();
    detailEntries.delete(entry.id);
  }

  function clearDetailEntries(except = '') {
    clearImageTransition(); clearTimeout(loadingTimer);
    cancelAnimationFrame(neighborFrame); neighborFrame = 0;
    for (const [id, entry] of detailEntries) { if (id !== except) { disposeDetailEntry(entry); } }
  }

  function scheduleNeighborPreload(early = false) {
    if (comparisonIds.length) return;
    cancelAnimationFrame(neighborFrame);
    neighborFrame = requestAnimationFrame(() => {
      neighborFrame = 0;
      if (!panelVisible || detailView.classList.contains('hidden')) { return; }
      const active = detailEntries.get(currentCaptionRequest);
      if (!active || (!early && !isCurrentVideo() && !active.ready) || (isCurrentVideo() && !detailVideo.hasAttribute('src'))) { return; }
      trimDetailEntries();
      for (const index of [currentIndex + 1, currentIndex - 1]) {
        const image = filteredImages[index];
        if (!image) { continue; }
        const entry = detailEntry(image);
        if (image.kind !== 'video' && !entry.ready && !entry.failed && !entry.skipped && !entry.target.dataset.previewRequest) {
          requestPreview(entry.target, entry.id, true, false, true);
        }
        if (!textPaneHidden && !entry.caption && !entry.captionToken) { requestEntryCaption(entry); }
      }
    });
  }

  function requestGuardedAction(action) {
    if (isSaving || activeDecisionRequest) { return; }
    if (isCaptionDirty()) {
      pendingAction = action;
      activeDecisionRequest = nextDecisionRequest();
      vscode.postMessage({
        type: 'confirmUnsaved',
        requestId: activeDecisionRequest,
        reason: action.type,
      });
      return;
    }

    if (isEditing) {
      exitEditMode();
    }
    performAction(action);
  }

  function performAction(action) {
    if (action.type === 'move') {
      move(action.offset);
    } else if (action.type === 'gallery') {
      showGallery();
    } else if (action.type === 'videoFocus') {
      setVideoFocus(true);
    } else if (action.type === 'hideText') {
      setTextPaneHidden(true);
    }
  }

  function move(offset) {
    const nextIndex = Math.max(0, Math.min(filteredImages.length - 1, currentIndex + offset));
    if (nextIndex === currentIndex) {
      return;
    }
    currentIndex = nextIndex;
    loadCurrentImage();
  }

  function showGallery() {
    fileMenu.close();
    if (videoFocused) { setVideoFocus(false, false); }
    stopVideo();
    clearDetailEntries();
    detailImage.removeAttribute('src');
    currentCaptionToken = '';
    pendingCaptionEditId = '';
    imageResizeObserver?.disconnect();
    detailView.classList.add('hidden');
    galleryView.classList.remove('hidden');
    if (panelVisible) { grid.resume(); }
  }

  function enterEditMode() {
    if (!captionLoaded || isEditing) {
      return;
    }
    releaseCaption(detailEntries.get(currentCaptionRequest));
    currentCaptionToken = '';
    isEditing = true;
    captionEditor.value = captionText;
    updateEditControls();
    updateDirtyState();
    captionEditor.focus({ preventScroll: true });
  }

  function startCaptionEditingFromShortcut() {
    if (!currentCaptionRequest || isEditing || isSaving || detailView.classList.contains('hidden')) { return; }
    if (videoFocused) { setVideoFocus(false, false); }
    pendingCaptionEditId = currentCaptionRequest;
    if (textPaneHidden) { setTextPaneHidden(false); }
    if (captionLoaded) {
      pendingCaptionEditId = '';
      enterEditMode();
    } else {
      requestCurrentCaption();
    }
  }

  function requestCancelEditing() {
    if (!isEditing || isSaving) {
      return;
    }
    if (!isCaptionDirty()) {
      exitEditMode();
      return;
    }
    activeDecisionRequest = nextDecisionRequest();
    vscode.postMessage({ type: 'confirmDiscard', requestId: activeDecisionRequest });
  }

  function saveCaption() {
    if (!isEditing || isSaving || !currentCaptionRequest) {
      return;
    }
    isSaving = true;
    updateEditControls();
    setEditStatus('Saving…', false);
    vscode.postMessage({
      type: 'saveCaption',
      id: currentCaptionRequest,
      caption: captionEditor.value,
      baseRevision: captionRevision,
    });
  }

  function exitEditMode() {
    isEditing = false;
    isSaving = false;
    captionEditor.value = captionText;
    updateEditControls();
    if (captionLoaded) {
      renderCaptionView();
    }
    reportDirtyState(false);
  }

  function updateEditControls() {
    captionPreview.classList.toggle('hidden', isEditing);
    captionEditor.classList.toggle('hidden', !isEditing);
    editingLabel.classList.toggle('hidden', !isEditing);
    editCaption.classList.toggle('hidden', isEditing || textPaneHidden);
    editActions.classList.toggle('hidden', !isEditing);
    captionPane.classList.toggle('editing', isEditing);
    captionEditor.disabled = isSaving;
    cancelEdit.disabled = isSaving;
    saveEdit.disabled = isSaving;
    if (!isEditing) {
      setEditStatus('', false);
    }
  }

  function updateDirtyState() {
    const dirty = isCaptionDirty();
    reportDirtyState(dirty);
    if (!isSaving) {
      setEditStatus(dirty ? 'Unsaved' : '', dirty);
    }
  }

  function reportDirtyState(dirty) {
    if (dirty === lastReportedDirty) {
      return;
    }
    lastReportedDirty = dirty;
    vscode.postMessage({ type: 'dirtyState', dirty });
  }

  function setEditStatus(text, isDirty) {
    editState.textContent = text;
    editState.classList.toggle('hidden', !text);
    editState.classList.toggle('dirty', isDirty);
  }

  function isCaptionDirty() {
    return isEditing && captionEditor.value !== captionText;
  }

  function applyCaptionMessage(message) {
    const entry = detailEntries.get(message.id);
    if (entry) { entry.caption = message; }
    captionText = typeof message.caption === 'string' ? message.caption : '';
    renderedCaption = typeof message.renderedCaption === 'string' ? message.renderedCaption : '';
    captionExists = Boolean(message.exists);
    captionRevision = typeof message.revision === 'string' ? message.revision : 'missing';
    captionLoaded = true;
    editCaption.disabled = false;
    renderCaptionView();
  }

  function toggleTextPane() {
    if (videoFocused) { setVideoFocus(false); if (textPaneHidden) { setTextPaneHidden(false); } return; }
    if (textPaneHidden) { setTextPaneHidden(false); } else { requestGuardedAction({ type: 'hideText' }); }
  }

  function requestVideoFocus() {
    if (!isCurrentVideo() || detailView.classList.contains('hidden')) { return; }
    if (videoFocused) { setVideoFocus(false); } else { requestGuardedAction({ type: 'videoFocus' }); }
  }

  function setVideoFocus(active, loadCaption = true) {
    if (videoFocused === active || (active && !isCurrentVideo())) { return; }
    if (active) { captionBeforeFocus = textPaneHidden; }
    videoFocused = active;
    detailView.classList.toggle('video-focused', active);
    videoFocusControls.classList.toggle('hidden', !active);
    setTextPaneHidden(active ? true : captionBeforeFocus, false, loadCaption);
    if (active) { document.querySelector('#exit-video-focus').focus({ preventScroll: true }); }
    else { detailView.focus({ preventScroll: true }); }
    syncVideoControls(); persistState();
  }

  function openBrowserMedia() {
    if (windowFullscreenPending) { return; }
    const inDetail = !detailView.classList.contains('hidden');
    const image = inDetail ? filteredImages[currentIndex] : filteredImages.find(image => image.kind !== 'video');
    if (!image) { return; }
    windowFullscreenPending = true;
    browserOpening = { id: image.id, requestId: `browser-${++previewSequence}` };
    syncVideoControls();
    document.querySelector('#browser-status').textContent = uiText('Opening browser viewer…', '正在打开浏览器…');
    if (image.kind === 'video') {
      const state = captureVideoPlayback();
      videoFeedbackMessage.textContent = uiText('Opening browser player…', '正在打开浏览器播放器…');
      vscode.postMessage({ type: 'openVideoInBrowser', ...browserOpening, search: search.value.trim(), resolution: gallerySettings.resolution, ffmpegPath: gallerySettings.ffmpegPath, playback: { time: state.time, rate: videoPlaybackRate, volume: state.volume, muted: state.muted, quality: gallerySettings.videoMaxHeight } });
    } else {
      vscode.postMessage({ type: 'openImagesInBrowser', ...browserOpening, search: search.value.trim(), resolution: gallerySettings.resolution, videoMaxHeight: gallerySettings.videoMaxHeight, ffmpegPath: gallerySettings.ffmpegPath, original: inDetail && detailImage.dataset.original === 'true' });
    }
  }

  function syncVideoControls() {
    const available = isCurrentVideo() && !detailView.classList.contains('hidden');
    const detailAvailable = currentIndex >= 0 && !detailView.classList.contains('hidden');
    videoFocusButton.classList.toggle('hidden', !detailAvailable); videoFocusButton.disabled = !detailAvailable || windowFullscreenPending;
    document.querySelector('#image-browser-fullscreen').disabled = windowFullscreenPending || (!detailAvailable && !filteredImages.length) || (detailAvailable && isCurrentVideo());
    for (const button of document.querySelectorAll('#video-window-fullscreen, #focus-window-fullscreen')) { button.disabled = !available || windowFullscreenPending; }
    document.querySelector('#video-focus-settings').disabled = !available;
    document.querySelector('#video-focus-settings').textContent = videoFocused ? uiText('Exit panel view', '退出铺满') : uiText('Fill panel', '铺满面板');
  }

  function uiText(en, zh) { return document.body.dataset.uiLanguage === 'zh' ? zh : en; }
  function validPlaybackRate(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 4; }
  function syncVideoRate() {
    // Retain rates selected through the native player, including custom values.
    if (![...videoRateSelect.options].some(option => Number(option.value) === videoPlaybackRate)) {
      const option = document.createElement('option'); option.value = String(videoPlaybackRate); option.textContent = `${videoPlaybackRate}×`; videoRateSelect.append(option);
    }
    videoRateSelect.value = String(videoPlaybackRate);
  }
  function applyVideoRate() {
    applyingVideoRate = true;
    try {
      if (detailVideo.defaultPlaybackRate !== videoPlaybackRate) { detailVideo.defaultPlaybackRate = videoPlaybackRate; }
      if (detailVideo.playbackRate !== videoPlaybackRate) { detailVideo.playbackRate = videoPlaybackRate; }
    } finally { applyingVideoRate = false; }
    syncVideoRate();
  }

  function setTextPaneHidden(hidden, shouldPersist = true, loadCaption = true) {
    const changed = textPaneHidden !== hidden;
    textPaneHidden = hidden;
    detailView.classList.toggle('text-hidden', hidden);
    toggleCaption.setAttribute('aria-pressed', String(!hidden));
    toggleCaption.textContent = hidden ? 'Caption: Off' : 'Caption: On';
    detailToggleCaption.setAttribute('aria-pressed', String(!hidden));
    detailToggleCaption.setAttribute('aria-label', hidden ? uiText('Show Caption', '显示 Caption') : uiText('Hide Caption', '隐藏 Caption'));
    detailToggleCaption.title = `${detailToggleCaption.getAttribute('aria-label')} (C)`;
    if (hidden) {
      pendingCaptionEditId = '';
      for (const entry of detailEntries.values()) { releaseCaption(entry); entry.caption = null; }
      currentCaptionToken = '';
      captionLoaded = false;
      captionPreview.replaceChildren();
      editCaption.disabled = true;
    } else if (changed && loadCaption) {
      requestCurrentCaption(); scheduleNeighborPreload();
    }
    updateEditControls(); syncPaneControls();
    if (shouldPersist) { persistState(); }
    requestAnimationFrame(updateImageTransform);
  }

  function nextDecisionRequest() {
    decisionSequence += 1;
    return `caption-decision-${decisionSequence}`;
  }

  function updateDetailMetadata() {
    const image = filteredImages[currentIndex];
    if (!image) {
      return;
    }
    detailPath.textContent = image.relativePath;
    detailPath.title = image.relativePath;
    document.querySelector('#settings-path').textContent = image.relativePath;
    document.querySelector('#previous').disabled = currentIndex === 0;
    document.querySelector('#next').disabled = currentIndex === filteredImages.length - 1;
  }

  function loadVisibleThumbnails(entries) {
    for (const entry of entries) {
      const thumbnail = entry.target;
      if (entry.isIntersecting && !galleryView.classList.contains('hidden')) {
        if (!thumbnail.dataset.previewRequest) {
          queueThumbnail(thumbnail, true);
        }
      } else {
        releasePreview(thumbnail);
        thumbnail.removeAttribute('src'); thumbnail.classList.remove('thumbnail-ready');
      }
    }
    pumpThumbnails();
  }

  function releasePreview(target) {
    thumbnailQueue.delete(target);
    finishThumbnail(target);
    const requestId = target.dataset.previewRequest;
    if (!requestId) { return; }
    previewRequests.delete(requestId);
    delete target.dataset.previewRequest;
    vscode.postMessage({ type: 'releasePreview', requestId });
  }

  function requestPreview(target, id, detail, original = false, prefetch = false) {
    releasePreview(target);
    target.removeAttribute('src');
    const requestId = `preview-${++previewSequence}`;
    target.dataset.previewRequest = requestId;
    target.dataset.original = String(original);
    previewRequests.set(requestId, { target, id, detail, prefetch, requestedAt: performance.now() });
    if (detail) {
      const entry = detailEntries.get(id);
      if (entry) { entry.ready = false; entry.failed = false; entry.skipped = false; entry.dimensions = null; entry.variant = `${gallerySettings.resolution}/${original}`; }
    }
    if (detail && target === detailImage) { showImageLoading(target); }
    else if (!detail) {
      target.classList.remove('thumbnail-ready'); target.setAttribute('aria-busy', 'true');
      target.parentElement?.querySelector('.preview-error')?.remove();
      target.parentElement?.removeAttribute('data-thumbnail-error');
      armImageThumbnailTimeout(target, 30000, 'Thumbnail preparation timed out.');
    }
    vscode.postMessage({ type: 'loadPreview', id, requestId, detail, original, prefetch, resolution: gallerySettings.resolution });
  }

  function showImageLoading(target) {
    previewPerformance.textContent = document.body.dataset.uiLanguage === 'zh' ? '准备中…' : 'Preparing…';
    currentImageDimensions = null;
    clearImageDimensions();
    target.classList.add('loading');
    imageStatus.classList.add('hidden'); clearTimeout(loadingTimer);
    const requestId = target.dataset.previewRequest;
    loadingTimer = setTimeout(() => {
      if (target !== detailImage || target.dataset.previewRequest !== requestId || detailEntries.get(currentCaptionRequest)?.ready || detailView.classList.contains('hidden')) { return; }
      imageStatus.classList.remove('hidden');
    }, 150);
    imageStatusMessage.textContent = uiText('Loading image…', '正在加载图片…');
    loadOriginal.textContent = 'Load original';
    loadOriginal.classList.add('hidden');
  }

  function isCurrentVideo() { return currentMediaKind === 'video'; }

  function requestVideo(image, compatible = false, native = false, restore = null, recovering = false) {
    if (!recovering) { videoRecoveryAttempts = 0; }
    if (restore) { restore = { ...restore, positioned: false }; }
    stopVideo();
    detailVideo.dataset.compatible = String(compatible);
    detailVideo.dataset.converted = 'false';
    delete detailVideo.dataset.streamError; delete detailVideo.dataset.stream;
    detailVideo.dataset.native = String(native || gallerySettings.videoCompatibility === 'native');
    clearImageDimensions();
    const requestId = `video-${++previewSequence}`;
    detailVideo.dataset.previewRequest = requestId;
    previewRequests.set(requestId, { target: detailVideo, id: image.id, detail: true, kind: 'video', restore });
    detailVideo.setAttribute('aria-label', `Video player: ${image.name}`);
    imageStatus.classList.add('hidden');
    showVideoLoading(uiText('Loading video…', '正在加载视频…'));
    videoQualityInfo.textContent = '';
    vscode.postMessage({ type: 'loadVideo', id: image.id, requestId, compatible, videoCompatibility: native ? 'native' : gallerySettings.videoCompatibility, ffmpegPath: gallerySettings.ffmpegPath, videoMaxHeight: gallerySettings.videoMaxHeight });
  }

  function stopVideo() {
    videoStream?.dispose(); videoStream = null;
    detailVideo.removeAttribute('poster');
    videoFeedbackMessage.textContent = ''; videoPlaybackInfo.textContent = ''; videoQualityInfo.textContent = '';
    videoFeedback.classList.remove('error'); videoFallback.classList.add('hidden');
    if (!detailVideo.hasAttribute('src') && !detailVideo.dataset.previewRequest) { return; }
    detailVideo.pause();
    releasePreview(detailVideo);
    detailVideo.removeAttribute('src');
    detailVideo.load(); // Abort in-flight media reads and clear buffered audio/video.
  }

  function toggleVideoPlayback() {
    if (!detailVideo.hasAttribute('src')) { return; }
    if (!detailVideo.paused) { detailVideo.pause(); return; }
    const requestId = detailVideo.dataset.previewRequest;
    void detailVideo.play().catch((error) => {
      if (isCurrentVideo() && detailVideo.dataset.previewRequest === requestId && error.name !== 'AbortError') {
        showVideoError(`Could not play video: ${error.message}`);
      }
    });
  }

  function normalizeVideoQuality(value) {
    if (value === 480) { return 720; }
    if (value === 2160) { return 1440; }
    return [0,720,1080,1440].includes(value) ? value : 1440;
  }

  function captureVideoPlayback() {
    const pending = previewRequests.get(detailVideo.dataset.previewRequest);
    return pending?.restore ? { ...pending.restore } : { time: detailVideo.currentTime || 0, playing: !detailVideo.paused, volume: detailVideo.volume, muted: detailVideo.muted };
  }

  function restoreVideoPosition() {
    const pending = previewRequests.get(detailVideo.dataset.previewRequest), restore = pending?.restore;
    if (!restore || restore.positioned) { return; }
    restore.positioned = true;
    const duration = detailVideo.duration;
    const time = Number.isFinite(duration) ? Math.min(restore.time, Math.max(0, duration - 0.05)) : restore.time;
    if (Math.abs(detailVideo.currentTime - time) > 0.05) { detailVideo.currentTime = time; }
    detailVideo.volume = restore.volume; detailVideo.muted = restore.muted;
  }

  function resumeVideoPlayback() {
    const pending = previewRequests.get(detailVideo.dataset.previewRequest), restore = pending?.restore;
    if (!restore || !restore.positioned || detailVideo.seeking) { return; }
    pending.restore = null;
    if (!restore.playing || !panelVisible || document.hidden || videoFeedback.classList.contains('error')) { return; }
    const requestId = detailVideo.dataset.previewRequest;
    void detailVideo.play().catch((error) => {
      if (detailVideo.dataset.previewRequest === requestId && error.name !== 'AbortError') { showVideoError(uiText('Press Play to continue playback.', '请点击播放继续。')); }
    });
  }

  function cancelVideoResume() {
    const restore = previewRequests.get(detailVideo.dataset.previewRequest)?.restore;
    if (restore) { restore.playing = false; }
  }

  function updateVideoQualityInfo(width, height, previewWidth, previewHeight) {
    if (!width || !height || !previewWidth || !previewHeight) { return; }
    const original = Math.abs(width - previewWidth) < 2 && Math.abs(height - previewHeight) < 2;
    videoQualityInfo.textContent = `${original ? uiText('Original', '原画') + ' · ' : ''}${previewWidth} × ${previewHeight}`;
    videoQualityInfo.title = uiText(`Source ${width} × ${height}. Quality is a cap; smaller videos are never enlarged.`, `源视频 ${width} × ${height}。画质为上限，不放大小视频。`);
  }

  function showVideoLoading(message) {
    if (videoFeedback.classList.contains('error')) { return; }
    videoFeedbackMessage.textContent = message; videoFeedbackMessage.title = '';
    videoFallback.classList.add('hidden');
  }

  function clearVideoLoading() {
    if (!videoFeedback.classList.contains('error')) { videoFeedbackMessage.textContent = ''; }
  }

  function handleVideoFailure(message) {
    const requestId = detailVideo.dataset.previewRequest;
    vscode.postMessage({ type: 'videoDiagnostic', id: currentCaptionRequest, requestId, diagnostics: { stage: 'media-error', message, mediaCode: detailVideo.error?.code, mediaMessage: detailVideo.error?.message, retry: videoRecoveryAttempts, state: detailVideo.dataset.streamState } });
    if (detailVideo.dataset.stream === 'true' && videoRecoveryAttempts++ < 1 && panelVisible && !document.hidden) {
      const image = filteredImages[currentIndex], restore = captureVideoPlayback();
      queueMicrotask(() => { if (isCurrentVideo() && detailVideo.dataset.previewRequest === requestId) { requestVideo(image, true, false, restore, true); } });
      return;
    }
    showVideoError(message);
  }

  function showVideoError(message) {
    detailVideo.pause(); videoStream?.suspend(); cancelVideoResume();
    imageStatus.classList.add('hidden');
    videoFeedback.classList.add('error'); videoFeedbackMessage.textContent = message; videoFeedbackMessage.title = message;
    videoPlaybackInfo.textContent = message;
    const native = detailVideo.dataset.stream === 'true' || detailVideo.dataset.converted === 'true' || (!detailVideo.hasAttribute('src') && detailVideo.dataset.native !== 'true');
    videoFallback.dataset.videoAction = native ? 'native' : 'compatible';
    videoFallback.textContent = native ? uiText('Try original', '尝试原文件') : uiText('Try compatibility', '尝试兼容播放');
    videoFallback.classList.remove('hidden');
  }

  function requestVideoPoster(target, id) {
    releasePreview(target); target.removeAttribute('src');
    const requestId = `poster-${++previewSequence}`; target.dataset.previewRequest = requestId;
    previewRequests.set(requestId, { target, id, detail: false, kind: 'poster', requestedAt: performance.now() });
    target.classList.remove('poster-ready');
    const thumbnail = target.parentElement; thumbnail.classList.remove('poster-failed', 'has-poster');
    thumbnail.querySelector('.video-poster-status').textContent = uiText('Preparing first frame…', '正在准备首帧…');
    thumbnail.title = ''; target.setAttribute('aria-busy', 'true');
    armPosterTimeout(target, 30000, 'First-frame preparation timed out.');
    vscode.postMessage({ type: 'loadVideoPoster', id, requestId, ffmpegPath: gallerySettings.ffmpegPath });
  }

  function armPosterTimeout(target, milliseconds, message) {
    const requestId = target.dataset.previewRequest, pending = previewRequests.get(requestId); if (!pending) { return; }
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => { if (target.dataset.previewRequest === requestId) { failVideoPoster(target, message); } }, milliseconds);
  }

  function finishVideoPoster(target) {
    const pending = previewRequests.get(target.dataset.previewRequest); if (!pending || pending.kind !== 'poster') { return; }
    finishThumbnail(target); target.classList.add('poster-ready'); target.removeAttribute('aria-busy');
    const thumbnail = target.parentElement; thumbnail.classList.remove('poster-failed'); thumbnail.classList.add('has-poster');
    thumbnail.querySelector('.video-poster-status').textContent = '';
    const timing = pending.timing;
    if (timing) {
      const overhead = Math.max(0, performance.now() - pending.requestedAt - timing.totalMs);
      thumbnail.title = `${uiText('First frame', '首帧')} · ${(timing.bytes / 1024).toFixed(1)} KiB · ${timing.cacheHit ? uiText('cache hit', '缓存命中') : uiText('generated', '新生成')}
${uiText('Host', '服务器')} ${Math.round(timing.totalMs)} ms (${uiText('queue', '排队')} ${Math.round(timing.queueMs)} ms, ${uiText('extract', '提取')} ${Math.round(timing.processMs)} ms)
${uiText('Message round trip and display', '消息往返与显示')} ${Math.round(overhead)} ms`;
    }
  }

  function failVideoPoster(target, message) {
    releasePreview(target); target.removeAttribute('src'); target.classList.remove('poster-ready'); target.removeAttribute('aria-busy');
    const thumbnail = target.parentElement; if (!thumbnail) { return; }
    thumbnail.classList.remove('has-poster'); thumbnail.classList.add('poster-failed');
    thumbnail.querySelector('.video-poster-status').textContent = uiText('First frame unavailable · refresh to retry', '首帧不可用 · 刷新重试');
    thumbnail.title = message;
  }

  function showImageError(message) {
    clearTimeout(loadingTimer); clearImageTransition();
    detailImage.classList.add('loading');
    imageStatus.classList.remove('hidden');
    imageStatusMessage.textContent = message;
    loadOriginal.classList.toggle('hidden', detailImage.dataset.original === 'true');
  }

  function armImageThumbnailTimeout(target, milliseconds, message) {
    const requestId = target.dataset.previewRequest, pending = previewRequests.get(requestId); if (!pending) { return; }
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => { if (target.dataset.previewRequest === requestId) { failImageThumbnail(target, message); } }, milliseconds);
  }

  function finishImageThumbnail(target) {
    const pending = previewRequests.get(target.dataset.previewRequest);
    if (!pending || pending.detail || pending.kind) { return; }
    finishThumbnail(target); target.classList.add('thumbnail-ready'); target.removeAttribute('aria-busy');
    target.parentElement?.removeAttribute('data-thumbnail-error');
    target.parentElement?.querySelector('.preview-error')?.remove();
    const timing = pending.timings;
    if (timing && target.parentElement) {
      const overhead = Math.max(0, performance.now() - pending.requestedAt - timing.totalMs);
      target.parentElement.title = `${target.dataset.relativePath || target.alt}
${pending.inlineBytes ? `${(pending.inlineBytes / 1024).toFixed(1)} KiB · ` : ''}${timing.cacheHit ? uiText('Cache hit', '缓存命中') : uiText('Generated', '新生成')}
${uiText('Host', '服务器')} ${Math.round(timing.totalMs)} ms (${uiText('queue', '排队')} ${Math.round(timing.queueMs)} ms, ${uiText('decode / resize', '解码 / 缩放')} ${Math.round(timing.processMs)} ms)
${uiText('Message round trip and display', '消息往返与显示')} ${Math.round(overhead)} ms`;
    }
  }

  function failImageThumbnail(target, message) {
    releasePreview(target); target.removeAttribute('src'); target.classList.remove('thumbnail-ready'); target.removeAttribute('aria-busy');
    if (target.parentElement) { target.parentElement.dataset.thumbnailError = 'true'; target.parentElement.title = message; }
    showThumbnailError(target, uiText('Thumbnail unavailable · open file or refresh to retry', '缩略图不可用 · 可打开文件或刷新重试'));
  }

  function showThumbnailError(thumbnail, message) {
    const card = thumbnail.parentElement;
    if (!card || card.querySelector('.preview-error')) { return; }
    const note = document.createElement('span');
    note.className = 'preview-error';
    note.textContent = message;
    card.append(note);
  }

  function startSplitResize(event) {
    if (textPaneHidden) {
      return;
    }
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing-panes');
    updateSplitFromPointer(event, false);
  }

  function resizeSplit(event) {
    if (!splitter.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateSplitFromPointer(event, false);
  }

  function finishSplitResize(event) {
    if (splitter.hasPointerCapture(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing-panes');
    persistState();
  }

  function updateSplitFromPointer(event, shouldPersist) {
    const bounds = detailView.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }
    applySplitRatio((event.clientX - bounds.left) / bounds.width, shouldPersist);
  }

  function applySplitRatio(nextRatio, shouldPersist = true) {
    splitRatio = clamp(nextRatio, 0.3, 0.8);
    paneSplit.value = String(Math.round(splitRatio * 100));
    document.querySelector('#pane-split-value').textContent = `${Math.round(splitRatio * 100)}%`;
    detailView.style.setProperty('--image-column', `${splitRatio * 100}%`);
    splitter.setAttribute('aria-valuenow', String(Math.round(splitRatio * 100)));
    if (shouldPersist) {
      persistState();
    }
    if (!detailView.classList.contains('hidden')) {
      requestAnimationFrame(updateImageTransform);
    }
  }

  function applyImageZoom(nextPercent) {
    const previousZoom = imageZoomPercent;
    imageZoomPercent = clamp(Number(nextPercent) || 100, 25, 800);
    const panScale = previousZoom > 0 ? imageZoomPercent / previousZoom : 1;
    imagePanX *= panScale;
    imagePanY *= panScale;
    if (imageZoomPercent <= 100) {
      imagePanX = 0;
      imagePanY = 0;
    }
    updateImageTransform();
  }

  function fitImageToPane(event) {
    if (isCurrentVideo()) { return; }
    if (event) {
      event.preventDefault();
    }
    imagePanX = 0;
    imagePanY = 0;
    applyImageZoom(100);
    if (!settingsDialog.open) { detailView.focus({ preventScroll: true }); }
  }

  function updateImageTransform() {
    resetImageZoom.textContent = `${Math.round(imageZoomPercent)}%`;
    imageZoomInput.value = String(Math.round(imageZoomPercent));
    if (
      detailView.classList.contains('hidden')
      || isCurrentVideo()
      || !detailImage.naturalWidth
      || !detailImage.naturalHeight
    ) {
      return;
    }

    const bounds = imageStage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const fitScale = Math.min(
      bounds.width / detailImage.naturalWidth,
      bounds.height / detailImage.naturalHeight,
    );
    const fitWidth = detailImage.naturalWidth * fitScale;
    const fitHeight = detailImage.naturalHeight * fitScale;
    const zoomFactor = imageZoomPercent / 100;
    const maximumPanX = Math.max(0, (fitWidth * zoomFactor - bounds.width) / 2);
    const maximumPanY = Math.max(0, (fitHeight * zoomFactor - bounds.height) / 2);

    imagePanX = clamp(imagePanX, -maximumPanX, maximumPanX);
    imagePanY = clamp(imagePanY, -maximumPanY, maximumPanY);
    detailImage.style.width = `${fitWidth}px`;
    detailImage.style.height = `${fitHeight}px`;
    detailImage.style.transform = `translate(-50%, -50%) translate(${imagePanX}px, ${imagePanY}px) scale(${zoomFactor})`;
    imageStage.classList.toggle('can-pan', maximumPanX > 0 || maximumPanY > 0);
  }

  function startImagePan(event) {
    if (isCurrentVideo() || event.button !== 0 || !imageStage.classList.contains('can-pan')) {
      return;
    }
    event.preventDefault();
    imageStage.setPointerCapture(event.pointerId);
    imageStage.classList.add('dragging');
    document.body.classList.add('panning-image');
    imagePanGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: imagePanX,
      panY: imagePanY,
    };
  }

  function moveImagePan(event) {
    if (!imagePanGesture || imagePanGesture.pointerId !== event.pointerId) {
      return;
    }
    imagePanX = imagePanGesture.panX + event.clientX - imagePanGesture.startX;
    imagePanY = imagePanGesture.panY + event.clientY - imagePanGesture.startY;
    updateImageTransform();
  }

  function finishImagePan(event) {
    if (!imagePanGesture || imagePanGesture.pointerId !== event.pointerId) {
      return;
    }
    if (imageStage.hasPointerCapture(event.pointerId)) {
      imageStage.releasePointerCapture(event.pointerId);
    }
    imagePanGesture = null;
    imageStage.classList.remove('dragging');
    document.body.classList.remove('panning-image');
  }

  function handleImageWheel(event) {
    if (isCurrentVideo()) { return; }
    if (event.ctrlKey || event.metaKey) {
      zoomImageFromWheel(event);
      return;
    }

    if (!imageStage.classList.contains('can-pan')) {
      return;
    }

    event.preventDefault();
    const deltaMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.max(imageStage.clientWidth, imageStage.clientHeight)
        : 1;
    imagePanX -= event.deltaX * deltaMultiplier;
    imagePanY -= event.deltaY * deltaMultiplier;
    updateImageTransform();
  }

  function zoomImageFromWheel(event) {
    event.preventDefault();

    const bounds = imageStage.getBoundingClientRect();
    const previousFactor = imageZoomPercent / 100;
    const localX = (event.clientX - bounds.left - bounds.width / 2 - imagePanX) / previousFactor;
    const localY = (event.clientY - bounds.top - bounds.height / 2 - imagePanY) / previousFactor;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? Math.max(1, bounds.height) : 1;
    // Normalize wheel units and cap each event to keep mouse wheels predictable,
    // while small trackpad pinch deltas receive the full sensitivity multiplier.
    const exponent = clamp(-event.deltaY * unit * 0.002 * imageZoomSensitivity, -0.4, 0.4);
    const nextPercent = clamp(imageZoomPercent * Math.exp(exponent), 25, 800);
    const nextFactor = nextPercent / 100;

    imageZoomPercent = nextPercent;
    imagePanX = event.clientX - bounds.left - bounds.width / 2 - localX * nextFactor;
    imagePanY = event.clientY - bounds.top - bounds.height / 2 - localY * nextFactor;
    if (imageZoomPercent <= 100) {
      imagePanX = 0;
      imagePanY = 0;
    }
    updateImageTransform();
  }

  function updateImageDimensions() {
    const width = currentImageDimensions?.originalWidth || Math.round(detailImage.naturalWidth);
    const height = currentImageDimensions?.originalHeight || Math.round(detailImage.naturalHeight);
    const previewWidth = currentImageDimensions?.width || Math.round(detailImage.naturalWidth);
    const previewHeight = currentImageDimensions?.height || Math.round(detailImage.naturalHeight);
    const title = `Original: ${width} × ${height} · Preview: ${previewWidth} × ${previewHeight}${currentImageDimensions?.previewSource === 'embedded-raw' ? ' · Camera embedded RAW preview' : ''}`;
    document.querySelector('.image-dimensions').title = title;
    detailDimensions.title = title;
    const chinese = document.body.dataset.uiLanguage === 'zh';
    detailDimensions.textContent = width > 0 && height > 0 ? `${chinese ? '原图' : 'Original'} ${width} × ${height}${width !== previewWidth || height !== previewHeight ? ` · ${chinese ? '预览' : 'Preview'} ${previewWidth} × ${previewHeight}` : ''}` : '';
    imageWidth.textContent = String(Math.max(0, width));
    imageHeight.textContent = String(Math.max(0, height));
  }

  function clearImageDimensions() {
    imageWidth.textContent = '—';
    imageHeight.textContent = '—';
    detailDimensions.textContent = '';
    detailDimensions.removeAttribute('title');
  }

  function applyTextZoom() {
    textZoomPercent = clamp(Number(textZoom.value), 70, 180);
    detailView.style.setProperty('--text-zoom', `${textZoomPercent}%`);
    persistState();
  }

  function renderCaptionView() {
    if (isEditing || textPaneHidden) {
      return;
    }
    const mode = captionMode.value;
    captionPreview.classList.toggle('markdown-view', mode === 'markdown');
    captionPreview.classList.toggle('raw-view', mode === 'raw');
    captionPreview.classList.toggle('json-view', mode === 'json');

    if (!captionText.trim()) {
      captionPreview.textContent = captionExists
        ? 'Caption is empty. Select Edit to add text.'
        : 'No matching .txt caption. Select Edit to create one.';
      return;
    }

    if (mode === 'raw') {
      captionPreview.textContent = captionText;
      return;
    }

    if (mode === 'json') {
      renderJsonPreview();
      return;
    }

    setSanitizedMarkdown(renderedCaption);
  }

  function renderJsonPreview() {
    try {
      captionPreview.textContent = JSON.stringify(JSON.parse(captionText), null, 2);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captionPreview.textContent = `Invalid JSON: ${message}\n\n${captionText}`;
    }
  }

  function setSanitizedMarkdown(html) {
    const allowedTags = new Set([
      'a', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5',
      'h6', 'hr', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'table', 'tbody', 'td', 'th',
      'thead', 'tr', 'ul',
    ]);
    const template = document.createElement('template');
    template.innerHTML = html;

    for (const element of [...template.content.querySelectorAll('*')]) {
      const tag = element.tagName.toLocaleLowerCase();
      if (!allowedTags.has(tag)) {
        element.replaceWith(document.createTextNode(element.textContent || ''));
        continue;
      }

      const href = tag === 'a' ? element.getAttribute('href') || '' : '';
      for (const attribute of [...element.attributes]) {
        element.removeAttribute(attribute.name);
      }

      if (tag === 'a' && /^(https?:|mailto:)/i.test(href)) {
        element.setAttribute('href', href);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noreferrer noopener');
      }
    }

    captionPreview.replaceChildren(template.content);
  }

  function isTypingTarget(target) {
    return target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target instanceof HTMLButtonElement
      || target instanceof HTMLVideoElement;
  }

  function validResolution(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65536;
  }

  function validFfmpegPath(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !value.includes('\0');
  }

  function syncPaneControls() {
    const stacked = paneLayout === 'stacked' || (paneLayout === 'auto' && (detailView.clientWidth || window.innerWidth) <= 680);
    paneSplit.disabled = stacked || textPaneHidden;
    const help = document.querySelector('#pane-split-help');
    help.textContent = paneSplit.disabled ? help.dataset.inactive : help.dataset.active;
  }

  function syncSettingsControls() {
    resolutionSelect.value = ['0', '1024', '2048', '4096'].includes(String(gallerySettings.resolution)) ? String(gallerySettings.resolution) : 'custom';
    customResolution.value = String(gallerySettings.resolution);
    document.querySelector('#custom-resolution-field').classList.toggle('hidden', resolutionSelect.value !== 'custom');
    sensitivityInput.value = String(imageZoomSensitivity);
    document.querySelector('#zoom-sensitivity-value').textContent = `${imageZoomSensitivity}×`;
    layoutSelect.value = paneLayout;
    syncPaneControls();
    imageZoomInput.value = String(Math.round(imageZoomPercent));
    syncVideoRate(); syncVideoControls();
    document.querySelector('#video-compatibility').value = gallerySettings.videoCompatibility;
    document.querySelector('#video-max-height').value = String(gallerySettings.videoMaxHeight);
    videoQuality.value = String(gallerySettings.videoMaxHeight);
    ffmpegInput.value = gallerySettings.ffmpegPath;
    const inDetail = !detailView.classList.contains('hidden') && currentIndex >= 0;
    document.querySelector('#current-media-info').classList.toggle('hidden', !inDetail);
    document.querySelector('#preview-performance-field').classList.toggle('hidden', !inDetail || isCurrentVideo());
    document.querySelector('#image-zoom-field').classList.toggle('hidden', !inDetail || isCurrentVideo());
  }

  function openSettings(button) {
    cancelComparisonStart();
    settingsOpener = button;
    vscode.postMessage({ type: 'getPreviewPool' });
    syncSettingsControls();
    settingsDialog.showModal();
    settingsToggles.forEach((toggle) => toggle.setAttribute('aria-expanded', 'true'));
  }

  function closeSettings() {
    settingsDialog.close();
    settingsToggles.forEach((toggle) => toggle.setAttribute('aria-expanded', 'false'));
    if (videoFocused && settingsOpener?.id !== 'focus-settings') { document.querySelector('#exit-video-focus').focus({ preventScroll: true }); }
    else if (settingsOpener && !settingsOpener.closest('.hidden')) { settingsOpener.focus({ preventScroll: true }); }
  }

  function changeResolution(value) {
    customResolution.removeAttribute('aria-invalid'); settingsStatus.textContent = '';
    if (gallerySettings.resolution === value) { return; }
    gallerySettings.resolution = value; customResolution.value = String(value);
    persistState(); reloadImagePreviews();
  }

  function reloadImagePreviews() {
    if (comparison) { comparison.reload(); grid.clear(); renderGallery(); return; }
    clearDetailEntries(currentCaptionRequest);
    grid.clear(); renderGallery();
    if (!detailView.classList.contains('hidden') && filteredImages[currentIndex] && !isCurrentVideo()) {
      requestPreview(detailImage, filteredImages[currentIndex].id, true);
    }
  }

  function reloadCurrentVideo() {
    if (detailView.classList.contains('hidden')) { grid.clear(); renderGallery(); }
    if (!detailView.classList.contains('hidden') && isCurrentVideo() && filteredImages[currentIndex]) {
      const restore = captureVideoPlayback(); delete restore.positioned;
      requestVideo(filteredImages[currentIndex], false, false, restore);
    }
  }

  function persistState() {
    vscode.setState({
      thumbnailSize: Number(sizeInput.value),
      search: search.value,
      captionMode: captionMode.value,
      splitRatio,
      textZoomPercent,
      textPaneHidden: videoFocused ? captionBeforeFocus : textPaneHidden,
      videoPlaybackRate,
      paneLayout,
      zoomSensitivity: imageZoomSensitivity,
      gallerySettings: { ...gallerySettings },
      galleryScrollTop: grid.suspended ? grid.savedScroll : galleryView.scrollTop,
    });
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  vscode.postMessage({ type: 'ready' });
})();
