export interface VisionMapOptions {
    /** World width and height, in coordinate units. The cell counts are `ceil(width / cellSize)` and `ceil(height / cellSize)`. */
    width: number;
    height: number;
    /** Edge length of one cell. */
    cellSize: number;
    /** Level (height layer) of every cell, row by row (`row * cols + col`). Not copied; do not write to it afterwards. */
    level: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array;
    /** Blocked cells (non-zero = blocked), same layout as `level`. Omit for none. Not copied. */
    blocked?: Uint8Array;
}

export interface VisionSampleOptions {
    width: number;
    height: number;
    cellSize: number;
    /** Level at a world point. Called once per cell centre; must return an integer from -128 to 127. */
    levelAt: (x: number, y: number) => number;
    /** True where the world blocks sight. Called once per cell centre. Omit for none. */
    blockedAt?: (x: number, y: number) => boolean;
}

/** Immutable terrain raster shared by every team's `VisionField`. */
export class VisionMap {
    constructor(options: VisionMapOptions);
    /**
     * Builds the raster by sampling cell centres. A centre outside the world (a last cell that sticks out) is
     * sampled at the world edge instead.
     */
    static sample(options: VisionSampleOptions): VisionMap;
    readonly width: number;
    readonly height: number;
    readonly cellSize: number;
    readonly cols: number;
    readonly rows: number;
    readonly level: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array;
    readonly blocked: Uint8Array;
    /** Cell number (`row * cols + col`) of a point. Points outside the world read the edge cell; NaN gives NaN. */
    cellAt(x: number, y: number): number;
}

/** One team's vision grid: how many observers light each cell, by sight ceiling. */
export class VisionField {
    constructor(map: VisionMap);
    readonly map: VisionMap;
    /** Increases by one whenever an update lit or cleared any cell. Use it as a cache key for derived results. */
    readonly revision: number;
    /** Starts an observer-list update. Call `observe` for every observer of this update, then `end`. */
    begin(): this;
    /**
     * Adds one observer to the current update. An observer whose id was in the previous update with the same cell,
     * radius, level and xray is not repainted. Throws on a non-safe-integer id, an id already observed in this update
     * (RangeError), a non-finite position, an out-of-range radius (0 to 256 cells) or a missing level; observers added
     * before the throw stay applied, and the next `begin` starts over.
     * @param id Safe integer, unique within one update (combine kind and number, e.g. `number * 8 + kind`).
     * @param radius How far the observer lights cells (coordinate units). 0 lights nothing, not even its own cell.
     * @param level The observer's own level. Cells and targets higher than this are not seen. Ignored when `xray`.
     * @param xray Sees every cell within the radius at every target level, through blocked cells and higher ground.
     */
    observe(id: number, x: number, y: number, radius: number, level: number, xray?: boolean): this;
    /** Ends the update: clears observers not observed since `begin`, and bumps `revision` if anything changed. */
    end(): this;
    /**
     * Whether a target on level `targetLevel` at (x, y) is seen: some observer lighting that cell has a sight
     * ceiling (its own level; Infinity for xray) of at least `targetLevel`.
     */
    visibleAt(x: number, y: number, targetLevel: number): boolean;
    /** Highest sight ceiling over the observers lighting (x, y): -Infinity when none, Infinity when an xray observer does. */
    ceilingAt(x: number, y: number): number;
}
