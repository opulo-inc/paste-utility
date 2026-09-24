import {fromTriangles, applyToPoint, applyToPoints} from 'transformation-matrix';
import {importGerberSet, tagTightPitchPads, computeAlternatingSigns, planPadDispense, groupPadsByComponent, findFiducialCandidates, COMPONENT_TYPE_ORDER, placementDotRadiusMm, getPasteDispenseSettings, setPasteDispenseSettings, DEFAULT_JOB_STENCIL_THICKNESS_MM, DEFAULT_NOZZLE_GAUGE, padPasteVolumeMm3} from './gerberImport.js';

// 'multipad'/'inferred' only ever appear for a board with no %TO.C%
// component attributes at all - the pads are still real, but the grouping is
// a geometry-only guess (see clusterPadsGeometrically in gerberImport.js),
// so they're labeled distinctly rather than claimed as confirmed part types.
const COMPONENT_TYPE_LABELS = {
    resistor: 'Resistors',
    capacitor: 'Capacitors',
    ic: 'ICs',
    other: 'Other',
    multipad: 'Multi-pin Parts (inferred)',
    inferred: 'Everything Else (inferred)'
};

// Placement dots are drawn with their disk AREA (not radius) proportional to
// dispense degrees, since degrees is what actually tracks dispensed paste
// volume - matching by area is what reads as "more paste" to the eye.
// placementDotRadiusMm (gerberImport.js) is the same reference
// planPadDispense uses to keep staggered tight-pitch dots off the pad edge,
// so a plain (non-gerber) job whose points all use the job-wide Dispense
// Degrees setting draws consistently with one that came from a gerber
// import.
//
// The radius it returns is in world mm (not screen px) and gets multiplied
// by the canvas's current world-to-pixel scale at draw time - so a dot stays
// sized relative to the pads/board around it (and to real dispensed paste
// size) at any zoom level, instead of staying a fixed pixel size that reads
// as shrinking, relative to everything else, as you zoom in.
const PLACEMENT_DOT_MIN_RADIUS_PX = 1

// Extra forgiveness (canvas px, on top of a pad's own drawn radius) for
// returnClosestPlacementFromClickCoordinates() - an exact-pixel click on a
// 1px dot is unreasonable to expect, but this stays small since the point is
// for the clickable zone to actually track each dot's real size (see
// point.canvasRadius in drawJobToCanvas()) rather than overshoot it the way
// a single flat threshold used to.
const PLACEMENT_CLICK_MARGIN_PX = 3

// Machine build-plate presets (mm). The world coordinate frame the point-viz
// canvas draws is the machine's own bed frame - origin at the bed's
// front-left corner, X right, Y back - so these are also the actual extents
// of where the head can reach. Both plates share the exact same bottom-center
// no-go zone (the vacuum bed hardware lives there); "extended" just adds more
// usable room above it, per LumenPnP's alternate build plate.
const BUILD_PLATES = {
    standard: { label: 'Standard (390 x 240mm)', width: 390, height: 240 },
    extended: { label: 'Extended (390 x 330mm)', width: 390, height: 330 },
};
const DEFAULT_BUILD_PLATE = 'standard';

// Real machine X/Y the plate's own (0,0) - i.e. the bottom-left corner of
// the working area drawn in drawJobToCanvas() - actually sits at. Lets a
// board that's had a real fid-cal run (board.fidCalMatrix, see
// transformPlacements()) be drawn at its TRUE position/rotation on the bed
// instead of its nominal as-imported one: fidCalMatrix already maps design
// coordinates to real machine coordinates, so subtracting this origin is the
// last step to land in this canvas's plate-local frame. Purely a drawing
// concern - nothing that touches gcode generation reads this.
const PLATE_ORIGIN_MACHINE_MM = { x: 7, y: 95.5 };

// Bottom-center keep-out box (mm) present on every build plate - oriented
// with its long side running front-to-back (Y), not side-to-side.
const NO_GO_ZONE_MM = { width: 90, height: 120 };

// The relative jog performTipCalibration() makes right after the camera is
// centered on a fiducial, to land the nozzle roughly on that same spot
// before the user fine-tunes it by hand - i.e. the nominal, as-designed
// camera-to-nozzle mounting offset. The DIFFERENCE between this and the
// calibrated board.tipXoffset/tipYoffset the user's fine-tuning actually
// lands on is how far the real physical nozzle tip's position diverges from
// that nominal geometry - overwhelmingly a bent tip, since the nominal
// mounting offset itself is already baked in here. orderPointsByNozzleLean()
// below uses that difference (not the raw calibrated offset, which is
// dominated by this ~70mm nominal separation and would barely move for any
// real bend) as the direction a bent nozzle actually leans.
const NOZZLE_PREDICTED_OFFSET_MM = { x: -20, y: 67 };

// toast.receivedInput sentinel for "switch to picking pads instead of
// fiducial candidates" - see showToastWithButton()/pickPadsAsFiducials().
// Just needs to be a value that can never collide with a real Fiducial
// object or the `false` a closed toast resolves with.
const USE_PADS_FIDUCIAL_SENTINEL = 'use-pads-as-fiducials';

// Formats a millisecond duration as m:ss (e.g. 754321 -> "12:34") for the
// job run timer.
function formatElapsed(ms){
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Fits a plane through three {x,y,z} points and returns a zAt(x,y) function
// that reads the plane's height at any other X/Y - the height-only
// counterpart to the X/Y affine fit (fromTriangles/applyToPoint) used
// elsewhere for fid-cal. Used by Job.applyFiducialZTransform() to turn the
// three fiducials' individually-measured Z heights into a per-placement Z
// that accounts for a board sitting tilted on the bed, rather than one flat
// height for the whole board.
//
// Solved via the plane's normal vector (cross product of two edge vectors)
// rather than a 3x3 linear solve - same answer, fewer steps. Returns null
// if the three points are collinear in X/Y (any Z) - there's no unique tilt
// to fit, and the normal's Z component would be ~0, dividing by it below
// would blow up.
function fitZPlane(points){
    const [p1, p2, p3] = points;

    const v1 = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
    const v2 = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };

    const nx = v1.y * v2.z - v1.z * v2.y;
    const ny = v1.z * v2.x - v1.x * v2.z;
    const nz = v1.x * v2.y - v1.y * v2.x;

    if (Math.abs(nz) < 1e-9) return null;

    return (x, y) => p1.z - (nx * (x - p1.x) + ny * (y - p1.y)) / nz;
}

// Traces a stadium/rounded-rect path (used for the 'obround' pad overlay) -
// not relying on ctx.roundRect since it's not universally supported.
function drawRoundedRectPath(ctx, x, y, w, h, r){
    r = Math.min(r, w / 2, h / 2)
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
}

// Formats an estimated paste volume (mm3, numerically == microliters) for
// display - small single-pad figures read better in nanoliters, a whole
// board's total in microliters, so this just picks whichever keeps 2-3
// significant figures on screen instead of a string of leading zeros.
function formatVolumeMm3(volumeMm3){
    if (volumeMm3 == null) return null;
    const nanoliters = volumeMm3 * 1000;
    if (nanoliters < 1000) return `${nanoliters.toFixed(nanoliters < 10 ? 2 : 1)} nL`;
    return `${volumeMm3.toFixed(volumeMm3 < 10 ? 3 : 2)} µL`;
}

class Point {
    constructor(x, y, z, dispenseDegrees) {

        //these are the raw positions from the gerber import
        this.x = x;
        this.y = y;
        this.z = z;

        // per-point dispense override (e.g. from gerber pad-size scaling / multi-dot
        // patterns); null means "use the job's global Dispense Degrees setting"
        this.dispenseDegrees = dispenseDegrees ?? null;

        // Which component (refdes, e.g. "R12") and coarse type (see
        // classifyComponentType() in gerberImport.js) this point came from, if
        // the gerber's paste layer carried %TO.C% component attributes. null
        // for manually captured points or a gerber export without them - those
        // render as plain standalone rows instead of a fake group.
        this.refdes = null;
        this.componentType = null;

        // Which dot-placement pattern produced this point ('dot'/'line'/
        // 'grid'/'staggered' - see planPadDispense() in gerberImport.js).
        // null for manually captured points, which never went through pad
        // classification at all. Drives the Job Positions list's per-pad/
        // per-component pattern badges and which override fields a
        // component's overrides panel shows - see renderComponentGroup().
        this.dispensePattern = null;

        // This dot's own share of its pad's real gerber-measured area (mm2) -
        // see planPadDispense()'s padAreaMm2 in gerberImport.js. null for
        // manually captured points, which never went through pad
        // classification and so have no known pad geometry. Used only for
        // the estimated paste-volume figures (see Job.stencilThicknessMm/
        // pointPasteVolumeMm3()) - never for dispense degrees themselves.
        this.padAreaMm2 = null;

        // Whether this point is included when the job runs - group checkboxes
        // in the Job Positions list flip this for every pad in a component (or
        // every component in a type), so parts can be selectively skipped.
        this.enabled = true;

        // these are any calibrated positions as a result from fid cal
        this.calX = null;
        this.calY = null;

        // this is where on the canvas the dot was drawn for this point
        this.canvasX = null;
        this.canvasY = null;

        // this is the dom object for the little card in the point list
        this.docElement = null;
    }

    toArray() {
        return [this.x, this.y, this.z];
    }

    static fromArray(arr) {
        return new Point(arr[0], arr[1], arr[2]);
    }

}

class Fiducial extends Point {
    constructor(x, y, z, searchX, searchY) {
        super(x, y, z)
        this.searchX = searchX;
        this.searchY = searchY;
    }

}

export class Job {
    constructor(lumen, toast) {

        // Multi-board support: everything that belongs to ONE loaded board
        // (placements, fiducials, pad footprints, outline, per-component
        // overrides, Job Positions expand/collapse state, fid-cal matrix)
        // lives in one entry of this.boards, one tab per board in the Job
        // Positions panel (see renderBoardTabs()). Everything else on Job
        // (dispenseDegrees, motionSpeed, buildPlateId, ...) is job-wide and
        // shared across every board.
        //
        // The getters/setters right below make this.placements,
        // this.fiducials, etc. transparent aliases for
        // this.boards[this.activeBoardIndex]'s own fields, so every existing
        // method that already reads/writes those names (buildPlacementsFromPadShapes,
        // recomputeDispensePattern, transformPlacements, slice() for a single
        // board, drawJobToCanvas's active-board pass, ...) keeps working
        // completely unchanged - it's always really operating on "whichever
        // board's tab is currently open," with no separate sync step needed.
        this.boards = [this.createEmptyBoard('Board 1')];
        this.activeBoardIndex = 0;

        // Raw pad footprints (shape/xSize/ySize, mm, world space) from the
        // last gerber import - kept only for the optional "show pads"
        // overlay (see drawJobToCanvas), not persisted with the job, since
        // it's just a visual aid over the dispense points that already carry
        // everything a run actually needs. This toggle is the PASTE layer;
        // showMaskPadOverlay below is the separate mask-layer toggle.
        this.showPadOverlay = false;
        this.showMaskPadOverlay = false;

        // Which physical paste extruder hardware pointDispenseCommands()
        // should generate G-code for - 'v2' (current auger dispenser) or
        // 'v1-beta' (original syringe-plunger dispenser). This is a device
        // setting, not a per-job one (the same machine doesn't change
        // hardware between jobs), so it isn't part of export()/importFromFile()
        // - it's set directly by main.js's hardware-version gate/header
        // dropdown (see applyHardwareVersion()), which persists the choice in
        // localStorage instead. Defaults to 'v2' so gcode generation is never
        // left in an undefined state if this somehow runs before that gate
        // has set a real value.
        this.hardwareVersion = 'v2';

        this.dispenseDegrees = 55.1;
        // Simple overall scale factor on top of the stencil-thickness/
        // nozzle-gauge suggested dispense degrees (see
        // computeDispenseDegrees() in main.js) - 1.0 means "use the
        // suggestion as-is". The one number the Basic tab's Dispense
        // Multiplier field is for tuning, once real dispense results show
        // whether that suggestion runs heavy or light for this stencil/
        // paste/tip combo.
        this.dispenseMultiplier = 1;
        // Solder stencil thickness this job's boards are (or would be)
        // printed with - both an estimated-paste-volume input (see
        // pointPasteVolumeMm3()/totalPasteVolumeMm3() below) and, along with
        // nozzleGauge, an input to the suggested dispenseDegrees above.
        this.stencilThicknessMm = DEFAULT_JOB_STENCIL_THICKNESS_MM;
        // Which preset nozzle tip is mounted - along with stencilThicknessMm,
        // feeds the suggested dispenseDegrees above (see
        // DEFAULT_NOZZLE_GAUGE_RATIOS in gerberImport.js). Never affects
        // placement math or the paste-volume estimate directly.
        this.nozzleGauge = DEFAULT_NOZZLE_GAUGE;
        // Only used by plungerDispenseCommands() (hardwareVersion 'v1-beta')
        // - how far (degrees) the plunger backs off after each dispense to
        // reduce stringing/ooze, and how long (ms) to then dwell in place so
        // the paste actually finishes flowing before moving on. Defaults
        // match the original Paste Extruder V1 Beta code these come from.
        this.retractionDegrees = 1;
        this.dwellMilliseconds = 100;
        this.motionSpeed = 35000;
        this.extruderSpeed = 100000;
        this.vacuumPressure = 100; // air assist, as a percentage (0-100)
        this.motorCurrent = 450; // auger current while dispensing (M906 B value, mA)
        // Z height the nozzle rests/travels at between pads (and during a
        // fid-cal jog) - distinct from a placement's own .z, which is the
        // calibrated board-contact height. Lower = less distance to travel
        // down at each pad, so a run covers the board faster; how low is
        // safe depends on the tallest component already on the board.
        this.travelHeight = 31.5;
        this.preGcode = "";
        this.postGcode = "";
        this.invertDispense = false;
        this.isRunning = false;
        // True while a run is paused (see pauseRun()/resumeRun()) - only
        // meaningful while isRunning is also true.
        this.isPaused = false;
        // The current run's ordered {board, point} queue and how far
        // through it the run has gotten (see buildRunQueue()/run()) - used
        // for the toast's live progress display.
        this.runQueue = null;
        this.runProgressIndex = 0;
        // Set when a run stops before finishing every point - a cancel, a
        // pause-then-cancel, or a lost connection (see run()) - to whichever
        // Point was going to be dispensed next, so the Resume Job button
        // (and updateRunResumeControls()) can offer to continue from there
        // instead of repasting the whole job. Cleared (null) once a run
        // completes every point, or a new run starts.
        this.lastRunStoppedAtPoint = null;
        this.lastRunStoppedIndex = null;
        this.lastRunQueueLength = null;
        this.lumen = lumen;
        this.toast = toast;

        // Job run timer - runStartTime/runTimerInterval track the in-progress
        // run, lastRunDurationMs is the most recently finished run's total
        // time, kept around so the display doesn't clear itself between runs.
        this.runStartTime = null;
        this.runTimerInterval = null;
        this.lastRunDurationMs = null;

        this.jobCanvas = document.getElementById('pointViz');

        // Which BUILD_PLATES preset the point-viz canvas is currently drawn
        // against - see setBuildPlate()/drawJobToCanvas().
        this.buildPlateId = DEFAULT_BUILD_PLATE;
        // Newest LumenPnP revision (off-center camera): the no-go zone sits at
        // the bed's bottom-LEFT instead of bottom-center - see getNoGoZoneRect().
        this.offCenterCam = false;
        // "Custom" build plate (see getActiveBuildPlate()) - arbitrary max
        // travel, in mm, for a machine/setup that isn't one of the preset
        // plates. Read off the machine's own DRO by jogging to its X/Y
        // travel limits. Defaults match the standard plate's size, purely as
        // a starting point.
        this.customBuildPlateWidthMm = 390;
        this.customBuildPlateHeightMm = 240;
        // Real machine X/Y this custom plate's own (0,0) - its bottom-left
        // corner, same convention as PLATE_ORIGIN_MACHINE_MM - actually sits
        // at, since there's no preset to assume it for. Without this, a
        // calibrated board would draw at the wrong spot relative to the
        // custom plate outline: getPlateOriginMachineMm() is what
        // drawJobToCanvas()'s boardPoint() subtracts to land a fid-cal'd
        // board in plate-local coords. Defaults to the same origin the
        // standard/extended plates use, purely as a starting point.
        this.customBuildPlateOriginXMm = PLATE_ORIGIN_MACHINE_MM.x;
        this.customBuildPlateOriginYMm = PLATE_ORIGIN_MACHINE_MM.y;
        // Z height the nozzle moves to right after Home Z finishes homing
        // (see main.js's "home-z" click handler) - a raw Z endstop position
        // alone is often close to the top of travel, not a useful working
        // height to actually leave the head sitting at.
        this.homedZHeightMm = 31.5;

        // Software soft limits on how far an X/Y jog can push the gantry
        // (see clampJogDelta() in main.js) - distinct from the build plate's
        // smaller paste-able/no-go-zone-aware extents above, which are about
        // where boards can be drawn/pasted, not the gantry's own physical
        // travel. Jogging past these would just grind the axis into its own
        // hard stop; defaults are the standard machine's own real limits.
        this.maxTravelXMm = 400;
        this.maxTravelYMm = 330;

        // User-applied zoom/pan on top of the auto-fit-to-bed view computed
        // each draw in drawJobToCanvas(). scale is a multiplier on the fit
        // scale; pan is in canvas pixels (see zoomViewAt()'s comment for the
        // pre-flip Y convention it shares with drawJobToCanvas).
        this.view = { scale: 1, panX: 0, panY: 0 };

        // World-mm scale of the most recent drawJobToCanvas() call, cached so
        // setupCanvasInteractions()'s board-drag handler can convert a
        // screen-pixel drag delta into world mm without redoing the fit math.
        this.lastDrawScale = 1;

        // Uncommitted board drag, in world mm - see setupCanvasInteractions()
        // and translateBoard(). Kept separate from the board's real
        // coordinates while a drag is in progress (rather than mutating
        // placements/fiducials/padShapes on every pointermove) so a drag that
        // never moves anything meaningful doesn't churn every point's
        // floating-point x/y on every frame; translateBoard() commits it for
        // real once the drag ends.
        this.dragPreview = { x: 0, y: 0 };

        this.clickedFidBuffer = [];

        // True only while loadGerberFiles()'s manual "click each fiducial"
        // flow has its own click listener on the canvas - lets the
        // pad-click-to-toggle handler in setupCanvasInteractions() step
        // aside so a click during that flow doesn't also toggle a pad.
        this._pickingFiducials = false;

        // True while a multi-step, user-interactive flow that writes to ONE
        // specific board is in progress: loadGerberFiles()'s manual fid-pick
        // sub-step, findBoardRoughPosition(), or performFiducialCalibration().
        // Each of those spans several `await this.toast.show(...)` pauses
        // waiting on the user, and switchToBoard()/addBoard()/removeBoard()
        // check this to refuse switching boards mid-flow - without it,
        // switching tabs (or importing a new board) while one of those is
        // still waiting on a toast would silently write that flow's results
        // onto whatever board is active by the time each step resolves,
        // instead of the board it actually started on. The three flows also
        // capture `const board = this.activeBoard` up front and thread it
        // through explicitly (rather than the this.fiducials/this.placements
        // active-board aliases) as defense in depth on top of this guard.
        this._boardFlowActive = false;

        this.setupCanvasInteractions();

        // Render the board tab strip (see renderBoardTabs()) immediately so
        // "Board 1" and the "+" to paste another show up before anything's
        // ever been imported, instead of only appearing after the first
        // gerber import populates the Job Positions list.
        this.loadJobIntoPositionList();
    }

