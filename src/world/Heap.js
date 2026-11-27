// @ts-check
/**
 * Indexed binary min-heap over integer items [0, capacity) with float keys and
 * decrease-key. Typed arrays only; no allocation after construction (pure).
 */
export class IndexedMinHeap {
  /** @param {number} capacity */
  constructor(capacity) {
    this.items = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    /** Heap slot of each item, or -1 when not in the heap. */
    this.pos = new Int32Array(capacity).fill(-1);
    this.size = 0;
  }

  clear() {
    for (let i = 0; i < this.size; i++) this.pos[this.items[i]] = -1;
    this.size = 0;
  }

  /** @param {number} item */
  has(item) {
    return this.pos[item] >= 0;
  }

  /**
   * Insert, or lower the key of an item already in the heap.
   * @param {number} item
   * @param {number} key
   */
  push(item, key) {
    let i = this.pos[item];
    if (i >= 0) {
      if (key >= this.keys[i]) return;
      this.keys[i] = key;
    } else {
      i = this.size++;
      this.items[i] = item;
      this.keys[i] = key;
      this.pos[item] = i;
    }
    this.up(i);
  }

  /** @returns {number} item with the smallest key, or -1 when empty */
  pop() {
    if (this.size === 0) return -1;
    const top = this.items[0];
    this.pos[top] = -1;
    const n = --this.size;
    if (n > 0) {
      this.items[0] = this.items[n];
      this.keys[0] = this.keys[n];
      this.pos[this.items[0]] = 0;
      this.down(0);
    }
    return top;
  }

  /** @param {number} i */
  up(i) {
    const items = this.items, keys = this.keys, pos = this.pos;
    const it = items[i], k = keys[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      items[i] = items[p]; keys[i] = keys[p]; pos[items[i]] = i;
      i = p;
    }
    items[i] = it; keys[i] = k; pos[it] = i;
  }

  /** @param {number} i */
  down(i) {
    const items = this.items, keys = this.keys, pos = this.pos, n = this.size;
    const it = items[i], k = keys[i];
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= k) break;
      items[i] = items[c]; keys[i] = keys[c]; pos[items[i]] = i;
      i = c;
    }
    items[i] = it; keys[i] = k; pos[it] = i;
  }
}
