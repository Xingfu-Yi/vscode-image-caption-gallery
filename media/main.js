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
  const saveState = document.querySelector('#save-state');

  const persisted = vscode.getState() || {};
  const defaultSize = Number(document.body.dataset.defaultThumbnailSize || 220);
  let images = [];
  let filteredImages = [];
  let currentIndex = -1;
  let saveTimer;
  let currentCaptionRequest = '';

  sizeInput.value = String(persisted.thumbnailSize || defaultSize);
  search.value = persisted.search || '';
  applyThumbnailSize();

  sizeInput.addEventListener('input', applyThumbnailSize);
  search.addEventListener('input', renderGallery);
  document.querySelector('#refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
  document.querySelector('#back').addEventListener('click', showGallery);
  document.querySelector('#previous').addEventListener('click', () => move(-1));
  document.querySelector('#next').addEventListener('click', () => move(1));

  caption.addEventListener('input', () => {
    saveState.textContent = 'Unsaved';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentCaption, 650);
  });

  window.addEventListener('keydown', (event) => {
    if (!detailView.classList.contains('hidden')) {
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        move(-1);
      } else if (event.altKey && event.key === 'ArrowRight') {
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
      renderGallery();
      return;
    }

    if (message.type === 'caption' && message.id === currentCaptionRequest) {
      caption.value = message.caption;
      caption.disabled = false;
      saveState.textContent = 'Saved';
      caption.focus();
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

  function persistState() {
    vscode.setState({
      thumbnailSize: Number(sizeInput.value),
      search: search.value,
    });
  }

  vscode.postMessage({ type: 'ready' });
})();
