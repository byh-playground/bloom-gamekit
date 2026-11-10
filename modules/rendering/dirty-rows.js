/**
 * Rows marked since the last upload, without per-mark allocation: `positions[row]` is the row's index in `rows` plus
 * one (0 when unmarked), so add, delete and has are O(1) and iteration visits only marked rows. Each row may carry one
 * integer value (the pose matrix cache keeps the part count there).
 */
export class DirtyRows {
    constructor() {
        this.positions = new Int32Array(0);
        this.rows = new Int32Array(16);
        this.values = new Int32Array(16);
        this.size = 0;
    }
    _growPositions(row) {
        const NEXT = new Int32Array(Math.max(32, row + 1, this.positions.length * 2));
        NEXT.set(this.positions);
        this.positions = NEXT;
    }
    has(row) {
        return row < this.positions.length && this.positions[row] !== 0;
    }
    add(row, value = 0) {
        if (row >= this.positions.length) {
            this._growPositions(row);
        }
        const AT = this.positions[row];
        if (AT) {
            this.values[AT - 1] = value;
            return;
        }
        if (this.size === this.rows.length) {
            const ROWS = new Int32Array(this.size * 2),
                VALUES = new Int32Array(this.size * 2);
            ROWS.set(this.rows);
            VALUES.set(this.values);
            this.rows = ROWS;
            this.values = VALUES;
        }
        this.rows[this.size] = row;
        this.values[this.size] = value;
        this.positions[row] = ++this.size;
    }
    delete(row) {
        const AT = row < this.positions.length ? this.positions[row] : 0;
        if (!AT) {
            return false;
        }
        // The last marked row takes the removed slot; upload order does not depend on mark order.
        const LAST = --this.size;
        if (AT - 1 !== LAST) {
            const MOVED = this.rows[LAST];
            this.rows[AT - 1] = MOVED;
            this.values[AT - 1] = this.values[LAST];
            this.positions[MOVED] = AT;
        }
        this.positions[row] = 0;
        return true;
    }
    clear() {
        for (let i = 0; i < this.size; i++) {
            this.positions[this.rows[i]] = 0;
        }
        this.size = 0;
    }
}
