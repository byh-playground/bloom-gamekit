export interface UniformGridOptions {
    /** Edge length of one cell, in coordinate units. */
    cellSize: number;
    /** Extent covered by the grid; the cell counts are `ceil(width / cellSize)` and `ceil(height / cellSize)`. */
    width: number;
    height: number;
    /** Coordinate of cell (0, 0)'s lower corner. Defaults to 0. */
    originX?: number;
    originY?: number;
    /**
     * What happens to coordinates outside the world.
     * `'clamp'` puts them in the nearest edge cell; `'overflow'` keeps them in a separate list that every query
     * checks against its exact rectangle. Required, because the two rules give different results.
     */
    outside: 'clamp' | 'overflow';
    /** Number of item groups (for example one per side). 0 means none. Needs `outside: 'clamp'` and not `'identity'`. */
    groups?: number;
    /**
     * How `move`, `remove` and `has` find an item again.
     * `false` (default): rebuild only (`clear` + `insert`), items may be any value.
     * `'index'`: items are integers from 0 to 2^24 - 1, tracked in typed arrays (O(1) move and remove).
     * `'identity'`: items are objects, tracked in a Map (move and remove scan the item's cell).
     */
    track?: false | 'index' | 'identity';
}

/** A grid of point items. Every item sits in one cell (its center cell), so queries return cell-level candidates. */
export class UniformGrid<Item = number> {
    constructor(options: UniformGridOptions);
    readonly cellSize: number;
    readonly width: number;
    readonly height: number;
    readonly originX: number;
    readonly originY: number;
    readonly cols: number;
    readonly rows: number;
    /** `cols * rows`. Cell numbers run from 0 to `cellTotal - 1`; `cellTotal` itself is the outside-world list. */
    readonly cellTotal: number;
    readonly outside: 'clamp' | 'overflow';
    readonly groups: number;
    readonly track: false | 'index' | 'identity';
    /** Cell numbers that held items since the last `clear`, in first-use order. Read only. */
    readonly usedCells: readonly number[];

    /** Empties the grid. Only used cells are touched and their bucket arrays are reused. */
    clear(): void;
    /** Column of a coordinate: clamped to 0..cols-1 for `'clamp'`, unclamped for `'overflow'`. */
    cellX(x: number): number;
    cellY(y: number): number;

    /**
     * Appends an item to the bucket of its cell. On a tracked grid an item that is already present is removed first.
     * Throws on a NaN coordinate when `outside` is `'clamp'`.
     */
    insert(item: Item, x: number, y: number, group?: number): void;
    /**
     * Moves an item to the cell of (x, y) when its cell changed (remove, then append to the new cell).
     * Does nothing when the cell and group are unchanged. An unknown item is inserted. Needs `track`.
     * `group` defaults to the item's current group.
     */
    move(item: Item, x: number, y: number, group?: number): void;
    /** Removes an item; the last item of its bucket takes its place. Returns whether it was present. Needs `track`. */
    remove(item: Item): boolean;
    /** Needs `track`. */
    has(item: Item): boolean;
    /** Cell number the item is in (`cellTotal` for the outside-world list), or -1. Needs `track`. */
    keyOf(item: Item): number;
    /** Cell number a coordinate would be inserted into (`cellTotal` when outside the world with `'overflow'`). */
    keyAt(x: number, y: number): number;

