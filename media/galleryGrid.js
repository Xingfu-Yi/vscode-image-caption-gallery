(() => {
  // Keep DOM and decoded image memory proportional to the viewport, not the dataset.
  class GalleryGrid {
    constructor(element, viewport, createCard, releaseCard, onScroll = () => {}) {
      this.element = element;
      this.viewport = viewport;
      this.createCard = createCard;
      this.releaseCard = releaseCard;
      this.items = [];
      this.cards = new Map();
      this.size = 220;
      this.suspended = false;
      this.frame = 0;
      viewport.addEventListener('scroll', () => { this.schedule(); onScroll(); }, { passive: true });
      this.observer = new ResizeObserver(() => this.schedule());
      this.observer.observe(viewport);
      element.addEventListener('keydown', (event) => this.navigate(event));
    }

    setItems(items, resetScroll = false) {
      this.items = items;
      if (resetScroll) { this.viewport.scrollTop = 0; }
      this.render();
    }

    setSize(size) {
      this.size = size;
      this.render();
    }

    schedule() {
      if (this.frame || this.suspended) { return; }
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
    }

    suspend() {
      if (this.suspended) { return; }
      this.suspended = true;
      this.savedScroll = this.viewport.scrollTop;
      if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
      this.clear();
    }

    resume() {
      if (!this.suspended) { this.render(); return; }
      this.suspended = false;
      this.viewport.scrollTop = this.savedScroll || 0;
      this.render();
    }

    clear() {
      for (const card of this.cards.values()) { this.releaseCard(card); card.remove(); }
      this.cards.clear();
    }

    render() {
      if (this.suspended) { return; }
      const width = Math.max(1, (this.viewport.clientWidth || window.innerWidth) - 36);
      const columns = Math.max(1, Math.floor((width + 16) / (this.size + 16)));
      const cardWidth = (width - (columns - 1) * 16) / columns;
      const cardHeight = this.size + 46, step = cardHeight + 16;
      this.columns = columns; this.step = step;
      const rows = Math.ceil(this.items.length / columns);
      this.element.style.height = `${rows ? 36 + rows * step - 16 : 0}px`;
      const top = this.element.offsetTop;
      const firstRow = Math.max(0, Math.floor((this.viewport.scrollTop - top - 18) / step) - 2);
      const lastRow = Math.min(rows, Math.ceil((this.viewport.scrollTop + (this.viewport.clientHeight || window.innerHeight) - top) / step) + 2);
      const start = Math.min(this.items.length, firstRow * columns), end = Math.max(start, Math.min(this.items.length, lastRow * columns));
      for (const [index, card] of this.cards) {
        if (index < start || index >= end || card.dataset.mediaId !== this.items[index]?.id) {
          this.releaseCard(card); card.remove(); this.cards.delete(index);
        }
      }
      for (let index = start; index < end; index++) {
        let card = this.cards.get(index);
        if (!card) {
          card = this.createCard(this.items[index]);
          card.dataset.mediaId = this.items[index].id;
          card.dataset.index = String(index);
          const next = [...this.cards.keys()].filter((key) => key > index).sort((a, b) => a - b)[0];
          this.element.insertBefore(card, this.cards.get(next) || null);
          this.cards.set(index, card);
        }
        card.style.width = `${cardWidth}px`;
        card.style.height = `${cardHeight}px`;
        card.style.transform = `translate(${18 + index % columns * (cardWidth + 16)}px, ${18 + Math.floor(index / columns) * step}px)`;
      }
    }

    navigate(event) {
      const card = event.target.closest('.image-card');
      if (!card || event.altKey || event.metaKey) { return; }
      const index = Number(card.dataset.index);
      let next;
      if (event.key === 'ArrowRight' || (event.key === 'Tab' && !event.shiftKey)) { next = index + 1; }
      else if (event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey)) { next = index - 1; }
      else if (event.key === 'ArrowDown') { next = index + this.columns; }
      else if (event.key === 'ArrowUp') { next = index - this.columns; }
      else if (event.key === 'Home') { next = event.ctrlKey ? 0 : index - index % this.columns; }
      else if (event.key === 'End') { next = event.ctrlKey ? this.items.length - 1 : Math.min(this.items.length - 1, index + this.columns - 1 - index % this.columns); }
      else { return; }
      if (next < 0 || next >= this.items.length) { return; }
      event.preventDefault();
      const top = this.element.offsetTop + 18 + Math.floor(next / this.columns) * this.step;
      const height = this.viewport.clientHeight || window.innerHeight;
      const toolbar = this.element.offsetTop;
      if (top < this.viewport.scrollTop + toolbar) { this.viewport.scrollTop = top - toolbar; }
      else if (top + this.step > this.viewport.scrollTop + height) { this.viewport.scrollTop = top + this.step - height; }
      this.render();
      this.cards.get(next)?.focus({ preventScroll: true });
    }
  }
  window.GalleryGrid = GalleryGrid;
})();
