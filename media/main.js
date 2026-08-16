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
  const detailImage = document.querySelector('#detail-image');
  const detailPath = document.querySelector('#detail-path');
  const position = document.querySelector('#position');
  const caption = document.querySelector('#caption');
  const captionPreview = document.querySelector('#caption-preview');
  const captionMode = document.querySelector('#caption-mode');
  const captionHint = document.querySelector('#caption-hint');
  const saveState = document.querySelector('#save-state');

  const persisted = vscode.getState() || {};
  const defaultSize = Number(document.body.dataset.defaultThumbnailSize || 220);
  let images = [];
  let filteredImages = [];
  let currentIndex = -1;
  let saveTimer;
  let currentCaptionRequest = '';
  let renderedCaption = '';
  let renderPending = false;

  sizeInput.value = String(persisted.thumbnailSize || defaultSize);
  search.value = persisted.search || '';
  captionMode.value = ['markdown', 'raw', 'json'].includes(persisted.captionMode)
    ? persisted.captionMode
    : 'markdown';
  applyThumbnailSize();

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
  captionMode.addEventListener('change', changeCaptionMode);

  caption.addEventListener('input', () => {
    renderedCaption = '';
    renderPending = false;
    saveState.textContent = 'Unsaved';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentCaption, 650);
  });

  window.addEventListener('keydown', (event) => {
    if (!detailView.classList.contains('hidden')) {
      const captionHasFocus = document.activeElement === caption;
      const plainArrow = !captionHasFocus
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey;

      if ((event.altKey || plainArrow) && event.key === 'ArrowLeft') {
        event.preventDefault();
        move(-1);
      } else if ((event.altKey || plainArrow) && event.key === 'ArrowRight') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        showGallery();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveCurrentCaption();
      }
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
      images = message.images;
      if (message.initialImageId) {
        search.value = '';
      }
      renderGallery();
      if (message.initialImageId) {
        openDetail(message.initialImageId);
      }
      return;
    }

    if (message.type === 'caption' && message.id === currentCaptionRequest) {
      caption.value = message.caption;
      renderedCaption = message.renderedCaption;
      renderPending = false;
      caption.disabled = false;
      saveState.textContent = 'Saved';
      renderCaptionView();
      return;
    }

    if (message.type === 'renderedCaption' && message.id === currentCaptionRequest) {
      renderedCaption = message.renderedCaption;
      renderPending = false;
      renderCaptionView();
      return;
    }

    if (message.type === 'saved' && filteredImages[currentIndex]?.id === message.id) {
      saveState.textContent = 'Saved';
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
    gallery.replaceChildren();

    const fragment = document.createDocumentFragment();
    for (const image of filteredImages) {
      const card = document.createElement('button');
      card.className = 'image-card';
      card.type = 'button';
      card.title = image.relativePath;
      card.addEventListener('click', () => openDetail(image.id));

      const thumbnail = document.createElement('img');
      thumbnail.src = image.source;
      thumbnail.alt = image.name;
      thumbnail.loading = 'lazy';

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
    loadCurrentImage();
    detailView.focus({ preventScroll: true });
  }

  function loadCurrentImage() {
    const image = filteredImages[currentIndex];
    if (!image) {
      return;
    }
    currentCaptionRequest = image.id;
    detailImage.src = image.source;
    detailImage.alt = image.name;
    detailPath.textContent = image.relativePath;
    detailPath.title = image.relativePath;
    position.textContent = `${currentIndex + 1} / ${filteredImages.length}`;
    caption.value = '';
    caption.disabled = true;
    renderedCaption = '';
    renderPending = false;
    captionPreview.textContent = 'Loading caption…';
    saveState.textContent = 'Loading…';
    document.querySelector('#previous').disabled = currentIndex === 0;
    document.querySelector('#next').disabled = currentIndex === filteredImages.length - 1;
    vscode.postMessage({ type: 'loadCaption', id: image.id });
  }

  function move(offset) {
    flushPendingSave();
    const nextIndex = Math.max(0, Math.min(filteredImages.length - 1, currentIndex + offset));
    if (nextIndex === currentIndex) {
      return;
    }
    currentIndex = nextIndex;
    loadCurrentImage();
  }

  function showGallery() {
    flushPendingSave();
    detailView.classList.add('hidden');
    galleryView.classList.remove('hidden');
  }

  function flushPendingSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      saveCurrentCaption();
    }
  }

  function saveCurrentCaption() {
    const image = filteredImages[currentIndex];
    if (!image || caption.disabled) {
      return;
    }
    saveState.textContent = 'Saving…';
    vscode.postMessage({ type: 'saveCaption', id: image.id, caption: caption.value });
  }

  function changeCaptionMode() {
    if (captionMode.value !== 'raw') {
      flushPendingSave();
    }
    renderCaptionView();
    persistState();

    if (captionMode.value === 'raw' && !caption.disabled) {
      caption.focus({ preventScroll: true });
    } else {
      detailView.focus({ preventScroll: true });
    }
  }

  function renderCaptionView() {
    const mode = captionMode.value;
    const showRaw = mode === 'raw';
    caption.classList.toggle('hidden', !showRaw);
    captionPreview.classList.toggle('hidden', showRaw);
    captionPreview.classList.toggle('markdown-view', mode === 'markdown');
    captionPreview.classList.toggle('json-view', mode === 'json');

    if (showRaw) {
      captionHint.textContent = 'Auto-saves after typing · Ctrl/Cmd+S saves · Alt+←/→ switches images · Esc returns';
      return;
    }

    if (caption.disabled) {
      captionPreview.textContent = 'Loading caption…';
      return;
    }

    if (mode === 'json') {
      renderJsonPreview();
      captionHint.textContent = 'Formatted JSON preview · Select Raw text to edit · ←/→ switches images · Esc returns';
      return;
    }

    captionHint.textContent = 'Rendered Markdown · Select Raw text to edit · ←/→ switches images · Esc returns';
    if (!caption.value.trim()) {
      captionPreview.textContent = 'No caption yet. Select Raw text to start writing.';
      return;
    }

    if (renderedCaption) {
      setSanitizedMarkdown(renderedCaption);
      return;
    }

    if (!renderPending) {
      renderPending = true;
      captionPreview.textContent = 'Rendering Markdown…';
      vscode.postMessage({
        type: 'renderCaption',
        id: currentCaptionRequest,
        caption: caption.value,
      });
    }
  }

  function renderJsonPreview() {
    if (!caption.value.trim()) {
      captionPreview.textContent = 'No caption yet.';
      return;
    }

    try {
      captionPreview.textContent = JSON.stringify(JSON.parse(caption.value), null, 2);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captionPreview.textContent = `Invalid JSON: ${message}\n\n${caption.value}`;
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
    });
  }

  vscode.postMessage({ type: 'ready' });
})();
