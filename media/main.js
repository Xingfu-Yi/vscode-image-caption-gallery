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
  const detailImage = document.querySelector('#detail-image');
  const detailPath = document.querySelector('#detail-path');
  const imageWidth = document.querySelector('#image-width');
  const imageHeight = document.querySelector('#image-height');
  const captionPane = document.querySelector('.caption-pane');
  const captionPreview = document.querySelector('#caption-preview');
  const captionEditor = document.querySelector('#caption-editor');
  const captionMode = document.querySelector('#caption-mode');
  const captionModeControl = document.querySelector('#caption-mode-control');
  const splitter = document.querySelector('#splitter');
  const textZoom = document.querySelector('#text-zoom');
  const editingLabel = document.querySelector('#editing-label');
  const editState = document.querySelector('#edit-state');
  const editCaption = document.querySelector('#edit-caption');
  const editActions = document.querySelector('#edit-actions');
  const cancelEdit = document.querySelector('#cancel-edit');
  const saveEdit = document.querySelector('#save-edit');
  const hideText = document.querySelector('#hide-text');
  const showText = document.querySelector('#show-text');

  const persisted = vscode.getState() || {};
  const defaultSize = Number(document.body.dataset.defaultThumbnailSize || 220);
  let images = [];
  let filteredImages = [];
  let currentIndex = -1;
  let currentCaptionRequest = '';
  let captionText = '';
  let renderedCaption = '';
  let captionExists = false;
  let captionRevision = 'missing';
  let captionLoaded = false;
  let isEditing = false;
  let isSaving = false;
  let lastReportedDirty = false;
  let pendingAction = null;
  let activeDecisionRequest = '';
  let decisionSequence = 0;
  let splitRatio = clamp(Number(persisted.splitRatio) || 0.64, 0.3, 0.8);
  let textPaneHidden = Boolean(persisted.textPaneHidden);
  let imageZoomPercent = 100;
  let imagePanX = 0;
  let imagePanY = 0;
  let imagePanGesture = null;
  let imageResizeObserver = null;
  let textZoomPercent = clamp(Number(persisted.textZoomPercent) || 100, 70, 180);
  const thumbnailObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(loadVisibleThumbnails, { rootMargin: '600px 0px' })
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

  sizeInput.addEventListener('input', applyThumbnailSize);
  search.addEventListener('input', renderGallery);
  document.querySelector('#refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
  document.querySelector('#back').addEventListener('click', () => requestGuardedAction({ type: 'gallery' }));
  document.querySelector('#previous').addEventListener('click', () => requestGuardedAction({ type: 'move', offset: -1 }));
  document.querySelector('#next').addEventListener('click', () => requestGuardedAction({ type: 'move', offset: 1 }));
  document.querySelector('.image-pane').addEventListener('click', () => {
    detailView.focus({ preventScroll: true });
  });
  detailImage.addEventListener('load', () => {
    imagePanX = 0;
    imagePanY = 0;
    detailImage.classList.remove('loading');
    updateImageDimensions();
    updateImageTransform();
  });
  imageStage.addEventListener('pointerdown', startImagePan);
  imageStage.addEventListener('pointermove', moveImagePan);
  imageStage.addEventListener('pointerup', finishImagePan);
  imageStage.addEventListener('pointercancel', finishImagePan);
  imageStage.addEventListener('dblclick', fitImageToPane);
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
  hideText.addEventListener('click', () => requestGuardedAction({ type: 'hideText' }));
  showText.addEventListener('click', () => setTextPaneHidden(false));
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
    applySplitRatio(splitRatio, false);
    if (!detailView.classList.contains('hidden')) {
      requestAnimationFrame(updateImageTransform);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (detailView.classList.contains('hidden')) {
      return;
    }

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

    const navigationKey = !isTypingTarget(event.target)
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey;
    if (navigationKey && event.key === 'ArrowLeft') {
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
    const message = event.data;
    if (message.type === 'loading') {
      empty.textContent = 'Loading images…';
      empty.classList.remove('hidden');
      return;
    }

    if (message.type === 'images') {
      const activeImageId = detailView.classList.contains('hidden') ? '' : currentCaptionRequest;
      images = message.images;
      if (message.initialImageId) {
        search.value = '';
      }
      renderGallery();
      const activeIndex = activeImageId
        ? filteredImages.findIndex((image) => image.id === activeImageId)
        : -1;
      if (activeIndex >= 0) {
        currentIndex = activeIndex;
        updateDetailMetadata();
      } else if (message.initialImageId) {
        openDetail(message.initialImageId);
      }
      return;
    }

    if (message.type === 'initialImage') {
      images = [message.image];
      search.value = '';
      renderGallery();
      openDetail(message.image.id);
      return;
    }

    if (message.id && message.id !== currentCaptionRequest) {
      return;
    }

    if (message.type === 'caption') {
      applyCaptionMessage(message);
      exitEditMode();
      return;
    }

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

    if (message.type === 'captionError') {
      captionLoaded = false;
      captionPreview.textContent = `Could not load caption: ${message.message}`;
      editCaption.disabled = true;
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
      empty.textContent = `Could not load images: ${message.message}`;
      empty.classList.remove('hidden');
    }
  });

  function applyThumbnailSize() {
    const size = Number(sizeInput.value);
    document.documentElement.style.setProperty('--thumbnail-size', `${size}px`);
    sizeValue.value = `${size}px`;
    persistState();
  }

  function renderGallery() {
    const query = search.value.trim().toLocaleLowerCase();
    filteredImages = images.filter((image) => image.relativePath.toLocaleLowerCase().includes(query));
    thumbnailObserver?.disconnect();
    gallery.replaceChildren();

    const fragment = document.createDocumentFragment();
    for (const image of filteredImages) {
      const card = document.createElement('button');
      card.className = 'image-card';
      card.type = 'button';
      card.title = image.relativePath;
      card.addEventListener('click', () => openDetail(image.id));

      const thumbnail = document.createElement('img');
      thumbnail.alt = image.name;
      thumbnail.loading = 'lazy';
      if (thumbnailObserver) {
        thumbnail.dataset.source = image.source;
        thumbnailObserver.observe(thumbnail);
      } else {
        thumbnail.src = image.source;
      }

      const filename = document.createElement('span');
      filename.className = 'filename';
      filename.textContent = image.name;

      card.append(thumbnail, filename);
      fragment.append(card);
    }

    gallery.append(fragment);
    count.textContent = `${filteredImages.length} / ${images.length} images`;
    empty.textContent = images.length === 0 ? 'No supported images found.' : 'No matching images.';
    empty.classList.toggle('hidden', filteredImages.length > 0);
    persistState();
  }

  function openDetail(id) {
    currentIndex = filteredImages.findIndex((image) => image.id === id);
    if (currentIndex < 0) {
      return;
    }
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

    exitEditMode();
    currentCaptionRequest = image.id;
    captionText = '';
    renderedCaption = '';
    captionExists = false;
    captionRevision = 'missing';
    captionLoaded = false;
    imageZoomPercent = 100;
    imagePanX = 0;
    imagePanY = 0;
    imageWidth.textContent = '—';
    imageHeight.textContent = '—';
    detailImage.classList.add('loading');
    detailImage.src = image.source;
    detailImage.alt = image.name;
    captionPreview.textContent = 'Loading caption…';
    editCaption.disabled = true;
    updateDetailMetadata();
    vscode.postMessage({ type: 'loadCaption', id: image.id });
    if (detailImage.complete && detailImage.naturalWidth > 0) {
      detailImage.classList.remove('loading');
      updateImageDimensions();
      requestAnimationFrame(updateImageTransform);
    }
  }

  function requestGuardedAction(action) {
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
    imageResizeObserver?.disconnect();
    detailView.classList.add('hidden');
    galleryView.classList.remove('hidden');
  }

  function enterEditMode() {
    if (!captionLoaded || isEditing) {
      return;
    }
    isEditing = true;
    captionEditor.value = captionText;
    updateEditControls();
    updateDirtyState();
    captionEditor.focus({ preventScroll: true });
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
    captionModeControl.classList.toggle('hidden', isEditing);
    editingLabel.classList.toggle('hidden', !isEditing);
    editCaption.classList.toggle('hidden', isEditing);
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
    captionText = typeof message.caption === 'string' ? message.caption : '';
    renderedCaption = typeof message.renderedCaption === 'string' ? message.renderedCaption : '';
    captionExists = Boolean(message.exists);
    captionRevision = typeof message.revision === 'string' ? message.revision : 'missing';
    captionLoaded = true;
    editCaption.disabled = false;
    renderCaptionView();
  }

  function setTextPaneHidden(hidden, shouldPersist = true) {
    textPaneHidden = hidden;
    detailView.classList.toggle('text-hidden', hidden);
    showText.classList.toggle('hidden', !hidden);
    hideText.setAttribute('aria-expanded', String(!hidden));
    if (shouldPersist) {
      persistState();
    }
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
    document.querySelector('#previous').disabled = currentIndex === 0;
    document.querySelector('#next').disabled = currentIndex === filteredImages.length - 1;
  }

  function loadVisibleThumbnails(entries, observer) {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      const thumbnail = entry.target;
      const source = thumbnail.dataset.source;
      if (source) {
        thumbnail.src = source;
        delete thumbnail.dataset.source;
      }
      observer.unobserve(thumbnail);
    }
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
    const availableWidth = detailView.clientWidth || window.innerWidth;
    const minimumRatio = Math.max(0.3, 260 / availableWidth);
    const maximumRatio = Math.min(0.8, Math.max(minimumRatio, (availableWidth - 287) / availableWidth));
    splitRatio = clamp(nextRatio, minimumRatio, maximumRatio);
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
    imageZoomPercent = clamp(Number(nextPercent) || 100, 25, 400);
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
    if (event) {
      event.preventDefault();
    }
    imagePanX = 0;
    imagePanY = 0;
    applyImageZoom(100);
    detailView.focus({ preventScroll: true });
  }

  function updateImageTransform() {
    if (
      detailView.classList.contains('hidden')
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
    if (event.button !== 0 || !imageStage.classList.contains('can-pan')) {
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
    const nextPercent = clamp(imageZoomPercent * Math.exp(-event.deltaY * 0.002), 25, 400);
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
    const width = Math.round(detailImage.naturalWidth);
    const height = Math.round(detailImage.naturalHeight);
    imageWidth.textContent = String(Math.max(0, width));
    imageHeight.textContent = String(Math.max(0, height));
  }

  function applyTextZoom() {
    textZoomPercent = clamp(Number(textZoom.value), 70, 180);
    detailView.style.setProperty('--text-zoom', `${textZoomPercent}%`);
    persistState();
  }

  function renderCaptionView() {
    if (isEditing) {
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
      || target instanceof HTMLButtonElement;
  }

  function persistState() {
    vscode.setState({
      thumbnailSize: Number(sizeInput.value),
      search: search.value,
      captionMode: captionMode.value,
      splitRatio,
      textZoomPercent,
      textPaneHidden,
    });
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  vscode.postMessage({ type: 'ready' });
})();