    // Fresh empty board data (see this.boards above) - factored out so both
    // the constructor and addBoard() build one the same way.
    createEmptyBoard(name){
        return {
            id: `board-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name,
            placements: [],
            fiducials: [],
            // Raw pad footprints (shape/xSize/ySize, mm, world space) from
            // this board's last gerber import - kept only for the optional
            // "show pads" overlay (see drawJobToCanvas), not persisted with
            // the job, since it's just a visual aid over the dispense points
            // that already carry everything a run actually needs. This is
            // the PASTE layer - the layer dispenseDegrees/volume are actually
            // computed from (see buildPlacementsFromPadShapes()).
            padShapes: [],
            // Same, but the mask (copper-exposed opening) layer instead -
            // shown by its own separate overlay toggle (showMaskPadOverlay)
            // purely so paste vs. mask pad size can be visually compared.
            // Never used for dispense math - only padShapes (paste) is.
            maskPadShapes: [],
            // Board outline segments (mm, world space) from a gerber
            // Edge_Cuts/Profile layer, drawn for reference on the point-viz
            // canvas. See extractOutline() in gerberImport.js.
            boardOutline: [],
            // Job Positions list expand/collapse state for this board, keyed
            // by component type and by refdes respectively - kept here (not
            // derived fresh each render) so re-rendering the list after any
            // change doesn't collapse whatever the user had open. Type
            // groups start expanded; individual component groups start
            // collapsed so importing a board with hundreds of parts doesn't
            // dump every single pad open at once.
            expandedTypes: new Set(COMPONENT_TYPE_ORDER),
            expandedComponents: new Set(),
            // Which of this board's components' overrides panel (see
            // renderComponentOverridesPanel) is currently open - same
            // expand/collapse-state pattern as expandedComponents above,
            // kept independent of it so opening overrides doesn't also
            // expand/collapse the pad list.
            expandedOverrides: new Set(),
            // Per-component overrides for the Line/Grid/Staggered
            // "mechanics" settings (dot pitch, edge inset, volume
            // multipliers, stagger spacing - NOT the classification
            // thresholds on those same tabs, which stay board-wide - see
            // resolveMechanicsSettings() in gerberImport.js for why). Keyed
            // by refdes; a component with no entry here just uses the
            // board-wide Advanced Settings values. Only ever holds keys the
            // user explicitly overrode - see renderComponentOverridesPanel().
            componentOverrides: new Map(),
            // Set by transformPlacements() (fid-cal) and re-applied by
            // recomputeDispensePattern() so an Advanced Settings change
            // doesn't throw away a calibration that's already been done for
            // this board.
            fidCalMatrix: null,
            // Nozzle-to-camera X/Y offset (set by performTipCalibration(),
            // see the this.tipXoffset/tipYoffset getters) and a manual Z
            // nudge (the Z Offset +/- buttons) - per-board rather than one
            // job-wide value, since different boards on the same bed can
            // need different offsets (a tip swap between boards, a board
            // that sits at a different height, ...).
            tipXoffset: 0,
            tipYoffset: 0,
            zOffset: 0,
        };
    }

    // Rebuilds one board (see createEmptyBoard()) from its exported plain-data
    // shape - shared by importFromFile()'s multi-board "boards" array and its
    // legacy single-board fallback (an older job file's top-level
    // placements/fiducials/etc, wrapped into one board so it still opens).
    deserializeBoard(data, index = 0){
        const board = this.createEmptyBoard(data.name || `Board ${index + 1}`);
        if (data.id) board.id = data.id;

        board.placements = (data.placements || []).map(p => {
            const point = new Point(p.x, p.y, p.z, p.dispenseDegrees);
            point.calX = p.calX;
            point.calY = p.calY;
            point.canvasX = p.canvasX;
            point.canvasY = p.canvasY;
            point.refdes = p.refdes ?? null;
            point.componentType = p.componentType ?? null;
            point.dispensePattern = p.dispensePattern ?? null;
            point.padAreaMm2 = p.padAreaMm2 ?? null;
            point.enabled = p.enabled !== false;
            return point;
        });
        board.boardOutline = data.boardOutline || [];
        board.padShapes = data.padShapes || [];
        board.maskPadShapes = data.maskPadShapes || [];
        board.fiducials = (data.fiducials || []).map(f => {
            const fid = new Fiducial(f.x, f.y, f.z, f.searchX, f.searchY);
            fid.calX = f.calX;
            fid.calY = f.calY;
            fid.canvasX = f.canvasX;
            fid.canvasY = f.canvasY;
            return fid;
        });
        board.componentOverrides = new Map(Object.entries(data.componentOverrides || {}));
        // Per-board now (see createEmptyBoard()) - absent (undefined) on a
        // board saved before this existed, left at createEmptyBoard()'s 0
        // default here; importFromFile() then seeds it from the OLD job-wide
        // top-level tipXoffset/tipYoffset/zOffset if the file has one, for
        // backward compatibility with files saved before per-board offsets.
        if (typeof data.tipXoffset !== 'undefined') board.tipXoffset = data.tipXoffset;
        if (typeof data.tipYoffset !== 'undefined') board.tipYoffset = data.tipYoffset;
        if (typeof data.zOffset !== 'undefined') board.zOffset = data.zOffset;

        // A saved board's placements already carry calX/calY from whatever
        // fid-cal run produced them, but that calibration's matrix itself
        // isn't in the file - only its already-applied result is. Without
        // rebuilding fidCalMatrix here, it stays null, and the *next*
        // recomputeDispensePattern() (e.g. from touching an Advanced
        // Settings slider) rebuilds placements from padShapes with no
        // matrix to reapply - silently dropping calX/calY on every point
        // and sending the machine to raw, uncalibrated gerber coordinates
        // instead of the calibrated ones. Rebuild it from the three
        // fiducials' raw (x,y) and calibrated (calX,calY) positions, the
        // same inputs transformPlacements() itself used.
        board.fidCalMatrix = null;
        if (board.fiducials.length === 3 && board.fiducials.every(f => f.calX != null && f.calY != null)) {
            const origFids = board.fiducials.map(f => [f.x, f.y]);
            const realFids = board.fiducials.map(f => [parseFloat(f.calX), parseFloat(f.calY)]);
            board.fidCalMatrix = fromTriangles(origFids, realFids);
        }

        return board;
    }

    get activeBoard(){ return this.boards[this.activeBoardIndex]; }

    get placements(){ return this.activeBoard.placements; }
    set placements(v){ this.activeBoard.placements = v; }

    get fiducials(){ return this.activeBoard.fiducials; }
    set fiducials(v){ this.activeBoard.fiducials = v; }

    get padShapes(){ return this.activeBoard.padShapes; }
    set padShapes(v){ this.activeBoard.padShapes = v; }
    get maskPadShapes(){ return this.activeBoard.maskPadShapes; }
    set maskPadShapes(v){ this.activeBoard.maskPadShapes = v; }

    get boardOutline(){ return this.activeBoard.boardOutline; }
    set boardOutline(v){ this.activeBoard.boardOutline = v; }

    get expandedTypes(){ return this.activeBoard.expandedTypes; }
    set expandedTypes(v){ this.activeBoard.expandedTypes = v; }

    get expandedComponents(){ return this.activeBoard.expandedComponents; }
    set expandedComponents(v){ this.activeBoard.expandedComponents = v; }

    get expandedOverrides(){ return this.activeBoard.expandedOverrides; }
    set expandedOverrides(v){ this.activeBoard.expandedOverrides = v; }

    get componentOverrides(){ return this.activeBoard.componentOverrides; }
    set componentOverrides(v){ this.activeBoard.componentOverrides = v; }

    get fidCalMatrix(){ return this.activeBoard.fidCalMatrix; }
    set fidCalMatrix(v){ this.activeBoard.fidCalMatrix = v; }

    get tipXoffset(){ return this.activeBoard.tipXoffset; }
    set tipXoffset(v){ this.activeBoard.tipXoffset = v; }

    get tipYoffset(){ return this.activeBoard.tipYoffset; }
    set tipYoffset(v){ this.activeBoard.tipYoffset = v; }

    get zOffset(){ return this.activeBoard.zOffset; }
    set zOffset(v){ this.activeBoard.zOffset = v; }

    // Refreshes the X/Y/Z Offset readout (see index.html's offset-tool
    // controls, in the Job Positions panel) to the ACTIVE board's own
    // values - needed anywhere the active board can change (switchToBoard(),
    // addBoard(), removeBoard()) or a board's offset can (importFromFile(),
    // performTipCalibration()), since these are per-board now rather than
    // one job-wide value that never needed re-displaying on a tab switch.
    updateOffsetDisplay(){
        const xEl = document.getElementById('x-offset-value');
        const yEl = document.getElementById('y-offset-value');
        const zEl = document.getElementById('z-offset-value');
        if (xEl) xEl.textContent = `${this.tipXoffset.toFixed(1)}mm`;
        if (yEl) yEl.textContent = `${this.tipYoffset.toFixed(1)}mm`;
        if (zEl) zEl.textContent = `${this.zOffset.toFixed(1)}mm`;
    }

    // True while a board's rough-position/fid-cal flow is in progress (see
    // this._boardFlowActive) - switchToBoard()/addBoard()/removeBoard()/
    // loadGerberFiles() all check this before touching which board is
    // active, since doing so mid-flow would silently write that flow's
    // results onto the wrong board.
    warnIfBoardFlowActive(){
        if (!this._boardFlowActive) return false;
        alert('Finish (or cancel, via the toast\'s close button) the rough-position/fiducial-calibration step in progress before switching boards.');
        return true;
    }

    // Switches which board's tab is active - every other method just reads/
    // writes this.placements/this.fiducials/etc (see the getters above), so
    // this is the only place that actually needs to know boards exist.
    switchToBoard(index){
        if (this.warnIfBoardFlowActive()) return;
        if (index === this.activeBoardIndex || !this.boards[index]) return;
        this.activeBoardIndex = index;
        this.dragPreview = { x: 0, y: 0 };
        this.loadJobIntoPositionList();
        this.drawJobToCanvas();
        this.updateOffsetDisplay();
    }

    // Adds a new empty board tab and switches to it - "Import Gerber"
    // afterward populates THIS board, leaving every other tab's board alone.
    addBoard(){
        if (this.warnIfBoardFlowActive()) return;
        this.boards.push(this.createEmptyBoard(`Board ${this.boards.length + 1}`));
        this.activeBoardIndex = this.boards.length - 1;
        this.dragPreview = { x: 0, y: 0 };
        this.loadJobIntoPositionList();
        this.drawJobToCanvas();
        this.updateOffsetDisplay();
    }

    // Removes one board tab entirely. Always leaves at least one board -
    // closing the last one would leave no active board for every getter
    // above to point at.
    removeBoard(index){
        if (this.warnIfBoardFlowActive()) return;
        if (this.boards.length <= 1 || !this.boards[index]) return;

        this.boards.splice(index, 1);
        if (this.activeBoardIndex >= this.boards.length) this.activeBoardIndex = this.boards.length - 1;
        else if (this.activeBoardIndex > index) this.activeBoardIndex -= 1;

        this.loadJobIntoPositionList();
        this.drawJobToCanvas();
        this.updateOffsetDisplay();
    }

    // Wires up the point-viz canvas so the board view stays sized to its
    // container (instead of a hardcoded bitmap) and supports wheel-zoom,
    // drag-to-move-the-board (shift-drag to pan the camera instead), and
    // double-click-to-reset.
    setupCanvasInteractions(){
        const canvas = this.jobCanvas;
        const container = canvas.closest('.gerber-visualization-container') ?? canvas.parentElement;
        const minZoom = 0.5;
        // High enough to fill the whole canvas with a single 0402 pad
        // (~0.6mm) at any panel size: effective on-screen scale is
        // fitScale * view.scale, and fitScale itself is ~canvasSize/429 (the
        // standard plate's width plus its 5%-of-max margin on each side, see
        // drawJobToCanvas()) - so the view.scale needed to fill ~90% of the
        // canvas with a 0.6mm pad works out to roughly 0.9*429/0.6 ≈ 640,
        // independent of the actual canvas pixel size. 1000 leaves headroom
        // to go a bit tighter than that (e.g. to inspect one dispense dot
        // within the pad) without maxing out the slider.
        const maxZoom = 1000;

        // Keep the canvas's backing pixel resolution matched to its on-screen
        // size so the drawing stays sharp (rather than a fixed 500x500 bitmap
        // stretched by CSS) and so it redraws whenever the surrounding layout
        // resizes.
        const resizeObserver = new ResizeObserver(() => {
            const width = Math.max(1, Math.round(container.clientWidth));
            const height = Math.max(1, Math.round(container.clientHeight));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                this.drawJobToCanvas();
            }
        });
        resizeObserver.observe(container);

        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const zoomFactor = Math.exp(-event.deltaY * 0.001);
            const newScale = Math.min(maxZoom, Math.max(minZoom, this.view.scale * zoomFactor));
            this.zoomViewAt(event.clientX - rect.left, event.clientY - rect.top, newScale);
        }, { passive: false });

        let dragging = false;
        let dragMoved = false;
        // Plain drag moves the loaded board around the bed (the common case -
        // "where will this board actually sit"); shift-drag falls back to the
        // old camera-pan behavior for inspecting a zoomed-in view.
        let dragMode = 'board';
        let lastX = 0, lastY = 0;

        canvas.addEventListener('pointerdown', (event) => {
            dragging = true;
            dragMoved = false;
            dragMode = event.shiftKey ? 'camera' : 'board';
            lastX = event.clientX;
            lastY = event.clientY;
            canvas.setPointerCapture(event.pointerId);
        });

        canvas.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            const dx = event.clientX - lastX;
            const dy = event.clientY - lastY;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
            if (!dragMoved) return;

            lastX = event.clientX;
            lastY = event.clientY;

            if (dragMode === 'camera') {
                this.view.panX += dx;
                this.view.panY -= dy; // screen Y is flipped relative to the canvasY convention drawJobToCanvas uses
            } else {
                // Screen-pixel delta -> world mm, using the scale from the most
                // recent draw (cached as this.lastDrawScale). Only kept as a
                // preview (this.dragPreview) until the drag ends - see
                // translateBoard().
                const scale = this.lastDrawScale || 1;
                this.dragPreview.x += dx / scale;
                this.dragPreview.y -= dy / scale; // screen Y flipped, same as camera pan above
            }
            this.drawJobToCanvas();
        });

        const endDrag = () => {
            dragging = false;
            if (!dragMoved) return;

            if (dragMode === 'board' && (this.dragPreview.x !== 0 || this.dragPreview.y !== 0)) {
                this.translateBoard(this.dragPreview.x, this.dragPreview.y);
                this.dragPreview = { x: 0, y: 0 };
                this.drawJobToCanvas();
            }

            // A drag ends with a click event on the same target - swallow just
            // that one so it doesn't get mistaken for a fiducial pick by the
            // click listener fid-cal adds/removes on this canvas.
            canvas.addEventListener('click', (clickEvent) => {
                clickEvent.stopImmediatePropagation();
                clickEvent.preventDefault();
            }, { capture: true, once: true });
        };
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);

        canvas.addEventListener('dblclick', () => this.resetView());

        // Click a pad dot to toggle whether it's included in the job - the
        // board view's counterpart to the per-pad checkbox in the Job
        // Positions list (see createPositionElement()). The drag-swallow
        // listener above eats the click that ends an actual board drag, so
        // this only ever fires for a real click. Skipped while the manual
        // "click each fiducial" flow (loadGerberFiles()) has its own click
        // listener on this same canvas - see this._pickingFiducials.
        canvas.addEventListener('click', (event) => {
            if (this._pickingFiducials) return;

            const rect = canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = canvas.height - (event.clientY - rect.top); // matches canvasX/canvasY's convention

            const point = this.returnClosestPlacementFromClickCoordinates(x, y);
            if (!point) return;

            point.enabled = point.enabled === false ? true : false;
            this.loadJobIntoPositionList();
            this.drawJobToCanvas();
        });

        const buildPlateSelect = document.getElementById('buildPlateSelect');
        const customBuildPlateInputs = document.getElementById('customBuildPlateInputs');
        const customBuildPlateWidthMm = document.getElementById('customBuildPlateWidthMm');
        const customBuildPlateHeightMm = document.getElementById('customBuildPlateHeightMm');
        if (buildPlateSelect) {
            buildPlateSelect.value = this.buildPlateId;
            if (customBuildPlateInputs) customBuildPlateInputs.hidden = this.buildPlateId !== 'custom';
            buildPlateSelect.addEventListener('change', (event) => {
                this.setBuildPlate(event.target.value);
                if (customBuildPlateInputs) customBuildPlateInputs.hidden = this.buildPlateId !== 'custom';
            });
        }
        if (customBuildPlateWidthMm) customBuildPlateWidthMm.value = this.customBuildPlateWidthMm;
        if (customBuildPlateHeightMm) customBuildPlateHeightMm.value = this.customBuildPlateHeightMm;
        const applyCustomBuildPlateSize = () => {
            this.setCustomBuildPlateSize(
                Number(customBuildPlateWidthMm?.value),
                Number(customBuildPlateHeightMm?.value)
            );
        };
        customBuildPlateWidthMm?.addEventListener('change', applyCustomBuildPlateSize);
        customBuildPlateHeightMm?.addEventListener('change', applyCustomBuildPlateSize);

        const customBuildPlateOriginXMm = document.getElementById('customBuildPlateOriginXMm');
        const customBuildPlateOriginYMm = document.getElementById('customBuildPlateOriginYMm');
        if (customBuildPlateOriginXMm) customBuildPlateOriginXMm.value = this.customBuildPlateOriginXMm;
        if (customBuildPlateOriginYMm) customBuildPlateOriginYMm.value = this.customBuildPlateOriginYMm;
        const applyCustomBuildPlateOrigin = () => {
            this.setCustomBuildPlateOrigin(
                Number(customBuildPlateOriginXMm?.value),
                Number(customBuildPlateOriginYMm?.value)
            );
        };
        customBuildPlateOriginXMm?.addEventListener('change', applyCustomBuildPlateOrigin);
        customBuildPlateOriginYMm?.addEventListener('change', applyCustomBuildPlateOrigin);

        const offCenterCamToggle = document.getElementById('offCenterCamToggle');
        if (offCenterCamToggle) {
            offCenterCamToggle.checked = this.offCenterCam;
            offCenterCamToggle.addEventListener('change', (event) => {
                this.offCenterCam = event.target.checked;
                this.drawJobToCanvas();
            });
        }

        const jobHomedZHeight = document.getElementById('jobHomedZHeight');
        if (jobHomedZHeight) {
            jobHomedZHeight.value = this.homedZHeightMm;
            jobHomedZHeight.addEventListener('change', (event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) this.homedZHeightMm = value;
            });
        }

        const jobMaxTravelX = document.getElementById('jobMaxTravelX');
        if (jobMaxTravelX) {
            jobMaxTravelX.value = this.maxTravelXMm;
            jobMaxTravelX.addEventListener('change', (event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value > 0) this.maxTravelXMm = value;
            });
        }

        const jobMaxTravelY = document.getElementById('jobMaxTravelY');
        if (jobMaxTravelY) {
            jobMaxTravelY.value = this.maxTravelYMm;
            jobMaxTravelY.addEventListener('change', (event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value > 0) this.maxTravelYMm = value;
            });
        }

        // 2x per click (not the wheel-zoom's much finer per-notch step) so
        // reaching the very top of the now-much-taller maxZoom range - all
        // the way down to a single pad filling the screen - doesn't take
        // dozens of clicks.
        document.getElementById('vizZoomIn')?.addEventListener('click', () => {
            const rect = canvas.getBoundingClientRect();
            this.zoomViewAt(rect.width / 2, rect.height / 2, Math.min(maxZoom, this.view.scale * 2));
        });
        document.getElementById('vizZoomOut')?.addEventListener('click', () => {
            const rect = canvas.getBoundingClientRect();
            this.zoomViewAt(rect.width / 2, rect.height / 2, Math.max(minZoom, this.view.scale / 2));
        });
        document.getElementById('vizZoomReset')?.addEventListener('click', () => this.resetView());

        const togglePadsButton = document.getElementById('vizTogglePads');
        togglePadsButton?.addEventListener('click', () => {
            this.showPadOverlay = !this.showPadOverlay;
            togglePadsButton.classList.toggle('active', this.showPadOverlay);
            this.drawJobToCanvas();
        });

        const toggleMaskPadsButton = document.getElementById('vizToggleMaskPads');
        toggleMaskPadsButton?.addEventListener('click', () => {
            this.showMaskPadOverlay = !this.showMaskPadOverlay;
            toggleMaskPadsButton.classList.toggle('active', this.showMaskPadOverlay);
            this.drawJobToCanvas();
        });
    }

    // Rescales the view so the world point currently under (cursorX, cursorY)
    // (in canvas-pixel, not-yet-Y-flipped-back coordinates) stays under the
    // cursor, so wheel-zoom feels anchored instead of recentering on every tick.
    zoomViewAt(cursorX, cursorY, newScale){
        const ratio = newScale / this.view.scale;
        const canvasHeight = this.jobCanvas.height;
        const cursorCanvasY = canvasHeight - cursorY;

        this.view.panX = cursorX - (cursorX - this.view.panX) * ratio;
        this.view.panY = cursorCanvasY - (cursorCanvasY - this.view.panY) * ratio;
        this.view.scale = newScale;

        this.drawJobToCanvas();
    }

    resetView(){
        this.view.scale = 1;
        this.view.panX = 0;
        this.view.panY = 0;
        this.drawJobToCanvas();
    }

    // Switches which BUILD_PLATES preset the canvas fits itself to. The
    // no-go zone stays anchored to the bed's bottom-center either way -
    // switching plates never moves the board itself, only how much bed is
    // drawn around it.
    setBuildPlate(id){
        if (id !== 'custom' && !BUILD_PLATES[id]) return;
        if (id === this.buildPlateId) return;
        this.buildPlateId = id;
        this.drawJobToCanvas();
    }

    // Sets the custom plate's own max-travel dimensions (see
    // getActiveBuildPlate()) and redraws - a no-op unless 'custom' is
    // actually the selected plate, same as every other Advanced/Basic
    // Settings field that only affects the currently-relevant mode.
    setCustomBuildPlateSize(widthMm, heightMm){
        if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) return;
        this.customBuildPlateWidthMm = widthMm;
        this.customBuildPlateHeightMm = heightMm;
        if (this.buildPlateId === 'custom') this.drawJobToCanvas();
    }

    // Sets the custom plate's own real machine-space origin (see
    // getPlateOriginMachineMm()) and redraws - same no-op-unless-custom
    // behavior as setCustomBuildPlateSize() above.
    setCustomBuildPlateOrigin(xMm, yMm){
        if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) return;
        this.customBuildPlateOriginXMm = xMm;
        this.customBuildPlateOriginYMm = yMm;
        if (this.buildPlateId === 'custom') this.drawJobToCanvas();
    }

    // The {label, width, height} for whichever plate is currently selected -
    // one of the fixed BUILD_PLATES presets, or the user's own custom
    // max-travel size (see setCustomBuildPlateSize()) for a machine/setup
    // that isn't a preset (e.g. read off its own DRO).
    getActiveBuildPlate(){
        if (this.buildPlateId === 'custom') {
            return { label: 'Custom', width: this.customBuildPlateWidthMm, height: this.customBuildPlateHeightMm };
        }
        return BUILD_PLATES[this.buildPlateId] || BUILD_PLATES[DEFAULT_BUILD_PLATE];
    }

    // Real machine X/Y the active plate's own (0,0) - its bottom-left
    // corner, as drawn in drawJobToCanvas() - actually sits at. The fixed
    // PLATE_ORIGIN_MACHINE_MM for the standard/extended presets, or the
    // user's own typed-in origin (see setCustomBuildPlateOrigin()) for
    // 'custom', since there's no preset location to assume there.
    getPlateOriginMachineMm(){
        if (this.buildPlateId === 'custom') {
            return { x: this.customBuildPlateOriginXMm, y: this.customBuildPlateOriginYMm };
        }
        return PLATE_ORIGIN_MACHINE_MM;
    }

    // The keep-out box, in world mm, for whichever plate is currently
    // selected - same size on every plate. Bottom-center normally, or
    // bottom-left on the newest (off-center camera) LumenPnP revision.
    // Custom has no known vacuum-bed hardware footprint to avoid - treated
    // as if there's no no-go zone at all (zero-size), same as
    // centerBoardOnPlate()/drawJobToCanvas() behaved before either existed.
    getNoGoZoneRect(){
        if (this.buildPlateId === 'custom') return { x: 0, y: 0, width: 0, height: 0 };
        const plate = this.getActiveBuildPlate();
        return {
            x: this.offCenterCam ? 0 : (plate.width - NO_GO_ZONE_MM.width) / 2,
            y: 0,
            width: NO_GO_ZONE_MM.width,
            height: NO_GO_ZONE_MM.height,
        };
    }

    // Bounding box (world mm) of everything that makes up a board -
    // placements, fiducials, and the outline - defaulting to the active one.
    // null if the board's empty. Takes a plain board object (see
    // createEmptyBoard()), not an index, so centerBoardOnPlate() can also
    // check other boards' bounds when tiling a freshly added one around
    // them. Would need to grow to cover padShapes too if that overlay were
    // ever used before this bounds check.
    getBoardBounds(board = this.activeBoard){
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of board.placements) {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        }
        for (const f of board.fiducials) {
            minX = Math.min(minX, f.x); minY = Math.min(minY, f.y);
            maxX = Math.max(maxX, f.x); maxY = Math.max(maxY, f.y);
        }
        for (const seg of board.boardOutline) {
            minX = Math.min(minX, seg.x1, seg.x2); minY = Math.min(minY, seg.y1, seg.y2);
            maxX = Math.max(maxX, seg.x1, seg.x2); maxY = Math.max(maxY, seg.y1, seg.y2);
        }
        if (!isFinite(minX)) return null;
        return { minX, minY, maxX, maxY };
    }

    // Permanently shifts every board coordinate - placements, fiducials, both
    // pad-footprint overlays (paste and mask), and the outline - by (dx, dy)
    // world mm. This is the only
    // thing that ever moves a loaded board: the point-viz canvas's world
    // frame IS the machine bed frame, so a committed drag has to become the
    // board's real position rather than a separate on-canvas-only offset -
    // otherwise gcode generation (which falls back to point.x/y whenever
    // fid-cal hasn't set calX/calY, see pointDispenseCommands()) would still
    // target the board's pre-drag position.
    //
    // Deliberately leaves calX/calY/searchX/searchY alone - those are real
    // jogged/calibrated machine positions from an actual fid-cal run, not
    // derived from the raw x/y this shifts.
    translateBoard(dx, dy){
        if (dx === 0 && dy === 0) return;
        for (const p of this.placements) { p.x += dx; p.y += dy; }
        for (const f of this.fiducials) { f.x += dx; f.y += dy; }
        for (const pad of this.padShapes) { this.translatePad(pad, dx, dy); }
        for (const pad of this.maskPadShapes) { this.translatePad(pad, dx, dy); }
        for (const seg of this.boardOutline) {
            seg.x1 += dx; seg.x2 += dx;
            seg.y1 += dy; seg.y2 += dy;
        }
    }

    // Shifts one pad's own center by (dx, dy) - and, for a region pad (see
    // padFromRegionContours() in gerberImport.js), every vertex of its
    // traced contours too, or they'd stay behind at the board's pre-shift
    // position while pad.x/y moved on without them (exactly the coordinate
    // mismatch a plain `pad.x += dx` alone produced here before: dispense
    // dots computed as pad.x+dx offsets landed at the board's new position,
    // but pointInContours() was still testing them against the OLD one).
    translatePad(pad, dx, dy){
        pad.x += dx; pad.y += dy;
        if (!pad.contours) return;
        for (const contour of pad.contours) {
            for (const v of contour) { v.x += dx; v.y += dy; }
        }
    }

    // Gives a freshly imported board a sane starting position on the bed:
    // centered left-right (and centered in whatever room is left above the
    // no-go zone, or centered on the whole bed if the board's taller than
    // that leftover room) - UNLESS another board is already sitting there,
    // in which case this one tiles to the right of it (wrapping to a new row
    // if that would run it off the plate's right edge), so pasting several
    // boards into their own tabs doesn't just stack them on top of each
    // other. Just a starting point either way - the user can drag any board
    // anywhere from here.
    centerBoardOnPlate(){
        const bounds = this.getBoardBounds();
        if (!bounds) return;

        const plate = this.getActiveBuildPlate();
        const noGo = this.getNoGoZoneRect();
        const tileMargin = 10;

        const boardWidth = bounds.maxX - bounds.minX;
        const boardHeight = bounds.maxY - bounds.minY;

        const spaceAboveNoGo = plate.height - noGo.height;
        let targetCenterY = (boardHeight <= spaceAboveNoGo)
            ? noGo.height + spaceAboveNoGo / 2
            : plate.height / 2;
        let targetCenterX = plate.width / 2;

        const otherBounds = this.boards
            .filter(board => board !== this.activeBoard)
            .map(board => this.getBoardBounds(board))
            .filter(Boolean);

        if (otherBounds.length > 0) {
            const rightmost = Math.max(...otherBounds.map(b => b.maxX));
            targetCenterX = rightmost + tileMargin + boardWidth / 2;
            targetCenterY = noGo.height + spaceAboveNoGo / 2;

            if (targetCenterX + boardWidth / 2 > plate.width) {
                targetCenterX = boardWidth / 2 + tileMargin;
                const rowTop = Math.max(...otherBounds.map(b => b.maxY));
                targetCenterY = rowTop + tileMargin + boardHeight / 2;
            }
        }

        const dx = targetCenterX - (bounds.minX + boardWidth / 2);
        const dy = targetCenterY - (bounds.minY + boardHeight / 2);

        this.translateBoard(dx, dy);
    }

    // this does a few things
    // it draws the machine's build plate (and its no-go zone) as a fixed
    // top-down reference, then draws all the points and fids in the loaded
    // job on top of it, offset by any in-progress board drag
    // it also saves all the drawn positions to the point and fid objects for easier click detection
    //
    drawJobToCanvas(){

        const ctx = this.jobCanvas.getContext("2d");
        const canvasWidth = this.jobCanvas.width;
        const canvasHeight = this.jobCanvas.height;

        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        const plate = this.getActiveBuildPlate();

        // Fit the whole build plate into the canvas - not just whatever board
        // happens to be loaded - so the canvas is always a to-scale top-down
        // view of the actual machine bed, no-go zone included, even with no
        // job loaded yet.
        const margin = Math.max(plate.width, plate.height) * 0.05;
        const minX = -margin;
        const minY = -margin;
        const width = plate.width + margin * 2;
        const height = plate.height + margin * 2;

        // Calculate scale to fit the canvas while maintaining aspect ratio
        const scaleX = canvasWidth / width;
        const scaleY = canvasHeight / height;
        const fitScale = Math.min(scaleX, scaleY);

        // Calculate shifts to center the bed - including extra centering
        // along whichever axis has slack after fitting, so the bed sits in
        // the middle of the canvas instead of pinned to its bottom-left
        // corner. Without this, zooming in from the canvas center (mouse wheel,
        // +/- buttons) can zoom into empty space when the bed's aspect ratio
        // doesn't match the canvas.
        const xShift = -minX + (canvasWidth / fitScale - width) / 2;
        const yShift = -minY + (canvasHeight / fitScale - height) / 2;

        // User-applied zoom/pan (see setupCanvasInteractions/zoomViewAt) sits on
        // top of the auto-fit computed above: scale multiplies it, pan is a flat
        // canvas-pixel offset applied after.
        const scale = fitScale * this.view.scale;
        const panX = this.view.panX;
        const panY = this.view.panY;

        // Cached so setupCanvasInteractions()'s board-drag handler can convert
        // a screen-pixel drag delta into world mm.
        this.lastDrawScale = scale;

        // World-mm -> canvas-pixel, not yet Y-flipped (every draw below flips
        // with canvasHeight - y right before drawing, same convention the
        // click-hit-testing in returnClosestFidFromClickCoordinates() expects).
        const toCanvasX = (x) => (x + xShift) * scale + panX;
        const toCanvasY = (y) => (y + yShift) * scale + panY;

        // Draw the bed outline - scales with whatever plate.width/height
        // the active plate (preset or custom) actually has, so a custom
        // plate's outline resizes right along with its X/Y size inputs.
        ctx.strokeStyle = "#444";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(
            toCanvasX(0),
            canvasHeight - toCanvasY(plate.height),
            plate.width * scale,
            plate.height * scale
        );

        // Draw the no-go zone (vacuum bed hardware lives there on every
        // preset plate) as a hatched red box - skipped for 'custom', which
        // has no known real hardware footprint to draw one for (see
        // getNoGoZoneRect()'s own zero-size return for it).
        if (this.buildPlateId !== 'custom') {
            const noGo = this.getNoGoZoneRect();
            const noGoX = toCanvasX(noGo.x);
            const noGoYTop = canvasHeight - toCanvasY(noGo.y + noGo.height);
            const noGoW = noGo.width * scale;
            const noGoH = noGo.height * scale;

            ctx.save();
            ctx.fillStyle = "rgba(220, 50, 50, 0.15)";
            ctx.fillRect(noGoX, noGoYTop, noGoW, noGoH);
            ctx.strokeStyle = "rgba(200, 30, 30, 0.8)";
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(noGoX, noGoYTop, noGoW, noGoH);
            ctx.setLineDash([]);
            if (noGoW > 60 && noGoH > 16) {
                ctx.fillStyle = "rgba(150, 20, 20, 0.9)";
                ctx.font = "11px Nunito, sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("No-Go Zone", noGoX + noGoW / 2, noGoYTop + noGoH / 2);
            }
            ctx.restore();
        }

        const anyBoardHasContent = this.boards.some(board =>
            board.placements.length > 0 || board.fiducials.length > 0 || (board.boardOutline && board.boardOutline.length > 0)
        );
        if (!anyBoardHasContent) return;

        // Every board draws here - not just the active tab's - so zooming
        // out shows the whole bed's layout across every pasted board (see
        // this.boards). Only the active board can be mid-drag
        // (setupCanvasInteractions()/translateBoard() only ever move it), so
        // dragPreview only applies to that one; the others render a bit
        // dimmer so it's obvious which board a drag (or the Job Positions
        // list) is currently acting on - switch its tab to make it active.
        for (const board of this.boards) {
            const isActive = board === this.activeBoard;
            const dragX = isActive ? this.dragPreview.x : 0;
            const dragY = isActive ? this.dragPreview.y : 0;
            const hasOutline = board.boardOutline && board.boardOutline.length > 0;

            // A board with a real fid-cal run (board.fidCalMatrix - see
            // transformPlacements()) draws at its TRUE rotation/position on
            // the bed instead of its nominal as-imported one: fidCalMatrix
            // already maps design coords to real machine coords, so this
            // just finishes the trip into plate-local coords (see
            // PLATE_ORIGIN_MACHINE_MM) - "fits the outline" automatically
            // whenever the board was actually taped down within the real
            // working area. dragPreview is ignored once calibrated - the
            // position is real now, not a preview to nudge. calRotationDeg
            // (atan2 of the matrix's linear part) gets added to every pad's
            // own rotationDeg below so drawn pad shapes turn with the board,
            // not just their center points.
            const calMatrix = board.fidCalMatrix;
            const calRotationDeg = calMatrix ? Math.atan2(calMatrix.b, calMatrix.a) * 180 / Math.PI : 0;
            const plateOrigin = this.getPlateOriginMachineMm();
            const boardPoint = calMatrix
                ? (x, y) => {
                    const [mx, my] = applyToPoint(calMatrix, [x, y]);
                    return [mx - plateOrigin.x, my - plateOrigin.y];
                }
                : (x, y) => [x + dragX, y + dragY];

            ctx.save();
            if (!isActive) ctx.globalAlpha = 0.45;

            // Draw the board outline first so placement/fiducial dots layer on top of it.
            if (hasOutline) {
                ctx.strokeStyle = "#999";
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (const seg of board.boardOutline) {
                    const [wx1, wy1] = boardPoint(seg.x1, seg.y1);
                    const [wx2, wy2] = boardPoint(seg.x2, seg.y2);
                    const x1 = toCanvasX(wx1);
                    const y1 = toCanvasY(wy1);
                    const x2 = toCanvasX(wx2);
                    const y2 = toCanvasY(wy2);
                    ctx.moveTo(x1, canvasHeight - y1);
                    ctx.lineTo(x2, canvasHeight - y2);
                }
                ctx.stroke();
            }

            // Draw pad footprints (semi-transparent) under the fid/dispense
            // dots, so the dots' placement relative to the actual pad can be
            // checked at a glance. Two independent toggles (from the
            // visualization controls): the paste layer (what actually gets
            // dispensed on, and what dispenseDegrees/volume are computed
            // from - see buildPlacementsFromPadShapes()) and the mask layer
            // (the true copper-exposed opening, which some fabs/footprints
            // make a different size than the paste aperture) can genuinely
            // differ, and comparing them is exactly the point of having
            // both. Only ever for the active board - a close-look tool for
            // whichever board you're currently working on.
            const drawPadOverlay = (pads, fillStyle, strokeStyle) => {
                if (!pads || pads.length === 0) return;
                ctx.save();
                ctx.globalAlpha = 0.35;
                ctx.fillStyle = fillStyle;
                ctx.strokeStyle = strokeStyle;
                ctx.lineWidth = 1;

                for (const pad of pads) {
                    const [wx, wy] = boardPoint(pad.x, pad.y);
                    const cx = toCanvasX(wx);
                    const cy = canvasHeight - toCanvasY(wy);
                    const w = Math.max((pad.xSize ?? pad.diameter ?? 0.3) * scale, 1);
                    const h = Math.max((pad.ySize ?? pad.diameter ?? 0.3) * scale, 1);

                    ctx.save();
                    ctx.translate(cx, cy);
                    // pad.rotationDeg (see roundedRectGeometry() in
                    // gerberImport.js) is a standard CCW angle in world space
                    // (Y-up), plus calRotationDeg if this board is
                    // calibrated (so the pad's drawn shape turns with the
                    // board's real rotation, not just its center point);
                    // canvas Y is flipped for display (cy above), which
                    // reverses rotation handedness, so the canvas-space angle
                    // is the negative of that total. Without this, a rotated
                    // pad drew as an axis-aligned (and, since its
                    // xSize/ySize are now the true LOCAL dimensions, often
                    // wrong-shaped) box instead of its real rotated outline.
                    const totalRotationDeg = (pad.rotationDeg || 0) + calRotationDeg;
                    if (totalRotationDeg) ctx.rotate(-totalRotationDeg * Math.PI / 180);

                    ctx.beginPath();
                    if (pad.shape === 'region' && pad.contours) {
                        // Traces the real (possibly quite irregular) outline
                        // a gerber region carries (see padFromRegionContours()
                        // in gerberImport.js) instead of falling into the
                        // plain-rectangle case below - each vertex is world-
                        // space mm relative to the pad's own center, scaled
                        // to canvas px with Y negated (canvas Y grows
                        // downward, world Y grows upward - the rect/circle/
                        // obround shapes below never needed this since
                        // they're all symmetric about their own center, but
                        // an asymmetric traced outline draws mirrored without
                        // it).
                        for (const contour of pad.contours) {
                            if (contour.length < 2) continue;
                            ctx.moveTo((contour[0].x - pad.x) * scale, -(contour[0].y - pad.y) * scale);
                            for (let i = 1; i < contour.length; i++) {
                                ctx.lineTo((contour[i].x - pad.x) * scale, -(contour[i].y - pad.y) * scale);
                            }
                            ctx.closePath();
                        }
                    } else if (pad.shape === 'circle' || pad.shape === 'polygon') {
                        ctx.arc(0, 0, Math.max(w, h) / 2, 0, Math.PI * 2);
                    } else if (pad.shape === 'obround') {
                        drawRoundedRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) / 2);
                    } else {
                        ctx.rect(-w / 2, -h / 2, w, h);
                    }
                    ctx.fill();
                    ctx.stroke();
                    ctx.restore();
                }

                ctx.restore();
            };

            if (isActive && this.showPadOverlay) {
                drawPadOverlay(board.padShapes, "#b8860b", "#8b6508");
            }
            if (isActive && this.showMaskPadOverlay) {
                drawPadOverlay(board.maskPadShapes, "#2196F3", "#0d47a1");
            }

            // Draw fid points in blue
            ctx.fillStyle = "blue";
            for (let point of board.fiducials) {

                const [wx, wy] = boardPoint(point.x, point.y);
                const newX = toCanvasX(wx);
                const newY = toCanvasY(wy);

                point.canvasX = newX;
                point.canvasY = newY;

                ctx.beginPath();
                ctx.arc(newX, canvasHeight - newY, 2, 0, Math.PI * 2);
                ctx.fill();

            }

            // Draw paste points in red, sized by their dispense degrees (a
            // per-point override if the gerber import gave it one, otherwise
            // the job's global Dispense Degrees setting - same fallback
            // gcode generation uses, see pointDispenseCommands()). A
            // disabled point still draws (as a dim hollow circle instead of
            // a filled one) rather than vanishing - clicking a pad here
            // toggles it on/off (see setupCanvasInteractions()'s pad-click
            // handler, and returnClosestPlacementFromClickCoordinates()),
            // and a hidden pad could never be clicked back on again.
            for (let point of board.placements) {
                const [wx, wy] = boardPoint(point.x, point.y);
                const newX = toCanvasX(wx);
                const newY = toCanvasY(wy);

                point.canvasX = newX;
                point.canvasY = newY;

                const effectiveDegrees = point.dispenseDegrees ?? parseFloat(this.dispenseDegrees);
                const radius = Math.max(PLACEMENT_DOT_MIN_RADIUS_PX, placementDotRadiusMm(effectiveDegrees) * scale);
                // Stashed so returnClosestPlacementFromClickCoordinates() can
                // hit-test against this exact drawn size instead of a flat
                // guess - a pad's radius varies with its dispense amount and
                // the current zoom (both baked into `radius` above), so a
                // single fixed click threshold would drift out of sync with
                // what's actually on screen at any zoom level other than the
                // one it was tuned for.
                point.canvasRadius = radius;

                ctx.beginPath();
                ctx.arc(newX, canvasHeight - newY, radius, 0, Math.PI * 2);

                if (point.enabled === false) {
                    ctx.save();
                    ctx.strokeStyle = "rgba(150, 150, 150, 0.7)";
                    ctx.lineWidth = 1;
                    ctx.stroke();
                    ctx.restore();
                } else {
                    ctx.fillStyle = "red";
                    ctx.fill();
                }
            }

            ctx.restore();
        }

    }

    // returns the closest point object to a click coordinate on the canvas.
    // fiducials defaults to the ACTIVE board's (this.fiducials) but
    // loadGerberFiles()'s manual fid-pick flow passes its captured board's
    // list explicitly instead, so a click still matches against the board
    // that flow actually started on even if the active board could somehow
    // change out from under it.
    returnClosestFidFromClickCoordinates(clickX, clickY, fiducials = this.fiducials){
        // Find the closest point within a larger threshold
        const threshold = 10.0; // 2mm threshold for easier clicking
        let closestPoint = null;
        let minDistance = Infinity;

        // Only check fid points
        for (const point of fiducials) {
            // console.log("checking against: ", point.canvasX, point.canvasY)
            const distance = Math.sqrt(
                Math.pow(point.canvasX - clickX, 2) +
                Math.pow(point.canvasY - clickY, 2)
            );
            if (distance < threshold && distance < minDistance) {
                minDistance = distance;
                closestPoint = point;
            }
        }

        return closestPoint;

    }

    // The placement counterpart to returnClosestFidFromClickCoordinates(),
    // used by the pad-click-to-toggle handler in setupCanvasInteractions().
    // Only ever searches the ACTIVE board's placements (this.placements) -
    // dots belonging to a different, dimmed-out board in the multi-board
    // view aren't clickable from here; switch to that board's tab first.
    //
    // Per-point threshold (canvasRadius, set alongside canvasX/canvasY in
    // drawJobToCanvas()) rather than one flat distance for every pad - a
    // pad's drawn size varies with its dispense amount and the current zoom,
    // so a single fixed radius would only ever match the visible dot at one
    // particular combination of those, and drift out of sync everywhere else
    // (too small to click a big/zoomed-in dot, or a misleadingly large
    // invisible halo around a tiny/zoomed-out one that could catch a click
    // meant for a denser neighboring pad instead).
    returnClosestPlacementFromClickCoordinates(clickX, clickY){
        let closestPoint = null;
        let minDistance = Infinity;

        for (const point of this.placements) {
            if (point.canvasX == null || point.canvasY == null) continue;
            const threshold = (point.canvasRadius ?? 0) + PLACEMENT_CLICK_MARGIN_PX;
            const distance = Math.sqrt(
                Math.pow(point.canvasX - clickX, 2) +
                Math.pow(point.canvasY - clickY, 2)
            );
            if (distance < threshold && distance < minDistance) {
                minDistance = distance;
                closestPoint = point;
            }
        }

        return closestPoint;
    }

    // Shows a toast whose text ends with an inline button; clicking that
    // button resolves the toast with `buttonValue` immediately, instead of
    // waiting for whatever the caller's own click handler would otherwise
    // feed toast.receivedInput (a canvas click, in every caller here).
    // Closing the toast normally still resolves with `false`, same as any
    // other toast.show(). Used to offer "use 3 pads instead" as an escape
    // hatch from both the real-fiducial-candidate click-through
    // (loadGerberFiles()) and findBoardRoughPosition()'s "needs exactly 3
    // fiducials" gate - see pickPadsAsFiducials().
    async showToastWithButton(message, buttonLabel, buttonValue){
        const resultPromise = this.toast.show(
            `${message} <button id="toastInlineActionBtn" class="goldenrod-button" type="button" style="margin-left:8px;">${buttonLabel}</button>`
        );
        // toast.show() already reset receivedInput and set the markup above
        // synchronously before returning the (still-pending) promise, so the
        // button exists in the DOM right now to wire up.
        document.getElementById('toastInlineActionBtn')?.addEventListener('click', () => {
            this.toast.receivedInput = buttonValue;
        });
        return await resultPromise;
    }

    // Lets the user designate 3 existing dispense points (ideally ones near
    // the PCB's corners) as fiducial substitutes, for a board with no real
    // fiducial features - or bad/insufficient auto-detected candidates (see
    // findFiducialCandidates() in gerberImport.js). Reuses the exact same
    // toast-driven "click a point in the canvas" interaction the
    // real-fiducial pick flow uses (see loadGerberFiles()), just matching
    // against board.placements (via returnClosestPlacementFromClickCoordinates)
    // instead of board.fiducials, since this board has no (or not enough)
    // fiducial candidates to click. Offered from both loadGerberFiles()
    // (right after import) and findBoardRoughPosition() (if a board still
    // doesn't have exactly 3 fiducials by the time that's needed) via
    // showToastWithButton().
    //
    // Overwrites board.fiducials with the 3 picks if all 3 are actually
    // picked; leaves it untouched (and returns false) if cancelled partway
    // through. The picked points become plain Fiducials with no
    // searchX/searchY or calX/calY yet - Get Rough Board Position / Perform
    // Fid Cal fill those in exactly like a real fiducial, jogging/vision-
    // centering on whatever's physically at that pad's location on the real
    // board. Doesn't manage this._boardFlowActive itself - callers that are
    // themselves a top-level flow (findBoardRoughPosition()) are expected to
    // already be holding it, same as every other sub-step those call.
    async pickPadsAsFiducials(board = this.activeBoard){
        if (board.placements.length === 0) {
            alert('This board has no dispense points to pick from - import a gerber first.');
            return false;
        }

        function sendPlacementClickToToast(event){
            const rect = this.jobCanvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = this.jobCanvas.height - (event.clientY - rect.top); // Flip Y coordinate

            const closest = this.returnClosestPlacementFromClickCoordinates(x, y);
            if (closest) {
                this.toast.receivedInput = closest;

                const ctx = this.jobCanvas.getContext("2d");
                ctx.fillStyle = "lime";
                ctx.fillRect(closest.canvasX - 4, this.jobCanvas.height - closest.canvasY - 4, 8, 8);
            } else {
                console.log("no matching pad click");
            }
        }

        // Same bind-once-and-share-the-reference requirement as
        // loadGerberFiles()'s boundSendClickToToast - see its comment.
        const boundClick = sendPlacementClickToToast.bind(this);
        this.jobCanvas.addEventListener('click', boundClick);
        this._pickingFiducials = true;

        const picks = [];
        try {
            for (let i = 1; i <= 3; i++) {
                const result = await this.toast.show(`Click a pad to use as Fiducial ${i} - a pad near a corner works best.`);
                if (!result) break; // cancelled - picks stays short, handled below
                picks.push(result);
            }
        } finally {
            this.jobCanvas.removeEventListener('click', boundClick);
            this._pickingFiducials = false;
        }

        if (picks.length !== 3) {
            console.warn('Pad-as-fiducial selection was cancelled.');
            return false;
        }

        // Same shape as a mask-derived fiducial candidate (see
        // loadGerberFiles()) - a plain Fiducial at the pad's real design
        // position and the board's default touch-off Z.
        board.fiducials = picks.map(p => new Fiducial(p.x, p.y, 31.5));

        this.loadJobIntoPositionList();
        this.drawJobToCanvas();
        return true;
    }

    // Turns raw pad footprints (pastePads - the same shapes kept in
    // this.padShapes for the pad-outline overlay) into dispense-point
    // placements, using whatever Advanced Settings tab tuning is live right
    // now (see gerberImport.js's getPasteDispenseSettings/
    // setPasteDispenseSettings). Shared by loadGerberFiles() (first import)
    // and recomputeDispensePattern() (re-running the same pads through new
    // settings without re-importing the gerber), so the two can't drift.
    //
    // Pads are classified from their real aperture geometry: elongated pads get
    // a line of dots, large open pads (e.g. QFN thermal pads) get a grid, and
    // pads sitting in a fine pitch row (TSOP/QFP-style) get a single dot that
    // alternates position slightly to cut bridging risk. Each dot's dispense
    // volume is scaled off a 55.1-degree-for-a-0402-pad baseline. See
    // gerberImport.js for the tunable thresholds.
    //
    // Points are returned in component order - grouped by refdes (from the
    // paste layer's %TO.C% attributes, if the export included them) and
    // ordered by part type (resistors, then capacitors, then ICs, then
    // everything else) rather than a raster scan across the board - which is
    // also then the order placements dispense in during a run. A board
    // without those attributes falls back to the previous raster order.
    buildPlacementsFromPadShapes(pastePads){
        const taggedPads = tagTightPitchPads(pastePads);
        const groups = groupPadsByComponent(taggedPads);

        // Alternating +1/-1 per tight-pitch pad (proper graph 2-coloring, see
        // computeAlternatingSigns), computed once up front, independent of
        // group/traversal order - which direction planPadDispense() nudges
        // that pad's single dot to stagger a row of closely spaced leads.
        const alternatingSigns = computeAlternatingSigns(taggedPads);

        const placements = [];
        for (const group of groups) {
            for (const pad of group.pads) {
                const sign = pad.tightPitch ? (alternatingSigns.get(pad) ?? 0) : 0;

                const overrides = this.componentOverrides.get(group.refdes);
                const {points: dots, pattern} = planPadDispense(pad, parseFloat(this.dispenseDegrees), sign, overrides);
                for (const {dx, dy, dispenseDegrees, padAreaMm2} of dots){
                    const point = new Point(pad.x + dx, pad.y + dy, 31.5, dispenseDegrees);
                    point.refdes = group.refdes;
                    point.componentType = group.type;
                    point.dispensePattern = pattern;
                    point.padAreaMm2 = padAreaMm2 ?? null;
                    // See flagPadsContainedByLargerPad() in gerberImport.js -
                    // this pad's whole footprint sits inside a bigger pad's
                    // own, so whatever that bigger pad's own pattern already
                    // dispenses there covers it too. Starts disabled (not
                    // dropped) so it's still visible - and re-enable-able -
                    // in the Job Positions list if that guess is wrong here.
                    if (pad.containedByLargerPad) point.enabled = false;
                    placements.push(point);
                }
            }
        }
        return placements;
    }

    // Estimated paste volume (mm3, == microliters) for one dispense point,
    // from its own share of its pad's real gerber-measured area (see
    // planPadDispense()'s padAreaMm2 in gerberImport.js) times the job's
    // current stencil thickness - NOT from its dispenseDegrees, so this stays
    // a pure "what would print" figure independent of auger calibration
    // tuning. null for points with no known pad geometry (manually captured
    // points, fiducials).
    pointPasteVolumeMm3(point){
        if (point.padAreaMm2 == null) return null;
        return padPasteVolumeMm3(point.padAreaMm2, this.stencilThicknessMm);
    }

    // Sums pointPasteVolumeMm3() across any list of points (a component's,
    // a type's, a whole board's) - points with no known pad geometry just
    // contribute 0, so a job with some manually captured points still gets a
    // meaningful (if slightly under-counted) total instead of null.
    totalPasteVolumeMm3(points){
        let total = 0;
        for (const p of points) total += this.pointPasteVolumeMm3(p) || 0;
        return total;
    }

    // Re-runs EVERY board's pads through recomputeActiveBoardDispensePattern()
    // (below) with whatever Advanced Settings are live right now, so
    // tweaking a job-wide setting shows up immediately on every pasted board,
    // not just whichever tab happens to be open - a global setting change
    // that only touched the active board would leave the others silently
    // stale until you happened to revisit their tab and trigger something
    // else. Temporarily flips activeBoardIndex through each board so the
    // per-board worker (and everything it calls) can keep reading/writing
    // this.placements/this.padShapes/etc via the normal getters, unchanged.
    // Renders once at the end instead of once per board.
    recomputeDispensePattern(){
        const originalIndex = this.activeBoardIndex;
        let anyRecomputed = false;

        for (let i = 0; i < this.boards.length; i++) {
            this.activeBoardIndex = i;
            if (this.recomputeActiveBoardDispensePattern()) anyRecomputed = true;
        }

        this.activeBoardIndex = originalIndex;
        this.loadJobIntoPositionList();
        this.drawJobToCanvas();
        return anyRecomputed;
    }

    // The actual recompute work for whichever board is currently active (see
    // recomputeDispensePattern()'s loop above, which is the only caller).
    // Rebuilds that board's placements from its padShapes. Re-applies the
    // existing fid-cal transform (if any), the board's calibrated Z, each
    // component's enabled/disabled selection, and any manually captured
    // points to the freshly rebuilt placements, so none of that gets
    // silently lost just from touching a slider. Doesn't render - the caller
    // does that once after every board is done. Returns false (no-op) if
    // this board has no gerber-imported pads yet.
    recomputeActiveBoardDispensePattern(){
        if (!this.padShapes || this.padShapes.length === 0) return false;

        // Manually captured points (Capture Position button -> addPoint())
        // aren't derived from padShapes at all, so buildPlacementsFromPadShapes()
        // has no way to regenerate them - replacing this.placements outright
        // would silently delete them. They're the only placements that ever
        // have a null refdes (every gerber-derived point gets one, even a
        // synthetic "Part N" for a board with no %TO.C% attributes - see
        // groupPadsByComponent), so that's a reliable way to pull them out
        // before the rebuild and carry them forward unchanged - their x/y/z
        // are already real captured machine coordinates, not gerber-space
        // ones, so they must NOT go through the Z-restore or fid-cal-matrix
        // steps below (those only make sense for the freshly rebuilt
        // gerber-derived points).
        const gerberPoints = this.placements.filter(p => p.refdes != null);
        const manualPoints = this.placements.filter(p => p.refdes == null);

        // Which components were checked/unchecked before the rebuild, so a
        // settings tweak doesn't silently re-enable everything. The Job
        // Positions list only ever toggles enabled at whole-component (or
        // whole-type, or select all/none) granularity - see
        // renderComponentGroup/renderComponentTypeGroup/setAllPlacementsEnabled
        // - never a single pad within a component, so "every pad of this
        // refdes was enabled" faithfully captures that component's checkbox
        // state regardless of how many dots it had before. A settings change
        // can still change how many dots a pad gets, so this maps by refdes
        // rather than trying to carry the flag across old dot -> new dot
        // (no stable 1:1 mapping between them).
        const enabledByRefdes = new Map();
        for (const p of gerberPoints) {
            const prevEnabled = enabledByRefdes.has(p.refdes) ? enabledByRefdes.get(p.refdes) : true;
            enabledByRefdes.set(p.refdes, prevEnabled && p.enabled !== false);
        }

        // Grabbing an existing point's Z before rebuilding preserves whatever
        // board calibration already set, as a flat fallback -
        // buildPlacementsFromPadShapes() stamps its own points with a
        // hardcoded default Z (pre-calibration placeholder height), which
        // would otherwise silently override a real board calibration on
        // every settings tweak. null when there's nothing loaded yet (a
        // fresh gerber import, before board calibration has run) - leave
        // buildPlacementsFromPadShapes()'s default alone in that case.
        const priorZ = gerberPoints.length ? gerberPoints[0].z : null;

        this.placements = this.buildPlacementsFromPadShapes(this.padShapes);

        for (const point of this.placements) {
            const enabled = enabledByRefdes.get(point.refdes);
            if (enabled !== undefined) point.enabled = enabled;
        }

        if (priorZ != null) {
            for (const point of this.placements) point.z = priorZ;
        }

        if (this.fidCalMatrix) {
            for (const point of this.placements) {
                const [calX, calY] = applyToPoint(this.fidCalMatrix, [point.x, point.y]);
                point.calX = calX;
                point.calY = calY;
            }
        }

        // Re-tilts Z across the freshly rebuilt placements from the
        // fiducials' own heights (see applyFiducialZTransform()), the same
        // way a rough-position/fid-cal run would - refines the flat priorZ
        // restore above into a real plane wherever the fiducials have the
        // 3-point height data for one; otherwise a no-op, leaving priorZ's
        // flat height (or the placeholder default) alone.
        this.applyFiducialZTransform();

        this.placements.push(...manualPoints);

        return true;
    }

    // Imports a paste (+ optional mask, + optional board outline) layer from
    // whatever was selected in the gerber file input - either a single zip
    // (typical KiCad/JLCPCB/EasyEDA fab output bundle) or several loose gerber
    // files - auto-detecting which file is which from the Gerber X2
    // %TF.FileFunction% attribute (falling back to filename conventions for
    // older exports that don't have it).
    async loadGerberFiles(fileList){
        if (this.warnIfBoardFlowActive()) return {padCount: 0, fiducialCount: 0};

        // Pinned to whichever board is active right now, for the entire
        // call - importGerberSet() below is itself async, and the manual
        // fid-pick section further down awaits several toasts, so this
        // can't just keep reading/writing this.placements/this.fiducials
        // (the ACTIVE board's) throughout: if the user could switch boards
        // partway through, the import would land on the wrong tab. Guarded
        // against that for real via _boardFlowActive below (switchToBoard()/
        // addBoard()/removeBoard() all refuse to run while it's true) - board
        // is threaded through explicitly anyway as defense in depth.
        const board = this.activeBoard;
        this._boardFlowActive = true;

        try {
            const {pastePads, maskFlashes, outline, warnings, drillHoles} = await importGerberSet(fileList);

            if (warnings.length) console.warn('Gerber import warnings:', warnings);

            // Importing a gerber set replaces whatever was previously loaded on
            // THIS tab's board - otherwise the new board's pads/fiducials pile
            // up on top of the old ones and the two get mixed together on the
            // canvas and in the position list. To paste an additional board
            // instead of replacing this one, open a new tab first (see
            // addBoard()/the "+" button in renderBoardTabs()).
            board.placements = [];
            board.fiducials = [];
            board.expandedComponents = new Set();
            board.expandedOverrides = new Set();
            // A previous board's refdes-keyed overrides have nothing to do with
            // this new board's (likely differently-named) components.
            board.componentOverrides = new Map();
            // Deliberately NOT resetting this.view here - the camera is shared
            // across every board's tab (see drawJobToCanvas()), so importing
            // into one tab shouldn't snap another tab's zoomed-out "see every
            // board" view back to default.
            this.dragPreview = { x: 0, y: 0 };
            // A previous board's fid cal has nothing to do with this new one's
            // raw coordinates - don't let recomputeDispensePattern() apply it.
            board.fidCalMatrix = null;

            board.boardOutline = outline;
            board.padShapes = pastePads;
            board.maskPadShapes = maskFlashes;

            board.placements = this.buildPlacementsFromPadShapes(pastePads);

            // Candidate fiducials: mask openings that don't correspond to a paste
            // pad, further narrowed by findFiducialCandidates() to drop drilled
            // holes (through-hole pins/vias/mounting holes - never a real
            // fiducial) and connector/header-style repeating arrays. Boards
            // without Gerber X2 metadata (no %TO.C%/%TF.FileFunction%, e.g. a lot
            // of JLCPCB/EasyEDA exports) tend to have dozens of ordinary exposed
            // pads with no paste under them - without this, every one of those
            // shows up as a "fiducial" to click through.
            const onlyInMask = maskFlashes.filter(mask =>
                !pastePads.some(pad => Math.abs(pad.x - mask.x) < 0.05 && Math.abs(pad.y - mask.y) < 0.05)
            );
            const fiducialCandidates = findFiducialCandidates(onlyInMask, drillHoles);

            for(const maskData of fiducialCandidates){
                const newPoint = new Point(maskData.x, maskData.y, 31.5);
                board.fiducials.push(newPoint);
            }

            // Give the freshly imported board a sane starting position on the
            // selected build plate (centered, clear of the no-go zone if it
            // fits) - the user can drag it anywhere from here. Safe to call
            // without passing board explicitly: nothing async has happened
            // since board was captured above, so this.activeBoard is still
            // guaranteed to be it (and _boardFlowActive blocks it changing
            // out from under this synchronous stretch regardless).
            this.centerBoardOnPlate();

            // Draw immediately so the imported board is visible right away, before
            // we even get to the (optional, and possibly interrupted) fiducial step.
            this.drawJobToCanvas();
            this.loadJobIntoPositionList();

            if (board.fiducials.length < 3) {
                // Clicking asks returnClosestFidFromClickCoordinates() to match a candidate
                // within a small pixel threshold - with fewer than 3 candidates on the board,
                // some of those clicks can never match anything, so the toast-driven flow
                // below would wait forever. Skip it without blocking the view of the board - but
                // offer designating 3 pads as fiducial substitutes instead (see
                // pickPadsAsFiducials()), for a board with no real fiducial features at all.
                console.warn(`Only found ${board.fiducials.length} fiducial candidate(s) on the mask layer (need 3). Offering pad-based fiducials instead.`);
                const usePads = await this.showToastWithButton(
                    `Only found ${board.fiducials.length}/3 fiducial candidates on this board.`,
                    'Use 3 Pads as Fiducials', true
                );
                if (usePads) await this.pickPadsAsFiducials(board);
                return {padCount: board.placements.length, fiducialCount: board.fiducials.length};
            }

            // set up event listener for first fid selection
            // which just puts the closest point object directly into this.toast.receivedInput

            // we need a named function for removing the event listener later

            function sendClickToToast(event){


                const rect = this.jobCanvas.getBoundingClientRect();

                const x = event.clientX - rect.left;
                const y = this.jobCanvas.height - (event.clientY - rect.top); // Flip Y coordinate

                let closestClick = this.returnClosestFidFromClickCoordinates(x, y, board.fiducials);

                if (closestClick !== null){
                    this.toast.receivedInput = closestClick
                    console.log("her'es the point: ", this.toast.receivedInput)

                    const ctx = this.jobCanvas.getContext("2d");
                    ctx.fillStyle = "green";
                    ctx.fillRect(closestClick.canvasX - 4, this.jobCanvas.height - closestClick.canvasY - 4, 8, 8);

                }
                else {
                    console.log("no matching click")
                }
            }

            console.log("setting event listener");

            // .bind() returns a new function each time it's called, so addEventListener
            // and removeEventListener must share this exact reference - passing
            // sendClickToToast.bind(this) again to removeEventListener would silently
            // fail to match, leaking this listener on the canvas forever and letting
            // stray clicks (long after fid selection is done) keep setting
            // this.toast.receivedInput out from under whatever toast shows up next.
            const boundSendClickToToast = sendClickToToast.bind(this);
            this.jobCanvas.addEventListener("click", boundSendClickToToast);
            this._pickingFiducials = true;

            try {
                // Each of these resolves to the clicked Fiducial candidate, `false` if
                // the user closed the toast, or USE_PADS_FIDUCIAL_SENTINEL if they hit
                // the toast's "Use 3 pads instead" button (see showToastWithButton()) -
                // an escape hatch for when the auto-detected candidates are wrong/unwanted
                // even though there were 3+ of them. Checked one at a time (not all
                // three up front) so hitting that button on, say, FID2 doesn't first
                // force clicking through FID3 too.
                let switchToPads = false;
                const pickedFids = [];
                for (let i = 1; i <= 3; i++) {
                    const result = await this.showToastWithButton(
                        `Please click on FID${i} in the display.`, 'Use 3 pads instead', USE_PADS_FIDUCIAL_SENTINEL
                    );
                    if (result === USE_PADS_FIDUCIAL_SENTINEL) { switchToPads = true; break; }
                    if (!result) break; // cancelled - pickedFids stays short, handled below
                    pickedFids.push(result);
                }

                if (switchToPads) {
                    // Tear down THIS listener before handing off - otherwise
                    // it stays attached (armed by _pickingFiducials, same as
                    // now) for the whole pickPadsAsFiducials() flow below,
                    // which sets up its own, and every click during that
                    // flow fires both handlers at once.
                    this.jobCanvas.removeEventListener('click', boundSendClickToToast);
                    this._pickingFiducials = false;
                    await this.pickPadsAsFiducials(board);
                } else if (pickedFids.length === 3) {
                    board.fiducials = pickedFids;
                } else {
                    console.warn('Fiducial selection was cancelled - keeping the auto-detected candidates instead.');
                }
            } finally {
                // cancel event listener for fid selection
                this.jobCanvas.removeEventListener('click', boundSendClickToToast)
                this._pickingFiducials = false;
            }

            console.log("fiducials: ", board.fiducials)
            console.log("placements: ", board.placements)

            //populate the position list
            this.loadJobIntoPositionList();
            // make some buttons red so that the user knows it's NOT ready to run a job yet

            this.drawJobToCanvas();

            return {padCount: board.placements.length, fiducialCount: board.fiducials.length};
        } finally {
            this._boardFlowActive = false;
        }
    }

    async findBoardRoughPosition(){
        if (this.warnIfBoardFlowActive()) return;

        // Pinned to whichever board is active right now, for the whole flow
        // - see the big comment on this._boardFlowActive in the constructor.
        // The user could switch tabs (or import another board) while a
        // toast here is waiting on them, so every write below goes to this
        // captured board rather than the this.fiducials/this.placements
        // active-board aliases, which could start pointing somewhere else
        // mid-flow. switchToBoard()/addBoard()/removeBoard() also refuse to
        // run at all while _boardFlowActive is true, so in practice this
        // never actually changes underneath - this is defense in depth. Set
        // before the fiducial-count check below too, since that can itself
        // kick off pickPadsAsFiducials()'s own toast-driven sub-flow.
        const board = this.activeBoard;
        this._boardFlowActive = true;

        try {
            if (board.fiducials.length !== 3) {
                // No real fiducials to jog to yet - offer pads as a
                // substitute (see pickPadsAsFiducials()) right here instead
                // of just refusing, so a board that skipped (or never had)
                // the import-time fiducial pick can still get through rough
                // position without going back to re-import.
                const usePads = await this.showToastWithButton(
                    'This board needs exactly 3 fiducials before its rough position can be set.',
                    'Use 3 Pads as Fiducials', true
                );
                if (!usePads) return;

                const picked = await this.pickPadsAsFiducials(board);
                if (!picked) return;
            }

            // Each step below offers an explicit "Continue" button rather than
            // just the toast's default close/arrow button, so that arrow can
            // reliably mean "cancel this rough-position pass" - nothing this
            // flow computes (fiducial search coords, the transform, the Z
            // plane) gets applied to the board or redrawn until it runs all
            // the way through, so bailing out at any of these steps leaves
            // the board exactly as it was before this call.

            // request in toast to jog to fid1
            let proceed = await this.showToastWithButton("Please jog the camera to be centered on FID1.", 'Continue', true);
            if (!proceed) return;

            // upon hitting continue, grab current position, save to fid1 searchXY
            const fid1Rough = await this.lumen.grabBoardPosition();

            console.log("fid1Rough: ", fid1Rough)

            board.fiducials[0].searchX = parseFloat(fid1Rough[0]);
            board.fiducials[0].searchY = parseFloat(fid1Rough[1]);

            // repeat for fid2 and fid3
            proceed = await this.showToastWithButton("Please jog the camera to be centered on FID2.", 'Continue', true);
            if (!proceed) return;
            const fid2Rough = await this.lumen.grabBoardPosition();
            board.fiducials[1].searchX = parseFloat(fid2Rough[0]);
            board.fiducials[1].searchY = parseFloat(fid2Rough[1]);

            proceed = await this.showToastWithButton("Please jog the camera to be centered on FID3.", 'Continue', true);
            if (!proceed) return;
            const fid3Rough = await this.lumen.grabBoardPosition();
            board.fiducials[2].searchX = parseFloat(fid3Rough[0]);
            board.fiducials[2].searchY = parseFloat(fid3Rough[1]);

            // ask to jog tip directly touching top surface
            proceed = await this.showToastWithButton("Please jog the paste extruder tip to just barely touch the board.", 'Continue', true);
            if (!proceed) return;

            // grab z pos and add .2 mm or something
            let zPos = await this.lumen.grabBoardPosition();

            await this.lumen.serial.send([`G0 Z${this.travelHeight}`]);

            zPos = parseFloat(zPos[2]) + 0.2;

            // Seed all three fiducials with this single touch's height - a flat
            // starting point, same as the old single-Z-for-everything behavior.
            // applyFiducialZTransform() below is what actually lets that become
            // a tilt: if the board sits slightly higher/lower on one side, edit
            // that fiducial's own Z field (see createPositionElement()) after
            // the fact and every placement's Z re-interpolates across the
            // resulting plane instead of staying flat.
            for (const fiducial of board.fiducials) {
                fiducial.z = zPos;
            }

            console.log(`board.fiducials: `, board.fiducials)

            this.transformPlacements([
                [board.fiducials[0].searchX, board.fiducials[0].searchY],
                [board.fiducials[1].searchX, board.fiducials[1].searchY],
                [board.fiducials[2].searchX, board.fiducials[2].searchY]
            ], board);

            this.applyFiducialZTransform(board);

            console.log(board.placements);

            this.loadJobIntoPositionList();
            // transformPlacements() above already set board.fidCalMatrix from
            // these rough (searchX/searchY) positions - same field
            // performFiducialCalibration()'s more precise pass sets - so
            // drawJobToCanvas() already knows how to draw this board at its
            // true rotation/position (see PLATE_ORIGIN_MACHINE_MM). Just
            // needs an actual redraw to show it now instead of waiting for
            // some unrelated interaction to trigger the next one.
            this.drawJobToCanvas();
        } finally {
            this._boardFlowActive = false;
        }
    }

    async performTipCalibration(){
        if (this.warnIfBoardFlowActive()) return;

        // Pinned to whichever board is active right now, for the whole flow
        // - tip offset is per-board data (see this.tipXoffset), and this
        // spans two toast pauses waiting on the user, same shape of issue as
        // findBoardRoughPosition()/performFiducialCalibration() (see the big
        // comment on this._boardFlowActive in the constructor).
        const board = this.activeBoard;
        this._boardFlowActive = true;

        try {
            // Each step below offers an explicit "Continue" button rather than
            // just the toast's default close/arrow button, so that arrow can
            // reliably mean "cancel, and don't touch this board's offsets" -
            // e.g. after this whole calibration was opened by mistake. Bailing
            // out here (before any position has been grabbed or written to the
            // board) leaves tipXoffset/tipYoffset completely untouched.
            let proceed = await this.showToastWithButton(
                "Please jog the camera to be centered on any fiducial.", 'Continue', true
            );
            if (!proceed) return;

            // upon hitting continue, grab current position, save to fid1 searchXY
            const camPos = await this.lumen.grabBoardPosition();

            await this.lumen.serial.send([`G0 Z${this.travelHeight}`]);

            await this.lumen.serial.goToRelative(NOZZLE_PREDICTED_OFFSET_MM.x, NOZZLE_PREDICTED_OFFSET_MM.y);

            await this.lumen.serial.send(["G0 Z48"]);

            proceed = await this.showToastWithButton(
                "Please jog the nozzle tip to be perfectly centered on and touching the fiducial.", 'Continue', true
            );
            if (!proceed) {
                // Nozzle is currently down near the fiducial - lift it back to
                // a safe travel height before bailing out, same as the normal
                // completion path does further down.
                await this.lumen.serial.send([`G0 Z${this.travelHeight}`]);
                return;
            }

            const nozPos = await this.lumen.grabBoardPosition();

            await this.lumen.serial.send([`G0 Z${this.travelHeight}`]);

            board.tipXoffset = nozPos[0] - camPos[0];
            board.tipYoffset = nozPos[1] - camPos[1];

            this.updateOffsetDisplay();
        } finally {
            this._boardFlowActive = false;
        }
    }

    async performFiducialCalibration(){
        if (this.warnIfBoardFlowActive()) return;

        // lots of checks first
        if(this.fiducials.length !== 3){
            console.error("No fids in this job, cannot perform fiducial calibration.");
            return;
        }

        // Pinned to whichever board is active right now, for the whole flow
        // - see the big comment on this._boardFlowActive in the constructor
        // (and findBoardRoughPosition(), which has the same shape of fix).
        const board = this.activeBoard;
        this._boardFlowActive = true;

        try {
            let fidActual = [];
            // go through and capture the actual positions of the fids
            // then we can perform the transformation

            for(let i = 0; i < board.fiducials.length; i++){
                const fid = board.fiducials[i];
                console.log(`Processing fiducial ${i + 1}:`, fid)
                console.log("jogging to fid: ", fid.searchX, fid.searchY)

                try {

                    await this.lumen.serial.goTo(fid.searchX, fid.searchY);
                    await new Promise(resolve => setTimeout(resolve, 1500));


                    await this.lumen.jogToFiducial();
                    await new Promise(resolve => setTimeout(resolve, 1500));

                    await this.lumen.jogToFiducial();
                    await new Promise(resolve => setTimeout(resolve, 1500));

                    const fidReal = await this.lumen.grabBoardPosition();

                    console.log(`Fiducial ${i + 1} final position:`, fidReal);
                    fidActual.push([parseFloat(fidReal[0]), parseFloat(fidReal[1])])

                    fid.calX = fidReal[0];
                    fid.calY = fidReal[1];

                } catch (error) {
                    console.error(`Error processing fiducial ${i + 1}:`, error);
                    throw error;
                }
            }

            console.log("All fiducials processed, transforming placements...");
            this.transformPlacements(fidActual, board);

            // fid cal only ever jogs X/Y - it doesn't touch Z, so the fiducials'
            // own heights are still whatever findBoardRoughPosition() (or a
            // manual edit) set them to. Re-fitting here just carries that Z
            // plane forward onto the now camera-precise calX/calY basis instead
            // of the rougher jogged-position one it was fit against before.
            this.applyFiducialZTransform(board);

            console.log("fid cal complete: ", board.fiducials);

            this.loadJobIntoPositionList();
            // board.fidCalMatrix (just set by transformPlacements() above) is
            // what drawJobToCanvas() now uses to draw this board at its true
            // calibrated position/rotation (see PLATE_ORIGIN_MACHINE_MM) -
            // redraw now so that shows up immediately instead of waiting for
            // some unrelated interaction to trigger the next one.
            this.drawJobToCanvas();
        } finally {
            this._boardFlowActive = false;
        }
    }


    // Renders the Job Positions list, grouped Type > Component > pad when
    // placements carry component info (see loadGerberFiles()), so a big
    // gerber-imported board doesn't just dump hundreds of individual pads in
    // one flat list. Placements without a refdes (manually captured points,
    // or a job imported without component attributes) render as plain
    // standalone rows, same as before this grouping existed.
    loadJobIntoPositionList(){
        this.renderBoardTabs();
        this.renderPasteVolumeSummary();

        const positionsList = document.querySelector('.positions-list');
        positionsList.innerHTML = '';

        // type -> refdes -> points[], built fresh each render from
        // this.placements (the single source of truth) rather than kept as
        // separate parallel state that could drift out of sync.
        const byType = new Map();
        const loose = [];

        for (const point of this.placements) {
            if (!point.refdes) { loose.push(point); continue; }
            const type = point.componentType || 'other';
            if (!byType.has(type)) byType.set(type, new Map());
            const byRefdes = byType.get(type);
            if (!byRefdes.has(point.refdes)) byRefdes.set(point.refdes, []);
            byRefdes.get(point.refdes).push(point);
        }

        for (const type of COMPONENT_TYPE_ORDER) {
            const byRefdes = byType.get(type);
            if (byRefdes && byRefdes.size > 0) {
                this.renderComponentTypeGroup(positionsList, type, byRefdes);
            }
        }

        for (const point of loose) {
            this.createPositionElement(point, false, positionsList);
        }

        for (let fiducial of this.fiducials) {
            this.createPositionElement(fiducial, true, positionsList);
        }
    }

    // Tab strip above the Job Positions list, one per pasted board (see
    // this.boards) plus a "+" to paste another. "Import Gerber" always
    // populates whichever tab is active; switching tabs (switchToBoard())
    // only changes which board's list/fid-cal controls show here - the
    // point-viz canvas already draws every board regardless of which tab is
    // open (see drawJobToCanvas()), so zooming out still shows all of them.
    renderBoardTabs(){
        const container = document.querySelector('.board-tabs-container');
        if (!container) return;
        container.innerHTML = '';

        this.boards.forEach((board, index) => {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'board-tab' + (index === this.activeBoardIndex ? ' active' : '');
            tab.innerHTML = `
                <span class="board-tab-label">${board.name}</span>
                ${this.boards.length > 1 ? '<span class="board-tab-close" title="Remove this board">×</span>' : ''}
            `;

            tab.addEventListener('click', () => this.switchToBoard(index));

            const closeBtn = tab.querySelector('.board-tab-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.removeBoard(index);
                });
            }

            container.appendChild(tab);
        });

        const addTab = document.createElement('button');
        addTab.type = 'button';
        addTab.className = 'board-tab-add';
        addTab.title = 'Paste another board';
        addTab.textContent = '+';
        addTab.addEventListener('click', () => this.addBoard());
        container.appendChild(addTab);
    }

    // Total estimated paste volume line above the Job Positions list, for
    // whichever board tab is active - only counts currently-enabled points,
    // since a disabled pad/component/type won't actually dispense on a run.
    // No-ops quietly if the summary element isn't in the DOM (e.g. an older
    // cached index.html mid-deploy).
    renderPasteVolumeSummary(){
        const el = document.getElementById('pasteVolumeSummary');
        if (!el) return;

        const enabledPoints = this.placements.filter(p => p.enabled !== false);
        if (enabledPoints.length === 0) {
            el.textContent = '';
            return;
        }

        const totalMm3 = this.totalPasteVolumeMm3(enabledPoints);
        const knownCount = enabledPoints.filter(p => p.padAreaMm2 != null).length;
        const caveat = knownCount < enabledPoints.length
            ? ` (${enabledPoints.length - knownCount} manual point${enabledPoints.length - knownCount === 1 ? '' : 's'} not counted - no known pad size)`
            : '';

        el.textContent = `Estimated paste for this board: ${formatVolumeMm3(totalMm3)} at ${this.stencilThicknessMm}mm stencil equivalent${caveat}`;
    }

    // A collapsible "Resistors" / "Capacitors" / "ICs" / "Other" section, with
    // a checkbox that enables/disables every pad in every component under it
    // (so a whole part type can be skipped for a run) and, when expanded, one
    // collapsible sub-group per component (see renderComponentGroup).
    renderComponentTypeGroup(container, type, byRefdes){
        const allPoints = [...byRefdes.values()].flat();
        const totalPads = allPoints.length;
        const allEnabled = allPoints.every(p => p.enabled !== false);
        const anyEnabled = allPoints.some(p => p.enabled !== false);
        const expanded = this.expandedTypes.has(type);
        const typeVolume = formatVolumeMm3(this.totalPasteVolumeMm3(allPoints));

        const header = document.createElement('div');
        header.className = 'component-type-header';
        header.innerHTML = `
            <span class="group-chevron">${expanded ? '▾' : '▸'}</span>
            <input type="checkbox" class="group-enable-toggle" ${allEnabled ? 'checked' : ''}>
            <span class="group-label">${COMPONENT_TYPE_LABELS[type] || type}</span>
            <span class="group-count">${byRefdes.size} part${byRefdes.size === 1 ? '' : 's'} · ${totalPads} pad${totalPads === 1 ? '' : 's'}${typeVolume ? ` · ${typeVolume}` : ''}</span>
        `;

        const toggle = header.querySelector('.group-enable-toggle');
        toggle.indeterminate = !allEnabled && anyEnabled;
        toggle.addEventListener('click', (e) => e.stopPropagation());
        toggle.addEventListener('change', (e) => {
            for (const p of allPoints) p.enabled = e.target.checked;
            this.loadJobIntoPositionList();
            this.drawJobToCanvas();
        });

        header.addEventListener('click', () => {
            if (expanded) this.expandedTypes.delete(type); else this.expandedTypes.add(type);
            this.loadJobIntoPositionList();
        });

        container.appendChild(header);
        if (!expanded) return;

        // byRefdes was built by iterating this.placements, which is already in
        // component order (see groupPadsByComponent() in gerberImport.js), so
        // insertion order here is already the right display order.
        for (const [refdes, points] of byRefdes) {
            this.renderComponentGroup(container, refdes, points);
        }
    }

    // A collapsible single-component (e.g. "R12") sub-group: a checkbox that
    // enables/disables all of that component's pads, action buttons that
    // mirror a single pad row's move/dispense/remove (but for every pad in
    // the component at once - see moveToComponent/dispenseComponent/
    // removeComponent), and, when expanded, the individual pad rows (each
    // with its own "paste this pad only" action - see createPositionElement -
    // for retrying just one failed pad).
    renderComponentGroup(container, refdes, points){
        const allEnabled = points.every(p => p.enabled !== false);
        const anyEnabled = points.some(p => p.enabled !== false);
        const expanded = this.expandedComponents.has(refdes);

        // Which dot-placement patterns this component's pads actually use
        // (see planPadDispense() in gerberImport.js) - drives both the badge
        // pills below and which sections the overrides panel opens with
        // highlighted (see renderComponentOverridesPanel()). 'dot' is the
        // plain/default case and isn't worth a badge - only the patterns
        // with their own tunable mechanics are.
        const patterns = new Set(points.map(p => p.dispensePattern).filter(p => p && p !== 'dot'));
        const patternBadges = [...patterns].map(p =>
            `<span class="pattern-badge pattern-${p}">${p}</span>`
        ).join('');
        const hasOverride = this.componentOverrides.has(refdes);
        const componentVolume = formatVolumeMm3(this.totalPasteVolumeMm3(points));

        const header = document.createElement('div');
        header.className = 'component-header';
        header.innerHTML = `
            <span class="group-chevron">${expanded ? '▾' : '▸'}</span>
            <input type="checkbox" class="group-enable-toggle" ${allEnabled ? 'checked' : ''}>
            <span class="group-label">${refdes}</span>
            ${patternBadges}
            <span class="group-count">${points.length} pad${points.length === 1 ? '' : 's'}${componentVolume ? ` · ${componentVolume}` : ''}</span>
            <div class="group-actions">
                <button class="overrides-btn${hasOverride ? ' active' : ''}" title="Per-component dispense overrides">⚙</button>
                <button class="move-btn" title="Jog to this component">☉</button>
                <button class="dispense-btn" title="Paste this whole component">⤓</button>
                <button class="remove-btn" title="Remove this whole component">X</button>
            </div>
        `;

        const toggle = header.querySelector('.group-enable-toggle');
        toggle.indeterminate = !allEnabled && anyEnabled;
        toggle.addEventListener('click', (e) => e.stopPropagation());
        toggle.addEventListener('change', (e) => {
            for (const p of points) p.enabled = e.target.checked;
            this.loadJobIntoPositionList();
            this.drawJobToCanvas();
        });

        const overridesBtn = header.querySelector('.overrides-btn');
        overridesBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.expandedOverrides.has(refdes)) this.expandedOverrides.delete(refdes); else this.expandedOverrides.add(refdes);
            this.loadJobIntoPositionList();
        });

        const moveBtn = header.querySelector('.move-btn');
        moveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.moveToComponent(points);
        });

        const dispenseBtn = header.querySelector('.dispense-btn');
        dispenseBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            dispenseBtn.disabled = true;
            try {
                await this.dispenseComponent(points);
            } finally {
                dispenseBtn.disabled = false;
            }
        });

        const removeBtn = header.querySelector('.remove-btn');
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeComponent(refdes);
        });

        header.addEventListener('click', () => {
            if (expanded) this.expandedComponents.delete(refdes); else this.expandedComponents.add(refdes);
            this.loadJobIntoPositionList();
        });

        container.appendChild(header);

        // Independent of the pad-list expand/collapse above - you shouldn't
        // have to open every pad row just to see or edit this component's
        // overrides.
        if (this.expandedOverrides.has(refdes)) {
            this.renderComponentOverridesPanel(container, refdes, patterns);
        }

        if (!expanded) return;

        const padList = document.createElement('div');
        padList.className = 'component-pads';
        container.appendChild(padList);

        for (const point of points) {
            this.createPositionElement(point, false, padList);
        }
    }

    // The per-component override editor opened by a component's ⚙ button
    // (see renderComponentGroup()). Shows every Line/Grid/Staggered
    // "mechanics" field (dot pitch, edge inset, volume multipliers, stagger
    // spacing - see resolveMechanicsSettings() in gerberImport.js), each with
    // its own enable checkbox: unchecked means "inherit the board-wide
    // Advanced Settings value" (shown, disabled, so you can see what you'd be
    // overriding); checked lets you type a value that applies to only this
    // component's pads. `patterns` (the set this component's pads actually
    // use, from renderComponentGroup) highlights the sections that matter
    // right now - the others still work, since a future settings change or
    // re-import could reclassify a pad into them.
    renderComponentOverridesPanel(container, refdes, patterns){
        const overrides = this.componentOverrides.get(refdes) || {};
        const globals = getPasteDispenseSettings();

        const fieldGroups = [
            { title: 'Line', pattern: 'line', fields: [
                { key: 'dotPitchMm', label: 'Dot Pitch (mm)', step: 0.05 },
                { key: 'padEdgeInsetMm', label: 'Pad Edge Inset (mm)', step: 0.05 },
                { key: 'elongatedVolumeMultiplier', label: 'Volume Multiplier', step: 0.05 },
            ] },
            { title: 'Grid', pattern: 'grid', fields: [
                { key: 'gridDotPitchMm', label: 'Grid Dot Pitch (mm)', step: 0.05 },
                { key: 'gridEdgeInsetMm', label: 'Grid Edge Inset (mm)', step: 0.05 },
            ] },
            { title: 'Staggered', pattern: 'staggered', fields: [
                { key: 'staggerOffsetFraction', label: 'Stagger Spacing', step: 0.05 },
                { key: 'tightPitchVolumeMultiplier', label: 'Volume Multiplier', step: 0.05 },
            ] },
        ];

        const panel = document.createElement('div');
        panel.className = 'component-overrides-panel';

        const note = document.createElement('p');
        note.className = 'overrides-note';
        note.textContent = patterns.size > 0
            ? `Overrides apply only to ${refdes}'s own pads - everything else keeps using the board-wide Advanced Settings tabs.`
            : `${refdes} isn't currently using any of these patterns, but an override here still takes effect if a settings change or re-import puts it into one.`;
        panel.appendChild(note);

        for (const group of fieldGroups) {
            const groupDiv = document.createElement('div');
            groupDiv.className = 'override-field-group' + (patterns.has(group.pattern) ? ' active-pattern' : '');

            const heading = document.createElement('div');
            heading.className = 'override-group-title';
            heading.textContent = group.title;
            groupDiv.appendChild(heading);

            for (const field of group.fields) {
                const hasOverride = Object.prototype.hasOwnProperty.call(overrides, field.key);
                const value = hasOverride ? overrides[field.key] : globals[field.key];

                const row = document.createElement('label');
                row.className = 'override-field-row';
                row.innerHTML = `
                    <input type="checkbox" class="override-enable" ${hasOverride ? 'checked' : ''}>
                    <span class="override-field-label">${field.label}</span>
                    <input type="number" class="override-value" step="${field.step}" value="${value}" ${hasOverride ? '' : 'disabled'}>
                `;

                const enableBox = row.querySelector('.override-enable');
                const valueBox = row.querySelector('.override-value');

                const applyOverride = () => {
                    const current = { ...(this.componentOverrides.get(refdes) || {}) };
                    if (enableBox.checked) {
                        current[field.key] = parseFloat(valueBox.value);
                    } else {
                        delete current[field.key];
                    }
                    if (Object.keys(current).length > 0) this.componentOverrides.set(refdes, current);
                    else this.componentOverrides.delete(refdes);
                    this.recomputeDispensePattern();
                };

                enableBox.addEventListener('change', () => {
                    valueBox.disabled = !enableBox.checked;
                    if (!enableBox.checked) valueBox.value = globals[field.key];
                    applyOverride();
                });
                valueBox.addEventListener('change', () => {
                    if (enableBox.checked) applyOverride();
                });

                groupDiv.appendChild(row);
            }

            panel.appendChild(groupDiv);
        }

        container.appendChild(panel);
    }

    handleFiducialSelectionClick(event){
        const rect = this.jobCanvas.getBoundingClientRect();
        const clickX = (event.clientX - rect.left);
        const clickY = (event.clientY - rect.top);

        let closestPoint = this.returnClosestFidFromClickCoordinates(clickX, clickY);

        if (closestPoint) {
            ctx.beginPath();
            ctx.arc(closestPoint.canvasX, rect.height - closestPoint.canvasY, 6, 0, Math.PI * 2);
            ctx.fill();

            //store in buffer
            this.clickedFidBuffer.push(closestPoint);

            // Move to next fiducial or close modal
            currentFidIndex++;
            if (currentFidIndex < 3) {
                updateModalForFid();
            } else {
                // All fids captured, close modal
                modal.style.display = 'none';
                overlay.style.display = 'none';

                //moving clicked fids into this.fiducials
                this.fiducials = this.clickedFidBuffer;
                //wiping buffer
                this.clickedFidBuffer = [];

                console.log(this.fiducials);

                //removing event listener
                canvas.removeEventListener('click', this.handleFiducialSelectionClick)

            }
        }
    }

    async captureNewPosition() {
        console.log('Job capture method called');
        if (!this.lumen.serial) {
            console.error('Serial manager not set');
            return;
        }

        //TODO move almost all of this to lumen

        console.log('Serial manager is set, proceeding with capture');

        this.lumen.serial.clearInspectBuffer();
        console.log('Inspect buffer cleared');

        await this.lumen.serial.send(["G92"]);
        console.log('G92 command sent');

        const pattern = /X:(.*?) Y:(.*?) Z:(.*?) A:(.*?) B:(.*?) /;
        const re = new RegExp(pattern, 'i');

        console.log("Serial inspect buffer contents:", this.lumen.serial.inspectBuffer);

        for (var i = 0; i < this.lumen.serial.inspectBuffer.length; i++) {
            let currLine = this.lumen.serial.inspectBuffer[i];
            console.log('Checking line:', currLine);

            let result = re.test(currLine);
            console.log('Regex test result:', result);

            if(result) {
                const matches = re.exec(currLine);
                console.log('Position matches:', matches);
                this.addPoint(
                    parseFloat(matches[1]),
                    parseFloat(matches[2]),
                    parseFloat(matches[3])
                );
                console.log('Point added to job');

                this.loadJobIntoPositionList();
                return;
            }
        }
        console.log('No valid position found in inspect buffer');
    }

    addPoint(x, y, z) {
        let newPoint = new Point(x, y, z)
        this.placements.push(newPoint);
    }


    async importFromFile(file) {
        try {
            const jsonString = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = (error) => reject(error);
                reader.readAsText(file);
            });

            const data = JSON.parse(jsonString);

            // Multi-board job files carry a "boards" array (one tab each -
            // see this.boards/deserializeBoard()); an older single-board job
            // file has none, so its top-level placements/fiducials/etc get
            // wrapped into one board instead, the same shape either way.
            if (Array.isArray(data.boards) && data.boards.length > 0) {
                this.boards = data.boards.map((boardData, index) => this.deserializeBoard(boardData, index));
                const restoredIndex = Number(data.activeBoardIndex);
                this.activeBoardIndex = Number.isInteger(restoredIndex)
                    ? Math.min(Math.max(restoredIndex, 0), this.boards.length - 1)
                    : 0;

                // Backward compat: a multi-board file saved before tip/Z
                // offset became per-board data only ever had ONE offset for
                // the whole job, at this top level - deserializeBoard()
                // already picks this up for the legacy single-board shape
                // (where `data` IS the board), but a multi-board file's
                // per-board boardData objects never had these fields at all,
                // so seed every board with the old job-wide value here
                // instead, matching how it actually behaved before (the same
                // offset applied no matter which board you were pasting).
                if (typeof data.tipXoffset !== 'undefined' || typeof data.tipYoffset !== 'undefined' || typeof data.zOffset !== 'undefined') {
                    for (const board of this.boards) {
                        if (typeof data.tipXoffset !== 'undefined') board.tipXoffset = data.tipXoffset;
                        if (typeof data.tipYoffset !== 'undefined') board.tipYoffset = data.tipYoffset;
                        if (typeof data.zOffset !== 'undefined') board.zOffset = data.zOffset;
                    }
                }
            } else {
                this.boards = [this.deserializeBoard(data, 0)];
                this.activeBoardIndex = 0;
            }
            this.expandedOverrides = new Set();

            this.showPadOverlay = data.showPadOverlay || false;
            this.showMaskPadOverlay = data.showMaskPadOverlay || false;

            // Restores the Advanced Settings tab's paste-dispense pattern
            // tuning that produced this job's placements, if the file has it
            // (older job files won't - setPasteDispenseSettings() leaves
            // anything missing at its current/default value).
            if (data.pasteDispenseSettings) setPasteDispenseSettings(data.pasteDispenseSettings);

            this.dispenseDegrees = data.dispenseDegrees || 55.1;
            this.dispenseMultiplier = typeof data.dispenseMultiplier !== 'undefined' ? data.dispenseMultiplier : 1;
            this.stencilThicknessMm = typeof data.stencilThicknessMm !== 'undefined' ? data.stencilThicknessMm : DEFAULT_JOB_STENCIL_THICKNESS_MM;
            this.nozzleGauge = typeof data.nozzleGauge !== 'undefined' ? data.nozzleGauge : DEFAULT_NOZZLE_GAUGE;
            this.retractionDegrees = typeof data.retractionDegrees !== 'undefined' ? data.retractionDegrees : 1;
            this.dwellMilliseconds = typeof data.dwellMilliseconds !== 'undefined' ? data.dwellMilliseconds : 100;
            this.motionSpeed = data.motionSpeed || 35000;
            this.extruderSpeed = data.extruderSpeed || 100000;
            this.vacuumPressure = typeof data.vacuumPressure !== 'undefined' ? data.vacuumPressure : 100;
            this.motorCurrent = typeof data.motorCurrent !== 'undefined' ? data.motorCurrent : 450;
            this.travelHeight = typeof data.travelHeight !== 'undefined' ? data.travelHeight : 31.5;
            this.preGcode = data.preGcode || "";
            this.postGcode = data.postGcode || "";
            this.invertDispense = data.invertDispense || false;
            this.buildPlateId = (BUILD_PLATES[data.buildPlateId] || data.buildPlateId === 'custom') ? data.buildPlateId : DEFAULT_BUILD_PLATE;
            this.customBuildPlateWidthMm = typeof data.customBuildPlateWidthMm !== 'undefined' ? data.customBuildPlateWidthMm : 390;
            this.customBuildPlateHeightMm = typeof data.customBuildPlateHeightMm !== 'undefined' ? data.customBuildPlateHeightMm : 240;
            this.customBuildPlateOriginXMm = typeof data.customBuildPlateOriginXMm !== 'undefined' ? data.customBuildPlateOriginXMm : PLATE_ORIGIN_MACHINE_MM.x;
            this.customBuildPlateOriginYMm = typeof data.customBuildPlateOriginYMm !== 'undefined' ? data.customBuildPlateOriginYMm : PLATE_ORIGIN_MACHINE_MM.y;
            this.homedZHeightMm = typeof data.homedZHeightMm !== 'undefined' ? data.homedZHeightMm : 31.5;
            this.maxTravelXMm = typeof data.maxTravelXMm !== 'undefined' ? data.maxTravelXMm : 400;
            this.maxTravelYMm = typeof data.maxTravelYMm !== 'undefined' ? data.maxTravelYMm : 330;
            const buildPlateSelect = document.getElementById('buildPlateSelect');
            if (buildPlateSelect) buildPlateSelect.value = this.buildPlateId;
            const customBuildPlateInputs = document.getElementById('customBuildPlateInputs');
            if (customBuildPlateInputs) customBuildPlateInputs.hidden = this.buildPlateId !== 'custom';
            const customBuildPlateWidthMm = document.getElementById('customBuildPlateWidthMm');
            if (customBuildPlateWidthMm) customBuildPlateWidthMm.value = this.customBuildPlateWidthMm;
            const customBuildPlateHeightMm = document.getElementById('customBuildPlateHeightMm');
            if (customBuildPlateHeightMm) customBuildPlateHeightMm.value = this.customBuildPlateHeightMm;
            const customBuildPlateOriginXMm = document.getElementById('customBuildPlateOriginXMm');
            if (customBuildPlateOriginXMm) customBuildPlateOriginXMm.value = this.customBuildPlateOriginXMm;
            const customBuildPlateOriginYMm = document.getElementById('customBuildPlateOriginYMm');
            if (customBuildPlateOriginYMm) customBuildPlateOriginYMm.value = this.customBuildPlateOriginYMm;
            const jobHomedZHeight = document.getElementById('jobHomedZHeight');
            if (jobHomedZHeight) jobHomedZHeight.value = this.homedZHeightMm;
            const jobMaxTravelX = document.getElementById('jobMaxTravelX');
            if (jobMaxTravelX) jobMaxTravelX.value = this.maxTravelXMm;
            const jobMaxTravelY = document.getElementById('jobMaxTravelY');
            if (jobMaxTravelY) jobMaxTravelY.value = this.maxTravelYMm;
            this.offCenterCam = data.offCenterCam === true;
            const offCenterCamToggle = document.getElementById('offCenterCamToggle');
            if (offCenterCamToggle) offCenterCamToggle.checked = this.offCenterCam;

            // ui update
            const jobDispenseMultiplier = document.getElementById('jobDispenseMultiplier');
            const jobRetractionDeg = document.getElementById('jobRetractionDeg');
            const jobDwellMs = document.getElementById('jobDwellMs');
            const jobMotionSpeed = document.getElementById('jobMotionSpeed');
            const jobExtruderSpeed = document.getElementById('jobExtruderSpeed');
            const jobVacuumPressure = document.getElementById('jobVacuumPressure');
            const jobVacuumPressureValue = document.getElementById('jobVacuumPressureValue');
            const jobMotorCurrent = document.getElementById('jobMotorCurrent');
            const jobTravelHeight = document.getElementById('jobTravelHeight');
            const jobPreGcode = document.getElementById('jobPreGcode');
            const jobPostGcode = document.getElementById('jobPostGcode');
            const jobInvertDispense = document.getElementById('jobInvertDispense');

            if (jobDispenseMultiplier) jobDispenseMultiplier.value = this.dispenseMultiplier;

            const jobStencilThicknessMm = document.getElementById('jobStencilThicknessMm');
            const jobStencilThicknessPreset = document.getElementById('jobStencilThicknessPreset');
            if (jobStencilThicknessPreset) {
                const hasOption = [...jobStencilThicknessPreset.options].some(o => o.value !== 'custom' && Number(o.value) === this.stencilThicknessMm);
                jobStencilThicknessPreset.value = hasOption ? String(this.stencilThicknessMm) : 'custom';
                if (jobStencilThicknessMm) jobStencilThicknessMm.hidden = hasOption;
            }
            if (jobStencilThicknessMm) jobStencilThicknessMm.value = this.stencilThicknessMm;

            const jobNozzleGaugePreset = document.getElementById('jobNozzleGaugePreset');
            if (jobNozzleGaugePreset) jobNozzleGaugePreset.value = this.nozzleGauge;
            if (jobRetractionDeg) jobRetractionDeg.value = this.retractionDegrees;
            if (jobDwellMs) jobDwellMs.value = this.dwellMilliseconds;
            if (jobMotionSpeed) jobMotionSpeed.value = this.motionSpeed;
            if (jobExtruderSpeed) jobExtruderSpeed.value = this.extruderSpeed;
            if (jobVacuumPressure) jobVacuumPressure.value = this.vacuumPressure;
            if (jobVacuumPressureValue) jobVacuumPressureValue.textContent = this.vacuumPressure;
            if (jobMotorCurrent) jobMotorCurrent.value = this.motorCurrent;
            if (jobTravelHeight) jobTravelHeight.value = this.travelHeight;
            if (jobPreGcode) jobPreGcode.value = this.preGcode;
            if (jobPostGcode) jobPostGcode.value = this.postGcode;
            if (jobInvertDispense) jobInvertDispense.checked = this.invertDispense;
            this.updateOffsetDisplay();

            const togglePadsButton = document.getElementById('vizTogglePads');
            togglePadsButton?.classList.toggle('active', this.showPadOverlay);
            const toggleMaskPadsButton = document.getElementById('vizToggleMaskPads');
            toggleMaskPadsButton?.classList.toggle('active', this.showMaskPadOverlay);

            // Reflect whatever paste-dispense settings ended up active (either
            // restored above, or left at their current value) in the
            // Advanced Settings tab's inputs.
            const pasteSettingsUi = {
                advElongatedAspectRatio: 'elongatedAspectRatio',
                advElongatedMinLengthMm: 'elongatedMinLengthMm',
                advMinLineWidthMm: 'minLineWidthMm',
                advDotPitchMm: 'dotPitchMm',
                advPadEdgeInsetMm: 'padEdgeInsetMm',
                advElongatedVolumeMultiplier: 'elongatedVolumeMultiplier',
                advPowerPadMinAreaMm2: 'powerPadMinAreaMm2',
                advGridDotPitchMm: 'gridDotPitchMm',
                advGridEdgeInsetMm: 'gridEdgeInsetMm',
                advTightPitchGapMm: 'tightPitchGapMm',
                advTightPitchMaxPadWidthMm: 'tightPitchMaxPadWidthMm',
                advStaggerOffsetFraction: 'staggerOffsetFraction',
                advTightPitchVolumeMultiplier: 'tightPitchVolumeMultiplier',
            };
            const pasteSettings = getPasteDispenseSettings();
            for (const [elementId, key] of Object.entries(pasteSettingsUi)) {
                const el = document.getElementById(elementId);
                if (el) el.value = pasteSettings[key];
            }

            // Update the UI position list
            this.loadJobIntoPositionList();

            this.drawJobToCanvas();

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message || error.toString() };
        }
    }



    async saveToFile() {
        const jsonData = this.export();
        const blob = new Blob([jsonData], { type: 'application/json' });

        if (typeof window.showSaveFilePicker === 'function') {
            const handle = await window.showSaveFilePicker({
                suggestedName: 'job.json',
                types: [{
                    description: 'JSON Files',
                    accept: {
                        'application/json': ['.json']
                    }
                }]
            });

            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return;
        }

        // Fallback for browsers without the File System Access API
        // (e.g. Firefox, Safari) - trigger a normal download instead.
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'job.json';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    createPositionElement(position, isFiducial, container = document.querySelector('.positions-list')) {
        const newDiv = document.createElement('div');
        newDiv.className = 'position-item';
        if (!isFiducial && position.enabled === false) newDiv.classList.add('disabled');

        let writtenX, writtenY;

        if(position.calX != null & position.calY != null){
            writtenX = position.calX;
            writtenY = position.calY;
        }
        else if(position.searchX != null & position.searchY != null){
            writtenX = position.searchX;
            writtenY = position.searchY;
        }
        else{
            writtenX = position.x;
            writtenY = position.y;
        }

        // Non-fiducial rows get a "paste this pad only" action - for
        // manually re-dispensing a single pad (e.g. one that failed to wet)
        // without re-running the whole job.
        const dispenseButton = isFiducial ? '' : '<button class="dispense-btn" title="Paste this pad only">⤓</button>';

        // ...and a "run job starting from here" action - for resuming a
        // cancelled/failed run at a specific pad rather than wherever it
        // happened to stop (see run()'s startAtPoint), or just re-pasting
        // one board's tail end without repasting everything before it.
        const runFromHereButton = isFiducial ? '' : '<button class="run-from-here-btn" title="Run the job starting from this pad">▶</button>';

        // Per-pad enable/disable - lets you skip just this one dot on a run
        // without disabling its whole component. Deliberately not preserved
        // through recomputeDispensePattern() beyond the whole-component state
        // it already carries (see there) - a settings change can change how
        // many dots a pad even has, so there's no stable dot-to-dot mapping to
        // carry a single dot's own flag across.
        const enableToggle = isFiducial ? '' : `<input type="checkbox" class="pad-enable-toggle" title="Paste this pad on a run" ${position.enabled !== false ? 'checked' : ''}>`;

        // Per-pad pattern indicator - 'dot' is the plain/default case and
        // isn't worth a badge (see renderComponentGroup()'s matching
        // component-level badges).
        const patternBadge = (!isFiducial && position.dispensePattern && position.dispensePattern !== 'dot')
            ? `<span class="pattern-badge pattern-${position.dispensePattern}">${position.dispensePattern}</span>`
            : '';

        // Per-dot estimated paste volume (see Job.pointPasteVolumeMm3()) -
        // absent for fiducials and manually captured points, which have no
        // known pad geometry to base an estimate on.
        const volumeMm3 = isFiducial ? null : this.pointPasteVolumeMm3(position);
        const volumeBadge = volumeMm3 != null
            ? `<span class="pattern-badge volume-badge" title="Estimated paste volume for this dot, at ${this.stencilThicknessMm}mm stencil equivalent">${formatVolumeMm3(volumeMm3)}</span>`
            : '';

        if(isFiducial){
            newDiv.innerHTML = `
            <span class="position-text">Fiducial:</span>
            <span class="fid-coord-group">
                <label>X:<input type="number" class="fid-coord-input" data-axis="x" step="0.01" value="${writtenX}"></label>
                <label>Y:<input type="number" class="fid-coord-input" data-axis="y" step="0.01" value="${writtenY}"></label>
                <label>Z:<input type="number" class="fid-coord-input" data-axis="z" step="0.01" value="${position.z}" title="This fiducial's own measured board height - nudge it if this side/corner of the board sits higher or lower than the others."></label>
            </span>
            <div class="button-group">
                <button class="move-btn">☉</button>
                <button class="remove-btn">X</button>
            </div>
        `;

            // Editing X/Y sets this fiducial's REAL (calibrated) position -
            // the same field a fid-cal run itself would set - so a manual
            // correction here has the same effect as re-jogging: once all
            // three fiducials have one, it feeds straight into the same
            // affine-transform math transformPlacements() already uses,
            // updating every placement's calX/calY immediately. Editing Z
            // sets this fiducial's own height, which feeds the same way into
            // applyFiducialZTransform()'s plane fit - a board that's higher
            // on one side can be dialed in by nudging that side's fiducial(s)
            // up, instead of every placement sharing one flat Z.
            for (const input of newDiv.querySelectorAll('.fid-coord-input')) {
                input.addEventListener('click', (e) => e.stopPropagation());
                input.addEventListener('change', (e) => {
                    e.stopPropagation();
                    const value = parseFloat(input.value);
                    if (Number.isNaN(value)) return;

                    const axis = input.dataset.axis;
                    if (axis === 'z') position.z = value;
                    else if (axis === 'x') position.calX = value;
                    else position.calY = value;

                    this.recalibrateFromFiducialEdit();
                });
            }
        }
        else{
            newDiv.innerHTML = `
            ${enableToggle}
            <span class="position-text">Position: X:${writtenX} Y:${writtenY} Z:${position.z}</span>
            ${patternBadge}
            ${volumeBadge}
            <div class="button-group">
                <button class="move-btn">☉</button>
                ${dispenseButton}
                ${runFromHereButton}
                <button class="remove-btn">X</button>
            </div>
        `;
        }

        // Add click handler for the per-pad enable/disable checkbox
        const padEnableToggle = newDiv.querySelector('.pad-enable-toggle');
        if (padEnableToggle) {
            padEnableToggle.addEventListener('change', (e) => {
                position.enabled = e.target.checked;
                this.loadJobIntoPositionList();
                this.drawJobToCanvas();
            });
        }

        // Add click handler for Move To button
        newDiv.querySelector('.move-btn').addEventListener('click', () => {

            let writtenX, writtenY;

            if(position.calX != null & position.calY != null){
                writtenX = position.calX;
                writtenY = position.calY;
            }
            else{
                writtenX = position.x;
                writtenY = position.y;
            }

            this.lumen.serial.send([
                "G90",  // Set absolute positioning
                `G0 Z${this.travelHeight}`,
                `G0 X${writtenX} Y${writtenY}`  // Move to position
            ]);
        });

        // Add click handler for the single-pad "paste this pad only" button
        const dispenseBtn = newDiv.querySelector('.dispense-btn');
        if (dispenseBtn) {
            dispenseBtn.addEventListener('click', async () => {
                dispenseBtn.disabled = true;
                try {
                    await this.dispenseSinglePoint(position);
                } finally {
                    dispenseBtn.disabled = false;
                }
            });
        }

        const runFromHereBtn = newDiv.querySelector('.run-from-here-btn');
        if (runFromHereBtn) {
            runFromHereBtn.addEventListener('click', () => {
                this.run(position);
            });
        }

        // Add click handler for Remove button
        newDiv.querySelector('.remove-btn').addEventListener('click', () => {
            newDiv.remove();

            this.placements = this.placements.filter(p =>
                p.x !== position.x || p.y !== position.y || p.z !== position.z
            );

            this.fiducials = this.fiducials.filter(p =>
                p.x !== position.x || p.y !== position.y || p.z !== position.z
            );

            this.loadJobIntoPositionList();
            this.drawJobToCanvas();

            console.log(this.placements)
        });

        container.appendChild(newDiv);
    }

    //TODO reimplement this
    // async capturePosition() {

    //     await this.capture();

    //     const lastPoint = this.getPoint(this.getPointCount() - 1);
    //     console.log('Last captured point:', lastPoint);

    //     if (lastPoint) {

    //         this.createPositionElement([lastPoint.x, lastPoint.y, lastPoint.z]);
    //     }
    // }

    // generates array of commands to send
    // in format serial.send(commands)
    // Builds the move/dispense/wiggle/retract gcode block for one point.
    // Resolves a point's effective machine-space X/Y the same way
    // pointDispenseCommands() does below (calX/calY once fid-cal has run,
    // else the raw design-space x/y) - shared so orderPointsByNozzleLean()'s
    // lean-direction projection lines up with where the point actually gets
    // dispensed, not wherever it sits in the original (possibly rotated)
    // gerber coordinate space.
    effectivePointXY(point){
        return [point.calX ?? point.x, point.calY ?? point.y];
    }

    // A now more-precisely-calibrated tipXoffset/tipYoffset (see
    // performTipCalibration()) already corrects every point's dispensed
    // *position* for however the real nozzle tip leans off the gantry's
    // nominal centerline - but it can't stop that same lean from letting the
    // tip physically brush a neighboring pad it already wet paste on as the
    // gantry travels between one component's own points, which is why this
    // exists. Given a cluster of points that all belong to the same
    // component (see slice()'s caller), reorders them to start from
    // whichever one sits furthest AGAINST the direction the tip leans and
    // work through the rest in order of increasing lean-direction
    // projection, ending on whichever point sits furthest in the direction
    // the tip actually leans - so the tip is always advancing further into
    // its own lean direction as it goes, instead of ending a component by
    // reaching back over already-dispensed points to get there.
    //
    // The lean direction itself is tipXoffset/tipYoffset MINUS
    // NOZZLE_PREDICTED_OFFSET_MM, not the raw calibrated offset - that raw
    // value is dominated by the ~70mm nominal camera-to-nozzle mounting
    // separation (see NOZZLE_PREDICTED_OFFSET_MM), which points the same
    // fixed machine-relative direction on every board regardless of which
    // way any given nozzle is actually bent. Subtracting it out leaves just
    // the real tip's divergence from that nominal geometry - the part that's
    // actually a bend, and the direction this whole feature cares about.
    orderPointsByNozzleLean(points, board){
        if (points.length < 2) return points;

        // Not calibrated yet (still at createEmptyBoard()'s 0/0 default) -
        // checked against the raw offset, not the residual below, since a
        // never-calibrated board would otherwise look like it has a huge
        // "lean" equal to -NOZZLE_PREDICTED_OFFSET_MM.
        if (board.tipXoffset === 0 && board.tipYoffset === 0) return points;

        const lx = board.tipXoffset - NOZZLE_PREDICTED_OFFSET_MM.x;
        const ly = board.tipYoffset - NOZZLE_PREDICTED_OFFSET_MM.y;
        const mag = Math.hypot(lx, ly);
        if (mag === 0) return points; // calibrated exactly to the nominal offset - no measurable bend

        const ux = lx / mag, uy = ly / mag;
        const projection = (point) => {
            const [x, y] = this.effectivePointXY(point);
            return x * ux + y * uy;
        };

        return [...points].sort((a, b) => projection(a) - projection(b));
    }

    // Shared by slice() (the full job) and dispenseSinglePoint() (a manual
    // one-off re-dispense) so they can't drift apart from each other.
    // "{VACUUM}" is substituted with the live air-assist PWM value at send
    // time (see run()) rather than baked in here, so the slider can retune it
    // mid-job.
    //
    // board defaults to the active one (right for dispenseSinglePoint() - a
    // point's re-dispense button only ever exists for the active board's own
    // Job Positions list), but slice() passes each point's OWN board
    // explicitly - a run pastes every board in one go, and tip/Z offset is
    // per-board data (see this.tipXoffset), so a point must use its own
    // board's offset regardless of whichever tab happens to be active when
    // "Run Job" was clicked.
    pointDispenseCommands(point, board = this.activeBoard){
        let x = point.x;
        let y = point.y;

        if(point.calX != null){
            x = point.calX;
        }

        if(point.calY != null){
            y = point.calY;
        }

        const z = point.z + board.zOffset;

        // Gerber-imported points may carry their own pad-size-scaled dispense
        // amount; manually captured points fall back to the global setting.
        const dispenseDeg = point.dispenseDegrees != null ? point.dispenseDegrees : parseFloat(this.dispenseDegrees);

        // Travel to and down onto the pad is identical either way - only how
        // the paste itself gets pushed out differs by hardwareVersion. Each
        // dispense branch below applies this.invertDispense itself, since
        // the two mechanisms don't share a sign convention (see
        // plungerDispenseCommands()).
        const commands = [
            `G0 X${x + board.tipXoffset} Y${y + board.tipYoffset} F${this.motionSpeed}`, // Move over
            `G0 Z${z}`,                                    // Move z down
        ];

        commands.push(...(this.hardwareVersion === 'v1-beta'
            ? this.plungerDispenseCommands(dispenseDeg)
            : this.augerDispenseCommands(dispenseDeg)));

        commands.push(
            "G90",                                          // Absolute mode
            `G0 Z${this.travelHeight} F${this.motionSpeed}`, // Move to safe Z
        );

        return commands;
    }

    // Paste Extruder V2's dispense sequence (the current auger-driven
    // hardware, and the default/only behavior before hardwareVersion
    // existed) - unchanged from before.
    augerDispenseCommands(dispenseDeg){
        // Positive B extrudes on this auger; invert direction if invertDispense is enabled
        const dispenseSign = this.invertDispense ? -1 : 1;

        const commands = [
            "G91",                                         // Relative mode
            "M106 P2 S{VACUUM}",                            // Pump on (speed substituted live at send time)
            "G0 Z-.7",                                      // Come up .9mm
            "M906 B {MOTOR_CURRENT}",                       // Extruder current high (substituted live at send time)
            `G0 B${dispenseSign * dispenseDeg} F${this.extruderSpeed}`, // Extrude paste
            "G0 Z.4",                                       // Come down .7mm
        ];

        // Wiggle the tip up/down to help release paste stuck to the nozzle
        for (let i = 0; i < 4; i++) {
            commands.push("G0 Z-.5", "G0 Z.3");
        }

        return commands;
    }

    // Paste Extruder V1 Beta's original syringe-plunger dispenser - restores
    // the FULL original (pre-auger) paste-utility per-point sequence: pump
    // on, lift slightly, motor current up, extrude, retract, dwell, re-seat,
    // pump off, wiggle - not just the extrude/retract/dwell core an earlier
    // version of this function had, which dropped every physical step
    // around the actual dispense (this mechanism needs the same air-assist/
    // wiggle help releasing paste from the nozzle that the auger does - the
    // plunger and syringe don't make that unnecessary).
    //
    // That original tracked one running absolute B position across the
    // whole job (a single G92 B0, then `G0 B<absolute position>` per point)
    // - mathematically identical to emitting a relative move every time,
    // since each move's net effect is just -dispenseDeg then +retractionDeg
    // (or the reverse, inverted) off wherever B already was. This repo's
    // slice() already does its own single G92 B0 before the run, so
    // reproducing it as G91 relative moves here gets the exact same
    // physical motion while fitting the same per-point, stateless
    // pointDispenseCommands() every hardware profile uses (including
    // dispenseSinglePoint()'s one-off re-dispense, which the original
    // neither had nor needed to support).
    //
    // Two real bugs in the original's own gcode are deliberately NOT
    // reproduced: its extrude line used dwellMs (a millisecond time value)
    // as the extrude AMOUNT instead of dispenseDeg, and its retract amount
    // was hardcoded to 4 instead of ever reading retractionDegrees - between
    // them, every V1 dispense silently ignored both fields the Basic
    // settings tab exposes for this hardware. Pump speed and motor current
    // reuse the same live-tunable {VACUUM}/{MOTOR_CURRENT} substitution
    // augerDispenseCommands() (V2, right above) already uses - substituted
    // by whichever caller sends these (see dispenseSinglePoint()/run()) -
    // instead of the original's hardcoded S120/B1000, so V1 gets the same
    // adjust-while-running quality of life those sliders already give V2.
    // The lift amounts and wiggle count are kept as the original mechanism's
    // own tuned values rather than reused from V2's - the plunger and auger
    // are physically different mechanisms, so there's no reason to assume
    // V2's numbers (a different lift distance, one more wiggle) suit V1 too.
    plungerDispenseCommands(dispenseDeg){
        const retractionDeg = parseFloat(this.retractionDegrees);
        const dwellMs = parseFloat(this.dwellMilliseconds);

        // The original's un-inverted direction extrudes on NEGATIVE B - the
        // opposite of the auger's positive-B convention above. Kept exactly
        // as the original had it rather than renormalized to match.
        const extrudeSign = this.invertDispense ? 1 : -1;

        const commands = [
            "G91",                                     // Relative mode
            "M106 P2 S{VACUUM}",                        // Pump on (speed substituted live at send time)
            "G0 Z-.5",                                  // Come up .5mm
            "M906 B {MOTOR_CURRENT}",                   // Extruder current high (substituted live at send time)
            `G0 B${extrudeSign * dispenseDeg}`,         // Extrude paste
            `G0 B${-extrudeSign * retractionDeg}`,      // Retract a small amount
            `G4 P${dwellMs}`,                           // Dwell so the paste finishes flowing
            "G0 Z.3",                                   // Come down .3mm
            "M107 P2",                                  // Pump off
        ];

        // Wiggle the tip up/down to help release paste stuck to the nozzle -
        // the original plunger sequence did this 3 times (V2's auger sequence,
        // right above, does 4 - kept separate rather than unified).
        for (let i = 0; i < 3; i++) {
            commands.push("G0 Z-.5", "G0 Z.3");
        }

        return commands;
    }

    // Flat, ordered list of every board's every enabled placement, as this
    // job would actually paste it - {board, point} pairs rather than
    // already-generated gcode, so run() can track/resume progress at a
    // per-point granularity (see runQueue there) instead of a per-gcode-line
    // one. slice() below turns this same list into gcode; kept as its own
    // method so run() and slice() can never disagree on point order.
    //
    // Every board pastes in one run, not just whichever tab is currently
    // active in the Job Positions panel - "Run Job" means the whole job.
    buildRunQueue(){
        const queue = [];

        for (const board of this.boards) {
            const enabledPoints = board.placements.filter(point => point.enabled !== false);

            // buildPlacementsFromPadShapes() already emits one component's
            // points as a consecutive run sharing the same refdes - group by
            // that (breaking the run at every refdes change, and treating a
            // null refdes, e.g. a manually captured point, as always its own
            // singleton group so unrelated manual points never get bundled
            // together) and hand each group to orderPointsByNozzleLean()
            // before dispensing it, so within-component order can favor the
            // nozzle's own lean direction without disturbing the overall
            // component-to-component traversal order.
            let i = 0;
            while (i < enabledPoints.length) {
                const refdes = enabledPoints[i].refdes;
                let j = i + 1;
                if (refdes != null) {
                    while (j < enabledPoints.length && enabledPoints[j].refdes === refdes) j++;
                }

                const group = refdes != null
                    ? this.orderPointsByNozzleLean(enabledPoints.slice(i, j), board)
                    : [enabledPoints[i]];

                for (const point of group) queue.push({board, point});

                i = j;
            }
        }

        return queue;
    }

    slice(){
        const commands = [];

        // add pre-gcode commands
        if (this.preGcode && this.preGcode.trim()) {
            const preCommands = this.preGcode.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            commands.push(...preCommands);
        }

        commands.push(
            "G90",          // set to absolute mode
            "G92 B0",        // reset b axis to 0
            `G0 Z${this.travelHeight}`      // make sure we're clear of the board
        );

        for (const {board, point} of this.buildRunQueue()) {
            commands.push(...this.pointDispenseCommands(point, board));
        }

        // Returning to the park position is finishRun()'s job, not sliced in
        // here - it runs after every run regardless of how it ends (finished
        // or cancelled, see run()), so there's exactly one "go home" move
        // instead of this fast one racing a slower one in finishRun() that
        // only cancellation used to actually see.

        // add post-gcode commands
        if (this.postGcode && this.postGcode.trim()) {
            const postCommands = this.postGcode.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            commands.push(...postCommands);
        }

        return commands;

    }

    // Re-dispenses a single point outside of a full job run - e.g. retrying
    // one pad that failed to wet, without redoing the whole board. Sends
    // directly rather than going through run()'s toast/cancel flow, since
    // it's meant to be a quick one-off.
    async dispenseSinglePoint(point){
        if (this.isRunning) {
            console.warn('Cannot paste a single pad while a job is running.');
            return;
        }

        const vacuumPwm = Math.round(this.vacuumPressure / 100 * 255);
        const commands = [
            "G90", "G92 B0", `G0 Z${this.travelHeight}`,
            ...this.pointDispenseCommands(point).map(c => c.replace("{VACUUM}", vacuumPwm).replace("{MOTOR_CURRENT}", this.motorCurrent)),
            "M107 P2",
        ];

        await this.lumen.serial.send(commands);
    }

    // Re-dispenses every pad of one component (e.g. all of R12's pads), in
    // order, outside of a full job run - the component-group equivalent of
    // dispenseSinglePoint(). Each pad still goes through dispenseSinglePoint
    // itself, so the isRunning guard and the exact per-pad gcode stay
    // identical to the single-pad button.
    async dispenseComponent(points){
        for (const point of points) {
            await this.dispenseSinglePoint(point);
        }
    }

    // Jogs to the centroid of a component's pads (its calibrated position if
    // fid-cal has run, else its raw import position) - the component-group
    // equivalent of a single pad row's "move to" button, since a whole
    // component has no single (x,y) of its own.
    moveToComponent(points){
        const xs = points.map(p => p.calX ?? p.x);
        const ys = points.map(p => p.calY ?? p.y);
        const centerX = xs.reduce((a, b) => a + b, 0) / xs.length;
        const centerY = ys.reduce((a, b) => a + b, 0) / ys.length;

        this.lumen.serial.send([
            "G90",
            `G0 Z${this.travelHeight}`,
            `G0 X${centerX} Y${centerY}`
        ]);
    }

    // Removes every pad belonging to one component from the job - the
    // component-group equivalent of a single pad row's remove button.
    removeComponent(refdes){
        this.placements = this.placements.filter(p => p.refdes !== refdes);
        this.loadJobIntoPositionList();
        this.drawJobToCanvas();
    }

    // Backs the Job Positions list's "Select All"/"Select None" buttons -
    // enables or disables every real placement (fiducials aren't part of a
    // run, so they're left alone) in one shot instead of clicking through
    // every type/component checkbox individually.
    setAllPlacementsEnabled(enabled){
        for (const p of this.placements) p.enabled = enabled;
        this.loadJobIntoPositionList();
        this.drawJobToCanvas();
    }

    // Starts the run timer and its live "Running: m:ss" display, ticking once
    // a second. Call stopRunTimer() on every way a run can end - it clears
    // the interval and freezes the display on the final elapsed time.
    startRunTimer(){
        this.runStartTime = Date.now();
        clearInterval(this.runTimerInterval);

        const el = document.getElementById('jobRunTime');
        if (el) el.textContent = 'Running: 0:00';

        this.runTimerInterval = setInterval(() => {
            if (el) el.textContent = `Running: ${formatElapsed(Date.now() - this.runStartTime)}`;
        }, 1000);
    }

    stopRunTimer(){
        clearInterval(this.runTimerInterval);
        this.runTimerInterval = null;

        if (this.runStartTime == null) return;

        this.lastRunDurationMs = Date.now() - this.runStartTime;
        this.runStartTime = null;

        const el = document.getElementById('jobRunTime');
        if (el) el.textContent = `Last run: ${formatElapsed(this.lastRunDurationMs)}`;
    }

    // Parks the head, kills both pumps, and drops the extruder current back down.
    // Shared by every way a job run can end (finished, cancelled via the toast) so
    // the board is always left in the same state instead of each path improvising.
    async finishRun(){
        this.isRunning = false;
        this.isPaused = false;
        this.toast.receivedInput = false;
        this.toast.hide();
        this.stopRunTimer();

        await this.lumen.serial.send(["G90"]);
        await this.lumen.serial.send(["M906 B 200"]);
        await this.lumen.serial.send(["M107 P2"]);
        await this.lumen.serial.send(["M107 P3"]);

        // Air purge - V2 (auger) only, since P3 is the vacuum pump's channel
        // and it isn't wired up on the V1 Beta plunger (see the "Right Air"
        // toggle's own comment in main.js). A brief on/off burst at the very
        // end of every run, whether it finished or was cancelled (this
        // function is shared by both), to clear the air line.
        if (this.hardwareVersion === 'v2') {
            await this.lumen.serial.send(["M106 P3", "G4 P500", "M107 P3"]);
        }

        await this.lumen.serial.send([`G0 Z${this.travelHeight} F10000`]);
        await this.lumen.serial.send(["G0 X5 Y5"]);
        await this.lumen.serial.send(["G0 F35000"]);
    }

    // Boards that would actually get pasted (at least one enabled placement)
    // but haven't had a real fiducial calibration run - either
    // performFiducialCalibration()'s camera jogs, or a full manual edit of
    // all three fiducials' calX/calY (recalibrateFromFiducialEdit()) - is
    // both. A board that only got as far as findBoardRoughPosition() sets
    // searchX/searchY but never a fiducial's calX/calY (see that method), so
    // this correctly still flags it: rough position alone is deliberately
    // imprecise (a starting point for fid cal to jog from), not something a
    // real run should ever paste from. Used by run() to refuse starting
    // rather than dispensing at wrong/uncalibrated positions.
    boardsMissingFiducialCalibration(){
        return this.boards.filter(board =>
            board.placements.some(p => p.enabled !== false) &&
            !(board.fiducials.length === 3 && board.fiducials.every(f => f.calX != null && f.calY != null))
        );
    }

    // Renders the "Running (n/total)... Pause" toast content - a direct
    // toastContent.innerHTML swap, NOT another toast.show() call. run()
    // calls toast.show() exactly ONCE per run (see below) to start the
    // single waitForUserSelection() loop that actually catches the toast's
    // close button and hides the toast on click - calling show() again
    // mid-run would start a SECOND, overlapping one racing the first (the
    // same bug class the Purge Auger toast hit twice before: bypassing
    // show() entirely breaks the close button because nothing ends up
    // polling for it at all). Direct innerHTML swaps here are safe because
    // toast-close lives outside toastContent (see index.html) - it, and the
    // one show() call's polling loop watching it, are never touched.
    renderRunningToastContent(){
        this.toast.toastContent.innerHTML =
            `Running job (<span id="runProgressText">${this.runProgressIndex}/${this.runQueue.length}</span>)... ` +
            `<button id="runPauseBtn" class="goldenrod-button" type="button">Pause</button>`;
        document.getElementById('runPauseBtn')?.addEventListener('click', () => this.pauseRun());
    }

    // Renders the "Paused (n/total)... Resume" toast content - see
    // renderRunningToastContent() for why this is a direct innerHTML swap
    // rather than another toast.show() call.
    renderPausedToastContent(){
        this.toast.toastContent.innerHTML =
            `Paused (<span id="runProgressText">${this.runProgressIndex}/${this.runQueue.length}</span> pasted) - tip parked, pump off, safe to check the board. ` +
            `<button id="runResumeBtn" class="goldenrod-button" type="button">Resume</button>`;
        document.getElementById('runResumeBtn')?.addEventListener('click', () => this.resumeRun());
    }

    // Live-updates the running/paused toast's progress count in place,
    // without touching anything else in it - cheap enough to call after
    // every single point instead of re-rendering the whole toast.
    updateRunningToastProgress(){
        const el = document.getElementById('runProgressText');
        if (el) el.textContent = `${this.runProgressIndex}/${this.runQueue.length}`;
    }

    // Pauses a running job - run()'s own loop only ever checks isPaused
    // between two points, never mid-point, so the tip is always fully
    // retracted and idle (never mid-extrude) by the time this takes visible
    // effect. Lifts to travel height and kills the pump so it's safe to look
    // at or touch the board - e.g. to check remaining paste or a pad that
    // looks off - without cancelling the run. resumeRun() picks the very
    // next point back up exactly where it left off.
    pauseRun(){
        if (!this.isRunning || this.isPaused) return;
        this.isPaused = true;
        this.renderPausedToastContent();
    }

    resumeRun(){
        if (!this.isRunning || !this.isPaused) return;
        this.isPaused = false;
        this.renderRunningToastContent();
    }

    // Shows/hides the Resume Job button and its status line based on
    // whether the last run stopped partway through (see run()'s own
    // lastRunStoppedAtPoint) - called whenever that can change.
    updateRunResumeControls(){
        const btn = document.getElementById('resumeJob');
        const info = document.getElementById('jobRunProgress');
        const stopped = this.lastRunStoppedAtPoint != null;
        if (btn) btn.hidden = !stopped;
        if (info) info.textContent = stopped
            ? `Stopped at pad ${this.lastRunStoppedIndex + 1}/${this.lastRunQueueLength} - Resume Job to continue from there.`
            : '';
    }

    // Slices and executes a job, one POINT at a time (not just one gcode
    // line at a time, like this used to) so a pause or cancel only ever
    // lands between two points' full dispense sequences - never mid-
    // sequence, which could leave the tip stopped somewhere physically
    // ambiguous (mid-extrude, still down, pump still on).
    //
    // startAtPoint re-starts from a specific Point instead of the very
    // first one - used both by the auto-tracked Resume Job button (passing
    // lastRunStoppedAtPoint) and by each Job Positions row's own "Run from
    // here" button (passing that row's own point), so a cancelled/failed
    // run - or just re-testing one board's tail end - doesn't have to
    // repaste everything already done.
    async run(startAtPoint = null){
        if (this.isRunning) {
            alert('A job is already running - use Pause/the toast\'s close button first.');
            return;
        }

        const uncalibrated = this.boardsMissingFiducialCalibration();
        if (uncalibrated.length > 0) {
            const names = uncalibrated.map(b => b.name).join(', ');
            alert(`Run fiducial calibration (Perform Fid Cal) before running - not done yet for: ${names}`);
            return;
        }

        const queue = this.buildRunQueue();
        if (queue.length === 0) {
            alert('Nothing to run - every pad is disabled, or the job is empty.');
            return;
        }

        if (!this.lumen.serial.isConnected()) {
            alert('Not connected to the machine - connect first.');
            return;
        }

        let startIndex = 0;
        if (startAtPoint) {
            const idx = queue.findIndex(entry => entry.point === startAtPoint);
            if (idx === -1) {
                alert("Can't find that point in the current job anymore (the board may have changed) - starting from the beginning instead.");
            } else {
                startIndex = idx;
            }
        }

        this.runQueue = queue;
        this.runProgressIndex = startIndex;
        this.isRunning = true;
        this.isPaused = false;
        this.lastRunStoppedAtPoint = null;
        this.updateRunResumeControls();
        this.startRunTimer();

        this.toast.show("Running job. Close this to cancel.");
        this.renderRunningToastContent();

        await this.lumen.serial.send(["G90", "G92 B0", `G0 Z${this.travelHeight}`]);

        let i = startIndex;
        for (; i < queue.length; i++){

            // Cancelled via the toast's close button - checked once per
            // POINT (not once per gcode line, like the old flat-command-
            // list loop did) so a cancel always lands between two complete
            // dispense sequences.
            if (this.toast.toastObject.style.display === "none") {
                this.isRunning = false;
            }

            if (this.isPaused) {
                await this.lumen.serial.send([`G0 Z${this.travelHeight} F10000`, "M107 P2"]);
                while (this.isPaused && this.toast.toastObject.style.display !== "none") {
                    await this.toast.timeout(150);
                }
                if (this.toast.toastObject.style.display === "none") this.isRunning = false;
            }

            if (!this.isRunning) break;

            const {board, point} = queue[i];

            // Substitute the current air assist level/motor current at send
            // time so those sliders can retune mid-job. Stored as a 0-100
            // percentage; the firmware wants a 0-255 PWM value.
            const vacuumPwm = Math.round(this.vacuumPressure / 100 * 255);
            const commands = this.pointDispenseCommands(point, board)
                .map(c => c.replace("{VACUUM}", vacuumPwm).replace("{MOTOR_CURRENT}", this.motorCurrent));

            const sendOk = await this.lumen.serial.send(commands);

            // send() returns false (instead of throwing) when the port drops mid-job.
            // Stop here rather than blasting through the rest, which would otherwise
            // fire a "Cannot Write" prompt for every remaining line. The board is
            // already unreachable, so skip the parking gcode - it would just fail the
            // same way and spam another round of error modals.
            if (!sendOk) {
                console.warn("Job stopped: lost connection to the board.");
                this.lastRunStoppedAtPoint = point;
                this.lastRunStoppedIndex = i;
                this.lastRunQueueLength = queue.length;
                this.isRunning = false;
                this.isPaused = false;
                this.toast.receivedInput = false;
                this.toast.hide();
                this.stopRunTimer();
                this.updateRunResumeControls();
                return;
            }

            this.runProgressIndex = i + 1;
            this.updateRunningToastProgress();
        }

        if (i < queue.length) {
            this.lastRunStoppedAtPoint = queue[i].point;
            this.lastRunStoppedIndex = i;
            this.lastRunQueueLength = queue.length;
        }

        await this.finishRun();
        this.updateRunResumeControls();
    }


    // One board's plain-data shape for export() - the counterpart to
    // deserializeBoard().
    serializeBoard(board){
        return {
            id: board.id,
            name: board.name,
            placements: board.placements.map(p => ({
                x: p.x,
                y: p.y,
                z: p.z,
                dispenseDegrees: p.dispenseDegrees,
                calX: p.calX,
                calY: p.calY,
                canvasX: p.canvasX,
                canvasY: p.canvasY,
                refdes: p.refdes,
                componentType: p.componentType,
                dispensePattern: p.dispensePattern,
                padAreaMm2: p.padAreaMm2,
                enabled: p.enabled
            })),
            boardOutline: board.boardOutline,
            padShapes: board.padShapes,
            maskPadShapes: board.maskPadShapes,
            fiducials: board.fiducials.map(f => ({
                x: f.x,
                y: f.y,
                z: f.z,
                calX: f.calX,
                calY: f.calY,
                canvasX: f.canvasX,
                canvasY: f.canvasY,
                searchX: f.searchX,
                searchY: f.searchY
            })),
            componentOverrides: Object.fromEntries(board.componentOverrides),
            tipXoffset: board.tipXoffset,
            tipYoffset: board.tipYoffset,
            zOffset: board.zOffset,
        };
    }

    export() {
        const data = {
            // One entry per Job Positions tab (see this.boards) - a job with
            // several pasted boards restores every tab, not just whichever
            // one was active when it was saved.
            boards: this.boards.map(board => this.serializeBoard(board)),
            activeBoardIndex: this.activeBoardIndex,
            showPadOverlay: this.showPadOverlay,
            showMaskPadOverlay: this.showMaskPadOverlay,
            pasteDispenseSettings: getPasteDispenseSettings(),
            dispenseDegrees: this.dispenseDegrees,
            dispenseMultiplier: this.dispenseMultiplier,
            stencilThicknessMm: this.stencilThicknessMm,
            nozzleGauge: this.nozzleGauge,
            retractionDegrees: this.retractionDegrees,
            dwellMilliseconds: this.dwellMilliseconds,
            motionSpeed: this.motionSpeed,
            extruderSpeed: this.extruderSpeed,
            vacuumPressure: this.vacuumPressure,
            motorCurrent: this.motorCurrent,
            travelHeight: this.travelHeight,
            preGcode: this.preGcode,
            postGcode: this.postGcode,
            invertDispense: this.invertDispense,
            // tipXoffset/tipYoffset/zOffset are per-board now (see
            // serializeBoard()) rather than one job-wide value here -
            // importFromFile() still reads a legacy top-level value like
            // this from an older file for backward compat.
            buildPlateId: this.buildPlateId,
            customBuildPlateWidthMm: this.customBuildPlateWidthMm,
            customBuildPlateHeightMm: this.customBuildPlateHeightMm,
            customBuildPlateOriginXMm: this.customBuildPlateOriginXMm,
            customBuildPlateOriginYMm: this.customBuildPlateOriginYMm,
            homedZHeightMm: this.homedZHeightMm,
            maxTravelXMm: this.maxTravelXMm,
            maxTravelYMm: this.maxTravelYMm,
            offCenterCam: this.offCenterCam
        };
        return JSON.stringify(data, null, 2);
    }

    // performs a linear transformation on all placement points based on three fiducial points
    // realFids should be an array of three [x,y] coordinates representing where the fiducials actually are.
    // board defaults to the active one, but findBoardRoughPosition() and
    // performFiducialCalibration() pass their own captured board explicitly
    // - those flows span several user-interaction pauses, during which the
    // active board must NOT be allowed to silently drift out from under
    // them (see this._boardFlowActive in the constructor).
    transformPlacements(realFids, board = this.activeBoard) {
        // Get the original fiducial positions from our job
        const origFids = [
            [board.fiducials[0].x, board.fiducials[0].y],
            [board.fiducials[1].x, board.fiducials[1].y],
            [board.fiducials[2].x, board.fiducials[2].y]
        ]

        const matrix = fromTriangles(origFids, realFids);

        // Kept so recomputeDispensePattern() can re-apply this same
        // calibration to a freshly rebuilt set of points (e.g. after an
        // Advanced Settings change) without needing fid-cal run again.
        board.fidCalMatrix = matrix;

        for (let point of board.placements) {

            let transformedPoint = applyToPoint(matrix, [point.x, point.y])

            point.calX = transformedPoint[0];
            point.calY = transformedPoint[1];

        }

    }

    // Interpolates a Z height for every placement from the three fiducials'
    // own Z fields, the height-only counterpart to transformPlacements()'s
    // X/Y affine fit. A real board is rarely perfectly flat/level on the bed
    // - fitting a plane through the three fiducials' measured heights (rather
    // than stamping one flat Z on every point) lets a board that sits higher
    // on one side still get a good nozzle-to-pad touchdown everywhere, not
    // just near wherever the single old Z touch happened to be taken.
    //
    // No-ops (leaving whatever Z each placement already has) unless all
    // three fiducials carry both a position and a Z - that's everything
    // findBoardRoughPosition() seeds in one shot, but a board that hasn't
    // gotten that far yet (or doesn't have exactly 3 fiducials) has nothing
    // valid to fit a plane to. board defaults to the active one - see
    // transformPlacements()'s matching parameter.
    applyFiducialZTransform(board = this.activeBoard){
        if (board.fiducials.length !== 3) return;

        const fids = board.fiducials.map(f => ({
            x: f.calX ?? f.searchX ?? f.x,
            y: f.calY ?? f.searchY ?? f.y,
            z: f.z,
        }));

        if (fids.some(f => f.x == null || f.y == null || f.z == null || [f.x, f.y, f.z].some(Number.isNaN))) return;

        const zAt = fitZPlane(fids);
        if (!zAt) return; // fiducials collinear in X/Y - no unique tilt to solve for

        for (const point of board.placements) {
            const px = point.calX ?? point.x;
            const py = point.calY ?? point.y;
            point.z = zAt(px, py);
        }
    }

    // Re-derives the fid-cal affine transform from the fiducials' current
    // calX/calY (see the editable X/Y boxes in createPositionElement()) and
    // reapplies it to every placement - the manual-edit equivalent of what
    // performFiducialCalibration() does after actually jogging to each
    // fiducial in turn. No-ops (past just re-rendering the edited value)
    // until all three fiducials have a real position set - editing only one
    // or two doesn't have a full triangle to fit a transform to yet. Also
    // re-fits the Z plane (applyFiducialZTransform()) on every call,
    // regardless of which axis was actually edited, since a Z edit alone
    // still needs to reach here to do anything.
    recalibrateFromFiducialEdit(){
        if (this.fiducials.length === 3 && this.fiducials.every(f => f.calX != null && f.calY != null)) {
            const realFids = this.fiducials.map(f => [parseFloat(f.calX), parseFloat(f.calY)]);
            this.transformPlacements(realFids);
        }

        this.applyFiducialZTransform();

        this.loadJobIntoPositionList();
        this.drawJobToCanvas();
    }

}