    /**
     * Fills `out` (cleared first) with the items of the cells the rectangle covers: rows first (y outer, x inner),
     * bucket order inside a cell. With `'overflow'`, items outside the world follow, in list order, if they lie inside
     * the rectangle. `group >= 0` returns only that group.
     */
    queryRect<Out extends Item[]>(
        minX: number,
        minY: number,
        maxX: number,
        maxY: number,
        out: Out,
        group?: number,
    ): Out;
    /** Same as `queryRect(x - radius, y - radius, x + radius, y + radius, ...)`: candidates, not an exact distance test. */
    queryCircle<Out extends Item[]>(x: number, y: number, radius: number, out: Out, group?: number): Out;
    /**
     * Same candidates and order as `queryRect`, written from the start of an integer array (`Int32Array` etc.); returns
     * the count. For integer items (`track` false or `'index'`); does not reallocate when result sizes vary. Throws
     * `RangeError` when `out` is too short (size it to the item count). Throws `TypeError` on `track: 'identity'`.
     */
    queryRectInto(
        minX: number,
        minY: number,
        maxX: number,
        maxY: number,
        out: Int32Array | Uint32Array | number[],
        group?: number,
    ): number;
    /** `queryRectInto(x - radius, y - radius, x + radius, y + radius, out, group)`. */
    queryCircleInto(
        x: number,
        y: number,
        radius: number,
        out: Int32Array | Uint32Array | number[],
        group?: number,
    ): number;
    /**
     * The items of a cell (an empty array when unused). Valid until the next change; do not modify. On a plain grid
     * ('clamp', no `track`, no `groups`) this is a shared array copied from the cell-ordered store, valid only until the
     * next `cellItems` call. To walk every cell in order, `itemsInCellOrder` is cheaper.
     */
    cellItems(key: number, group?: number): readonly Item[];
    /**
     * Fills `out` (cleared first) with the items of every in-world cell in cell-number order (bucket order inside a
     * cell): the same order as calling `cellItems` for each key from 0 to `cellTotal - 1`. Overflow items are left out.
     */
    itemsInCellOrder<Out extends Item[]>(out: Out): Out;
    /**
     * Writes the cell range a rectangle covers to `out` as [x0, y0, x1, y1], cut to the world ('clamp' clamps to the
     * edge cells). False when it covers no cell (outside the world, NaN on an 'overflow' grid).
     */
    cellRange(minX: number, minY: number, maxX: number, maxY: number, out: Int32Array | number[]): boolean;

    /** Number of cells in a ring: 1 for ring 0, `8 * ring` otherwise. */
    ringCellCount(ring: number): number;
    /** The `index`th cell of a ring (-1 outside the grid), in the order `queryCellRing` reads them. */
    ringCell(centerX: number, centerY: number, ring: number, index: number): number;
    /** Fills `out` with the items of every cell of one ring around a cell, in `ringCell` order. */
    queryCellRing<Out extends Item[]>(centerX: number, centerY: number, ring: number, out: Out): Out;
    /**
     * Smallest distance from (x, y) to any item in a cell outside the square of cells reaching `ring` around
     * (centerX, centerY). Edges of the grid have no outside. `Infinity` when nothing is outside.
     */
    distanceToOutsideRing(x: number, y: number, centerX: number, centerY: number, ring: number): number;
    /**
     * Visits the items of the cells inside the rectangle ring by ring around (x, y)'s cell and stops once the next
     * ring cannot beat the distance `visit` last returned. Correct when items sit exactly in their center cell.
     */
    visitNearestFirst(
        x: number,
        y: number,
        minX: number,
        minY: number,
        maxX: number,
        maxY: number,
        visit: (item: Item) => number,
    ): void;
}

export interface BoundsGridOptions {
    cellSize: number;
    width: number;
    height: number;
    originX?: number;
    originY?: number;
    /** Largest number of cells one item (or one query) may cover before it is handled as a large one. Defaults to 16. */
    maxCells?: number;
    /** Number of partial lists (0 to 30). An item joins list `v` when bit `1 << v` of its `viewMask` is set. */
    views?: number;
}

/**
 * A grid of rectangle items. Items go into every cell their bounds overlap and queries return the overlapping items in
 * insertion order without duplicates or sorting.
 */
export class BoundsGrid {
    constructor(options: BoundsGridOptions);
    readonly cellSize: number;
    readonly width: number;
    readonly height: number;
    readonly originX: number;
    readonly originY: number;
    readonly cols: number;
    readonly rows: number;
    readonly cellTotal: number;
    readonly maxCells: number;
    readonly views: number;
    /** Items inserted since the last `clear`. */
    readonly size: number;

    clear(): void;
    /**
     * Inserts an item with the bounds [minX, maxX] x [minY, maxY]. The insertion order is the result order of queries.
     * `id` is a non-negative integer, inserted at most once per `clear`.
     */
    insert(id: number, minX: number, minY: number, maxX: number, maxY: number, viewMask?: number): void;
    /**
     * Fills `out` (cleared first) with the ids whose bounds overlap or touch the given box, in insertion order, once
     * each. `view >= 0` looks only at that partial list; `afterId` keeps only larger ids (use the caller's own id to
     * visit each pair once).
     */
    queryBounds<Out extends number[]>(
        minX: number,
        minY: number,
        maxX: number,
        maxY: number,
        out: Out,
        view?: number,
        afterId?: number,
    ): Out;
    /** `queryBounds` with the stored bounds of an inserted id (the id itself is included unless `afterId` hides it). */
    queryOverlaps<Out extends number[]>(id: number, out: Out, view?: number, afterId?: number): Out;
}
