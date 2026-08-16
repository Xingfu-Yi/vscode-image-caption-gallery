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
  const position = document.querySelector('#position');
  const captionPreview = document.querySelector('#caption-preview');
  const captionMode = document.querySelector('#caption-mode');
  const splitter = document.querySelector('#splitter');
  const imageZoom = document.querySelector('#image-zoom');
  const imageZoomValue = document.querySelector('#image-zoom-value');
  const fitImageButton = document.querySelector('#fit-image');
  const textZoom = document.querySelector('#text-zoom');
  const textZoomValue = document.querySelector('#text-zoom-value');

  const persisted = vscode.getState() || {};
  const defaultSize = Number(document.body.dataset.defaultThumbnailSize || 220);
  let images = [];
  let filteredImages = [];
  let currentIndex = -1;
  let currentCaptionRequest = '';
  let captionText = '';
  let renderedCaption = '';
  let splitRatio = clamp(Number(persisted.splitRatio) || 0.64, 0.3, 0.8);
  let imageZoomPercent = clamp(Number(persisted.imageZoomPercent) || 100, 25, 400);
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
  imageZoom.value = String(imageZoomPercent);
  imageZoomValue.value = `${imageZoomPercent}%`;
  textZoom.value = String(textZoomPercent);
  applyThumbnailSize();
  applySplitRatio(splitRatio, false);
  applyTextZoom();

  sizeInput.addEventListener('input', applyThumbnailSize);
  search.addEventListener('input', renderGallery);
  document.querySelector('#refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
  document.querySelector('#back').addEventListener('click', showGallery);
  document.querySelector('#previous').addEventListener('click', () => move(-1));
  document.querySelector('#next').addEventListener('click', () => move(1));
  document.querySelector('.image-pane').addEventListener('click', () => {
    detailView.focus({ preventScroll: true });
  });
  imageZoom.addEventListener('input', () => applyImageZoom(Number(imageZoom.value)));
  fitImageButton.addEventListener('click', fitImageToPane);
  detailImage.addEventListener('load', () => {
    imagePanX = 0;
    imagePanY = 0;
    detailImage.classList.remove('loading');
    updateImageTransform();
  });
  imageStage.addEventListener('pointerdown', startImagePan);
  imageStage.addEventListener('pointermove', moveImagePan);
  imageStage.addEventListener('pointerup', finishImagePan);
  imageStage.addEventListener('pointercancel', finishImagePan);
  imageStage.addEventListener('dblclick', fitImageToPane);
  imageStage.addEventListener('wheel', zoomImageFromWheel, { passive: false });
  captionMode.addEventListener('change', () => {
    renderCaptionView();
    persistState();
  });
  textZoom.addEventListener('input', applyTextZoom);
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

    const focusedControl = document.activeElement === captionMode
      || document.activeElement === imageZoom
      || document.activeElement === textZoom
      || document.activeElement === splitter;
    const navigationKey = !focusedControl
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey;
    if (navigationKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    } else if (navigationKey && event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      showGallery();
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

    if (message.type === 'caption' && message.id === currentCaptionRequest) {
      captionText = message.caption;
      renderedCaption = message.renderedCaption;
      renderCaptionView();
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
    loadCurrentImage();
    detailView.focus({ preventScroll: true });
  }

  function loadCurrentImage() {
    const image = filteredImages[currentIndex];
    if (!image) {
      return;
    }

    currentCaptionRequest = image.id;
    captionText = '';
    renderedCaption = '';
    imagePanX = 0;
    imagePanY = 0;
    detailImage.classList.add('loading');
    detailImage.src = image.source;
    detailImage.alt = image.name;
    captionPreview.textContent = 'Loading caption…';
    updateDetailMetadata();
    vscode.postMessage({ type: 'loadCaption', id: image.id });
    if (detailImage.complete && detailImage.naturalWidth > 0) {
      detailImage.classList.remove('loading');
      requestAnimationFrame(updateImageTransform);
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

  function updateDetailMetadata() {
    const image = filteredImages[currentIndex];
    if (!image) {
      return;
    }
    detailPath.textContent = image.relativePath;
    detailPath.title = image.relativePath;
    position.textContent = `${currentIndex + 1} / ${filteredImages.length}`;
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

  function applyImageZoom(nextPercent, shouldPersist = true) {
    const previousZoom = imageZoomPercent;
    imageZoomPercent = clamp(Number(nextPercent) || 100, 25, 400);
    const panScale = previousZoom > 0 ? imageZoomPercent / previousZoom : 1;
    imagePanX *= panScale;
    imagePanY *= panScale;
    if (imageZoomPercent <= 100) {
      imagePanX = 0;
      imagePanY = 0;
    }
    imageZoom.value = String(imageZoomPercent);
    imageZoomValue.value = `${imageZoomPercent}%`;
    updateImageTransform();
    if (shouldPersist) {
      persistState();
    }
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

  function zoomImageFromWheel(event) {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();

    const bounds = imageStage.getBoundingClientRect();
    const previousFactor = imageZoomPercent / 100;
    const localX = (event.clientX - bounds.left - bounds.width / 2 - imagePanX) / previousFactor;
    const localY = (event.clientY - bounds.top - bounds.height / 2 - imagePanY) / previousFactor;
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextPercent = clamp(imageZoomPercent + direction * 10, 25, 400);
    const nextFactor = nextPercent / 100;

    imageZoomPercent = nextPercent;
    imagePanX = event.clientX - bounds.left - bounds.width / 2 - localX * nextFactor;
    imagePanY = event.clientY - bounds.top - bounds.height / 2 - localY * nextFactor;
    if (imageZoomPercent <= 100) {
      imagePanX = 0;
      imagePanY = 0;
    }
    imageZoom.value = String(imageZoomPercent);
    imageZoomValue.value = `${imageZoomPercent}%`;
    updateImageTransform();
    persistState();
  }

  function applyTextZoom() {
    textZoomPercent = clamp(Number(textZoom.value), 70, 180);
    detailView.style.setProperty('--text-zoom', `${textZoomPercent}%`);
    textZoomValue.value = `${textZoomPercent}%`;
    persistState();
  }

  function renderCaptionView() {
    const mode = captionMode.value;
    captionPreview.classList.toggle('markdown-view', mode === 'markdown');
    captionPreview.classList.toggle('raw-view', mode === 'raw');
    captionPreview.classList.toggle('json-view', mode === 'json');

    if (!captionText.trim()) {
      captionPreview.textContent = 'No caption available.';
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

  function persistState() {
    vscode.setState({
      thumbnailSize: Number(sizeInput.value),
      search: search.value,
      captionMode: captionMode.value,
      splitRatio,
      imageZoomPercent,
      textZoomPercent,
    });
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  vscode.postMessage({ type: 'ready' });
})();
