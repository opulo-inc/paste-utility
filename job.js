import {fromTriangles, applyToPoint, applyToPoints} from 'transformation-matrix';
import {importGerberSet, tagTightPitchPads, computeAlternatingSigns, planPadDispense, groupPadsByComponent, findFiducialCandidates, COMPONENT_TYPE_ORDER, placementDotRadiusMm} from './gerberImport.js';

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

        this.placements = [];
        this.fiducials = [];

        // Raw pad footprints (shape/xSize/ySize, mm, world space) from the
        // last gerber import - kept only for the optional "show pads"
        // overlay (see drawJobToCanvas), not persisted with the job, since
        // it's just a visual aid over the dispense points that already carry
        // everything a run actually needs.
        this.padShapes = [];
        this.showPadOverlay = false;

        // Board outline segments (mm, world space) from a gerber Edge_Cuts/
        // Profile layer, drawn for reference on the point-viz canvas. See
        // extractOutline() in gerberImport.js.
        this.boardOutline = [];

        // Job Positions list expand/collapse state, keyed by component type
        // and by refdes respectively - kept here (not derived fresh each
        // render) so re-rendering the list after any change doesn't collapse
        // whatever the user had open. Type groups start expanded; individual
        // component groups start collapsed so importing a board with hundreds
        // of parts doesn't dump every single pad open at once.
        this.expandedTypes = new Set(COMPONENT_TYPE_ORDER);
        this.expandedComponents = new Set();

        this.dispenseDegrees = 30;
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
        this.lumen = lumen;
        this.toast = toast;

        this.jobCanvas = document.getElementById('pointViz');

        // User-applied zoom/pan on top of the auto-fit-to-bounds view computed
        // each draw in drawJobToCanvas(). scale is a multiplier on the fit
        // scale; pan is in canvas pixels (see zoomViewAt()'s comment for the
        // pre-flip Y convention it shares with drawJobToCanvas).
        this.view = { scale: 1, panX: 0, panY: 0 };

        this.clickedFidBuffer = [];

        this.setupCanvasInteractions();
    }

    // Wires up the point-viz canvas so the board view stays sized to its
    // container (instead of a hardcoded bitmap) and supports wheel-zoom,
    // drag-to-pan, and double-click-to-reset.
    setupCanvasInteractions(){
        const canvas = this.jobCanvas;
        const container = canvas.closest('.gerber-visualization-container') ?? canvas.parentElement;
        const minZoom = 0.5;
        const maxZoom = 30;

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
        let lastX = 0, lastY = 0;

        canvas.addEventListener('pointerdown', (event) => {
            dragging = true;
            dragMoved = false;
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
            this.view.panX += dx;
            this.view.panY -= dy; // screen Y is flipped relative to the canvasY convention drawJobToCanvas uses
            this.drawJobToCanvas();
        });

        const endDrag = () => {
            dragging = false;
            if (!dragMoved) return;
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

        document.getElementById('vizZoomIn')?.addEventListener('click', () => {
            const rect = canvas.getBoundingClientRect();
            this.zoomViewAt(rect.width / 2, rect.height / 2, Math.min(maxZoom, this.view.scale * 1.4));
        });
        document.getElementById('vizZoomOut')?.addEventListener('click', () => {
            const rect = canvas.getBoundingClientRect();
            this.zoomViewAt(rect.width / 2, rect.height / 2, Math.max(minZoom, this.view.scale / 1.4));
        });
        document.getElementById('vizZoomReset')?.addEventListener('click', () => this.resetView());

        const togglePadsButton = document.getElementById('vizTogglePads');
        togglePadsButton?.addEventListener('click', () => {
            this.showPadOverlay = !this.showPadOverlay;
            togglePadsButton.classList.toggle('active', this.showPadOverlay);
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

    // this does a few things
    // it takes all the points and fids in a job, and draws them on the canvas
    // it also saves all the drawn positions to the point and fid objects for easier click detection
    //
    drawJobToCanvas(){

        const ctx = this.jobCanvas.getContext("2d");
        const canvasWidth = this.jobCanvas.width;
        const canvasHeight = this.jobCanvas.height;

        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        const hasOutline = this.boardOutline && this.boardOutline.length > 0;
        if (this.placements.length === 0 && this.fiducials.length === 0 && !hasOutline) return;

        // Find bounds of all points (and the board outline, if we have one -
        // it's usually the largest extent anyway, but a board with parts
        // placed oddly close to one edge shouldn't get clipped).
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const point of this.placements) {

            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }

        for (const point of this.fiducials) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }

        if (hasOutline) {
            for (const seg of this.boardOutline) {
                minX = Math.min(minX, seg.x1, seg.x2);
                minY = Math.min(minY, seg.y1, seg.y2);
                maxX = Math.max(maxX, seg.x1, seg.x2);
                maxY = Math.max(maxY, seg.y1, seg.y2);
            }
        }

        // Add a small margin to the bounds (floored so a single point doesn't
        // collapse the bounds to zero width/height)
        const margin = Math.max(maxX - minX, maxY - minY, 1) * 0.1; // 10% margin
        minX -= margin;
        minY -= margin;
        maxX += margin;
        maxY += margin;

        const width = maxX - minX;
        const height = maxY - minY;

        // Calculate scale to fit the canvas while maintaining aspect ratio
        const scaleX = canvasWidth / width;
        const scaleY = canvasHeight / height;
        const fitScale = Math.min(scaleX, scaleY);

        // Calculate shifts to center the points - including extra centering
        // along whichever axis has slack after fitting, so the board sits in
        // the middle of the (square) canvas instead of pinned to its bottom-left
        // corner. Without this, zooming in from the canvas center (mouse wheel,
        // +/- buttons) can zoom into empty space when the board's aspect ratio
        // doesn't match the canvas.
        const xShift = -minX + (canvasWidth / fitScale - width) / 2;
        const yShift = -minY + (canvasHeight / fitScale - height) / 2;

        // User-applied zoom/pan (see setupCanvasInteractions/zoomViewAt) sits on
        // top of the auto-fit computed above: scale multiplies it, pan is a flat
        // canvas-pixel offset applied after.
        const scale = fitScale * this.view.scale;
        const panX = this.view.panX;
        const panY = this.view.panY;

        // Draw the board outline first so placement/fiducial dots layer on top of it.
        if (hasOutline) {
            ctx.strokeStyle = "#999";
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (const seg of this.boardOutline) {
                const x1 = (seg.x1 + xShift) * scale + panX;
                const y1 = (seg.y1 + yShift) * scale + panY;
                const x2 = (seg.x2 + xShift) * scale + panX;
                const y2 = (seg.y2 + yShift) * scale + panY;
                ctx.moveTo(x1, canvasHeight - y1);
                ctx.lineTo(x2, canvasHeight - y2);
            }
            ctx.stroke();
        }

        // Draw pad footprints (semi-transparent) under the fid/dispense dots,
        // so the dots' placement relative to the actual pad can be checked
        // at a glance. Optional - toggled from the visualization controls.
        if (this.showPadOverlay && this.padShapes.length > 0) {
            ctx.save();
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = "#b8860b";
            ctx.strokeStyle = "#8b6508";
            ctx.lineWidth = 1;

            for (const pad of this.padShapes) {
                const cx = (pad.x + xShift) * scale + panX;
                const cy = canvasHeight - ((pad.y + yShift) * scale + panY);
                const w = Math.max((pad.xSize ?? pad.diameter ?? 0.3) * scale, 1);
                const h = Math.max((pad.ySize ?? pad.diameter ?? 0.3) * scale, 1);

                ctx.beginPath();
                if (pad.shape === 'circle' || pad.shape === 'polygon') {
                    ctx.arc(cx, cy, Math.max(w, h) / 2, 0, Math.PI * 2);
                } else if (pad.shape === 'obround') {
                    drawRoundedRectPath(ctx, cx - w / 2, cy - h / 2, w, h, Math.min(w, h) / 2);
                } else {
                    ctx.rect(cx - w / 2, cy - h / 2, w, h);
                }
                ctx.fill();
                ctx.stroke();
            }

            ctx.restore();
        }

        // Draw fid points in blue
        ctx.fillStyle = "blue";
        for (let point of this.fiducials) {

            const newX = (point.x + xShift) * scale + panX;
            const newY = (point.y + yShift) * scale + panY;

            point.canvasX = newX;
            point.canvasY = newY;

            ctx.beginPath();
            ctx.arc(newX, canvasHeight - newY, 2, 0, Math.PI * 2);
            ctx.fill();

        }

        // Draw paste points in red, sized by their dispense degrees (a
        // per-point override if the gerber import gave it one, otherwise the
        // job's global Dispense Degrees setting - same fallback gcode
        // generation uses, see line ~904). Points a group checkbox disabled
        // are skipped entirely - the canvas should show what will actually
        // get pasted, not the whole board regardless of selection.
        ctx.fillStyle = "red";
        for (let point of this.placements) {
            if (point.enabled === false) continue;

            const newX = (point.x + xShift) * scale + panX;
            const newY = (point.y + yShift) * scale + panY;

            point.canvasX = newX;
            point.canvasY = newY;

            const effectiveDegrees = point.dispenseDegrees ?? parseFloat(this.dispenseDegrees);
            const radius = Math.max(PLACEMENT_DOT_MIN_RADIUS_PX, placementDotRadiusMm(effectiveDegrees) * scale);

            ctx.beginPath();
            ctx.arc(newX, this.jobCanvas.height - newY, radius, 0, Math.PI * 2);
            ctx.fill();
        }

    }

    // returns the closest point object to a click coordinate on the canvas
    returnClosestFidFromClickCoordinates(clickX, clickY){
        // Find the closest point within a larger threshold
        const threshold = 10.0; // 2mm threshold for easier clicking
        let closestPoint = null;
        let minDistance = Infinity;

        // Only check fid points
        for (const point of this.fiducials) {
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

    // Imports a paste (+ optional mask, + optional board outline) layer from
    // whatever was selected in the gerber file input - either a single zip
    // (typical KiCad/JLCPCB/EasyEDA fab output bundle) or several loose gerber
    // files - auto-detecting which file is which from the Gerber X2
    // %TF.FileFunction% attribute (falling back to filename conventions for
    // older exports that don't have it).
    //
    // Pads are classified from their real aperture geometry: elongated pads get
    // a line of dots, large open pads (e.g. QFN thermal pads) get a grid, and
    // pads sitting in a fine pitch row (TSOP/QFP-style) get a single dot that
    // alternates position slightly to cut bridging risk. Each dot's dispense
    // volume is scaled off a 30-degree-for-a-0402-pad baseline. See
    // gerberImport.js for the tunable thresholds.
    //
    // Points are pushed in component order - grouped by refdes (from the
    // paste layer's %TO.C% attributes, if the export included them) and
    // ordered by part type (resistors, then capacitors, then ICs, then
    // everything else) rather than a raster scan across the board - which is
    // also then the order placements dispense in during a run. A board
    // without those attributes falls back to the previous raster order.
    async loadGerberFiles(fileList){
        const {pastePads, maskFlashes, outline, warnings, drillHoles} = await importGerberSet(fileList);

        if (warnings.length) console.warn('Gerber import warnings:', warnings);

        // Importing a gerber set replaces whatever job was previously loaded -
        // otherwise the new board's pads/fiducials pile up on top of the old
        // ones and the two boards' points get mixed together on the canvas
        // and in the position list.
        this.placements = [];
        this.fiducials = [];
        this.expandedComponents = new Set();
        this.view = { scale: 1, panX: 0, panY: 0 };

        this.boardOutline = outline;
        this.padShapes = pastePads;

        const taggedPads = tagTightPitchPads(pastePads);
        const groups = groupPadsByComponent(taggedPads);

        // Alternating +1/-1 per tight-pitch pad (proper graph 2-coloring, see
        // computeAlternatingSigns), computed once up front, independent of
        // group/traversal order - which direction planPadDispense() nudges
        // that pad's single dot to stagger a row of closely spaced leads.
        const alternatingSigns = computeAlternatingSigns(taggedPads);

        for (const group of groups) {
            for (const pad of group.pads) {
                const sign = pad.tightPitch ? (alternatingSigns.get(pad) ?? 0) : 0;

                const dots = planPadDispense(pad, parseFloat(this.dispenseDegrees), sign);
                for (const {dx, dy, dispenseDegrees} of dots){
                    const point = new Point(pad.x + dx, pad.y + dy, 31.5, dispenseDegrees);
                    point.refdes = group.refdes;
                    point.componentType = group.type;
                    this.placements.push(point);
                }
            }
        }

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
            this.fiducials.push(newPoint);
        }

        // Draw immediately so the imported board is visible right away, before
        // we even get to the (optional, and possibly interrupted) fiducial step.
        this.drawJobToCanvas();
        this.loadJobIntoPositionList();

        if (this.fiducials.length < 3) {
            // Clicking asks returnClosestFidFromClickCoordinates() to match a candidate
            // within a small pixel threshold - with fewer than 3 candidates on the board,
            // some of those clicks can never match anything, so the toast-driven flow
            // below would wait forever. Skip it without blocking the view of the board -
            // paste points are already imported and visible; fiducials can be added
            // manually with Capture New Position.
            console.warn(`Only found ${this.fiducials.length} fiducial candidate(s) on the mask layer (need 3). Add fiducials manually if needed.`);
            return {padCount: this.placements.length, fiducialCount: this.fiducials.length};
        }

        // set up event listener for first fid selection
        // which just puts the closest point object directly into this.toast.receivedInput

        // we need a named function for removing the event listener later

        function sendClickToToast(event){


            const rect = this.jobCanvas.getBoundingClientRect();

            const x = event.clientX - rect.left;
            const y = this.jobCanvas.height - (event.clientY - rect.top); // Flip Y coordinate

            // console.log("event.clientX: ", event.clientX)
            // console.log("event.clientY: ", event.clientY)

            // console.log("rect.left: ", rect.left)
            // console.log("rect.top: ", rect.top)

            // console.log("clicked coordinates: ", x, y)

            let closestClick = this.returnClosestFidFromClickCoordinates(x, y);

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

        // show the first toast asking them to click
        const fid1_object = await this.toast.show("Please click on FID1 in the display.");

        // show the second toast asking them to click
        const fid2_object = await this.toast.show("Please click on FID2 in the display.");

        // show the third toast asking them to click
        const fid3_object = await this.toast.show("Please click on FID3 in the display.");

        // cancel event listener for fid selection
        this.jobCanvas.removeEventListener('click', boundSendClickToToast)

        // delete all fids from this.fiducials other than the ones we just got
        this.fiducials = [fid1_object, fid2_object, fid3_object];

        console.log("fiducials: ", this.fiducials)
        console.log("placements: ", this.placements)

        //populate the position list
        this.loadJobIntoPositionList();
        // make some buttons red so that the user knows it's NOT ready to run a job yet

        this.drawJobToCanvas();

        return {padCount: this.placements.length, fiducialCount: this.fiducials.length};

    }

    async findBoardRoughPosition(){
        // request in toast to jog to fid1
        await this.toast.show("Please jog the camera to be centered on FID1.");

        // upon hitting continue, grab current position, save to fid1 searchXY
        const fid1Rough = await this.lumen.grabBoardPosition();

        console.log("fid1Rough: ", fid1Rough)

        this.fiducials[0].searchX = parseFloat(fid1Rough[0]);
        this.fiducials[0].searchY = parseFloat(fid1Rough[1]);

        // repeat for fid2 and fid3
        await this.toast.show("Please jog the camera to be centered on FID2.");
        const fid2Rough = await this.lumen.grabBoardPosition();
        this.fiducials[1].searchX = parseFloat(fid2Rough[0]);
        this.fiducials[1].searchY = parseFloat(fid2Rough[1]);

        await this.toast.show("Please jog the camera to be centered on FID3.");
        const fid3Rough = await this.lumen.grabBoardPosition();
        this.fiducials[2].searchX = parseFloat(fid3Rough[0]);
        this.fiducials[2].searchY = parseFloat(fid3Rough[1]);

        // ask to jog tip directly touching top surface
        await this.toast.show("Please jog the paste extruder tip to just barely touch the board.");

        // grab z pos and add .2 mm or something
        let zPos = await this.lumen.grabBoardPosition();

        await this.lumen.serial.send([`G0 Z${this.travelHeight}`]);

        zPos = parseFloat(zPos[2]) + 0.2;

        // save that position to every placement
        for(const placement of this.placements){
            placement.z = zPos
        }

        console.log(`this.fiducials: `, this.fiducials)

        this.transformPlacements([
            [this.fiducials[0].searchX, this.fiducials[0].searchY],
            [this.fiducials[1].searchX, this.fiducials[1].searchY],
            [this.fiducials[2].searchX, this.fiducials[2].searchY]
        ]);

        console.log(this.placements);

        this.loadJobIntoPositionList()

    }

    async performTipCalibration(){
        await this.toast.show("Please jog the camera to be centered on any fiducial.");

        // upon hitting continue, grab current position, save to fid1 searchXY
        const camPos = await this.lumen.grabBoardPosition();

        await this.lumen.serial.send([`G0 Z${this.travelHeight}`]);

        await this.lumen.serial.goToRelative(-45,63);

        await this.lumen.serial.send(["G0 Z46.5"]);

        await this.toast.show("Please jog the nozzle tip to be perfectly centered on and touching the fiducial.");

        const nozPos = await this.lumen.grabBoardPosition();

        await this.lumen.serial.send([`G0 Z${this.travelHeight}`]);

        this.lumen.tipXoffset = nozPos[0] - camPos[0];
        this.lumen.tipYoffset = nozPos[1] - camPos[1];

    }

    async performFiducialCalibration(){
        // lots of checks first
        if(this.fiducials.length !== 3){
            console.error("No fids in this job, cannot perform fiducial calibration.");
            return;
        }

        let fidActual = [];
        // go through and capture the actual positions of the fids
        // then we can perform the transformation

        for(let i = 0; i < this.fiducials.length; i++){
            const fid = this.fiducials[i];
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
        this.transformPlacements(fidActual);

        console.log("fid cal complete: ", this.fiducials);

        this.loadJobIntoPositionList();


    }


    // Renders the Job Positions list, grouped Type > Component > pad when
    // placements carry component info (see loadGerberFiles()), so a big
    // gerber-imported board doesn't just dump hundreds of individual pads in
    // one flat list. Placements without a refdes (manually captured points,
    // or a job imported without component attributes) render as plain
    // standalone rows, same as before this grouping existed.
    loadJobIntoPositionList(){
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

        const header = document.createElement('div');
        header.className = 'component-type-header';
        header.innerHTML = `
            <span class="group-chevron">${expanded ? '▾' : '▸'}</span>
            <input type="checkbox" class="group-enable-toggle" ${allEnabled ? 'checked' : ''}>
            <span class="group-label">${COMPONENT_TYPE_LABELS[type] || type}</span>
            <span class="group-count">${byRefdes.size} part${byRefdes.size === 1 ? '' : 's'} · ${totalPads} pad${totalPads === 1 ? '' : 's'}</span>
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
    // enables/disables all of that component's pads, and, when expanded, the
    // individual pad rows (each with its own "paste this pad only" action -
    // see createPositionElement - for retrying just one failed pad).
    renderComponentGroup(container, refdes, points){
        const allEnabled = points.every(p => p.enabled !== false);
        const anyEnabled = points.some(p => p.enabled !== false);
        const expanded = this.expandedComponents.has(refdes);

        const header = document.createElement('div');
        header.className = 'component-header';
        header.innerHTML = `
            <span class="group-chevron">${expanded ? '▾' : '▸'}</span>
            <input type="checkbox" class="group-enable-toggle" ${allEnabled ? 'checked' : ''}>
            <span class="group-label">${refdes}</span>
            <span class="group-count">${points.length} pad${points.length === 1 ? '' : 's'}</span>
        `;

        const toggle = header.querySelector('.group-enable-toggle');
        toggle.indeterminate = !allEnabled && anyEnabled;
        toggle.addEventListener('click', (e) => e.stopPropagation());
        toggle.addEventListener('change', (e) => {
            for (const p of points) p.enabled = e.target.checked;
            this.loadJobIntoPositionList();
            this.drawJobToCanvas();
        });

        header.addEventListener('click', () => {
            if (expanded) this.expandedComponents.delete(refdes); else this.expandedComponents.add(refdes);
            this.loadJobIntoPositionList();
        });

        container.appendChild(header);
        if (!expanded) return;

        const padList = document.createElement('div');
        padList.className = 'component-pads';
        container.appendChild(padList);

        for (const point of points) {
            this.createPositionElement(point, false, padList);
        }
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

            this.placements = (data.placements || []).map(p => {
                const point = new Point(p.x, p.y, p.z, p.dispenseDegrees);
                point.calX = p.calX;
                point.calY = p.calY;
                point.canvasX = p.canvasX;
                point.canvasY = p.canvasY;
                point.refdes = p.refdes ?? null;
                point.componentType = p.componentType ?? null;
                point.enabled = p.enabled !== false;
                return point;
            });
            this.boardOutline = data.boardOutline || [];
            this.padShapes = data.padShapes || [];
            this.showPadOverlay = data.showPadOverlay || false;
            this.fiducials = (data.fiducials || []).map(f => {
                const fid = new Fiducial(f.x, f.y, f.z, f.searchX, f.searchY);
                fid.calX = f.calX;
                fid.calY = f.calY;
                fid.canvasX = f.canvasX;
                fid.canvasY = f.canvasY;
                return fid;
            });

            this.dispenseDegrees = data.dispenseDegrees || 30;
            this.motionSpeed = data.motionSpeed || 35000;
            this.extruderSpeed = data.extruderSpeed || 100000;
            this.vacuumPressure = typeof data.vacuumPressure !== 'undefined' ? data.vacuumPressure : 100;
            this.motorCurrent = typeof data.motorCurrent !== 'undefined' ? data.motorCurrent : 450;
            this.travelHeight = typeof data.travelHeight !== 'undefined' ? data.travelHeight : 31.5;
            this.preGcode = data.preGcode || "";
            this.postGcode = data.postGcode || "";
            this.invertDispense = data.invertDispense || false;

            // Set tip offsets if present
            if (typeof data.tipXoffset !== 'undefined') this.lumen.tipXoffset = data.tipXoffset;
            if (typeof data.tipYoffset !== 'undefined') this.lumen.tipYoffset = data.tipYoffset;
            if (typeof data.zOffset !== 'undefined') this.lumen.zOffset = data.zOffset;

            // ui update
            const jobDispenseDeg = document.getElementById('jobDispenseDeg');
            const jobMotionSpeed = document.getElementById('jobMotionSpeed');
            const jobExtruderSpeed = document.getElementById('jobExtruderSpeed');
            const jobVacuumPressure = document.getElementById('jobVacuumPressure');
            const jobVacuumPressureValue = document.getElementById('jobVacuumPressureValue');
            const jobMotorCurrent = document.getElementById('jobMotorCurrent');
            const jobTravelHeight = document.getElementById('jobTravelHeight');
            const jobPreGcode = document.getElementById('jobPreGcode');
            const jobPostGcode = document.getElementById('jobPostGcode');
            const jobInvertDispense = document.getElementById('jobInvertDispense');
            const xOffsetValue = document.getElementById('x-offset-value');
            const yOffsetValue = document.getElementById('y-offset-value');
            const zOffsetValue = document.getElementById('z-offset-value');

            if (jobDispenseDeg) jobDispenseDeg.value = this.dispenseDegrees;
            if (jobMotionSpeed) jobMotionSpeed.value = this.motionSpeed;
            if (jobExtruderSpeed) jobExtruderSpeed.value = this.extruderSpeed;
            if (jobVacuumPressure) jobVacuumPressure.value = this.vacuumPressure;
            if (jobVacuumPressureValue) jobVacuumPressureValue.textContent = this.vacuumPressure;
            if (jobMotorCurrent) jobMotorCurrent.value = this.motorCurrent;
            if (jobTravelHeight) jobTravelHeight.value = this.travelHeight;
            if (jobPreGcode) jobPreGcode.value = this.preGcode;
            if (jobPostGcode) jobPostGcode.value = this.postGcode;
            if (jobInvertDispense) jobInvertDispense.checked = this.invertDispense;
            if (xOffsetValue) xOffsetValue.textContent = `${this.lumen.tipXoffset.toFixed(1)}mm`;
            if (yOffsetValue) yOffsetValue.textContent = `${this.lumen.tipYoffset.toFixed(1)}mm`;
            if (zOffsetValue) zOffsetValue.textContent = `${this.lumen.zOffset.toFixed(1)}mm`;

            const togglePadsButton = document.getElementById('vizTogglePads');
            togglePadsButton?.classList.toggle('active', this.showPadOverlay);

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

        if(isFiducial){
            newDiv.innerHTML = `
            <span class="position-text">Fiducial: X:${writtenX} Y:${writtenY} Z:${position.z}</span>
            <div class="button-group">
                <button class="move-btn">☉</button>
                <button class="remove-btn">X</button>
            </div>
        `;
        }
        else{
            newDiv.innerHTML = `
            <span class="position-text">Position: X:${writtenX} Y:${writtenY} Z:${position.z}</span>
            <div class="button-group">
                <button class="move-btn">☉</button>
                ${dispenseButton}
                <button class="remove-btn">X</button>
            </div>
        `;
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
    // Shared by slice() (the full job) and dispenseSinglePoint() (a manual
    // one-off re-dispense) so they can't drift apart from each other.
    // "{VACUUM}" is substituted with the live air-assist PWM value at send
    // time (see run()) rather than baked in here, so the slider can retune it
    // mid-job.
    pointDispenseCommands(point){
        let x = point.x;
        let y = point.y;

        if(point.calX != null){
            x = point.calX;
        }

        if(point.calY != null){
            y = point.calY;
        }

        const z = point.z + this.lumen.zOffset;

        // Gerber-imported points may carry their own pad-size-scaled dispense
        // amount; manually captured points fall back to the global setting.
        const dispenseDeg = point.dispenseDegrees != null ? point.dispenseDegrees : parseFloat(this.dispenseDegrees);

        // Positive B extrudes on this auger; invert direction if invertDispense is enabled
        const dispenseSign = this.invertDispense ? -1 : 1;

        const commands = [
            `G0 X${x + this.lumen.tipXoffset} Y${y + this.lumen.tipYoffset} F${this.motionSpeed}`, // Move over
            `G0 Z${z}`,                                    // Move z down
            "G91",                                         // Relative mode
            "M106 P2 S{VACUUM}",                            // Pump on (speed substituted live at send time)
            "G0 Z-.9",                                      // Come up .9mm
            "M906 B {MOTOR_CURRENT}",                       // Extruder current high (substituted live at send time)
            `G0 B${dispenseSign * dispenseDeg} F${this.extruderSpeed}`, // Extrude paste
            "G0 Z.7",                                       // Come down .7mm
        ];

        // Wiggle the tip up/down to help release paste stuck to the nozzle
        for (let i = 0; i < 4; i++) {
            commands.push("G0 Z-.5", "G0 Z.3");
        }

        commands.push(
            "G90",                                          // Absolute mode
            `G0 Z${this.travelHeight} F${this.motionSpeed}`, // Move to safe Z
        );

        return commands;
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

        for(const point of this.placements) {
            // Skipped by a component/type group checkbox in the Job Positions
            // list, so this run only pastes the parts that are still enabled.
            if (point.enabled === false) continue;

            commands.push(...this.pointDispenseCommands(point));
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

    // Parks the head, kills both pumps, and drops the extruder current back down.
    // Shared by every way a job run can end (finished, cancelled via the toast) so
    // the board is always left in the same state instead of each path improvising.
    async finishRun(){
        this.isRunning = false;
        this.toast.receivedInput = false;
        this.toast.hide();

        await this.lumen.serial.send(["G90"]);
        await this.lumen.serial.send(["M906 B 200"]);
        await this.lumen.serial.send(["M107 P2"]);
        await this.lumen.serial.send(["M107 P3"]);
        await this.lumen.serial.send([`G0 Z${this.travelHeight} F10000`]);
        await this.lumen.serial.send(["G0 X5 Y5"]);
        await this.lumen.serial.send(["G0 F35000"]);
    }

    // slices and executes a job
    async run(){

        let commands = this.slice()

        this.toast.show("Running job. Close this to cancel.");

        this.isRunning = true;

        for(const command of commands){

            console.log(this.toast.receivedInput)

            if(this.toast.toastObject.style.display == "none"){
                await this.finishRun();
                return;
            }

            // Substitute the current air assist level at send time so the slider
            // can retune the pump speed live while the job is running. Stored as
            // a 0-100 percentage; the firmware wants a 0-255 PWM value.
            const vacuumPwm = Math.round(this.vacuumPressure / 100 * 255);
            const resolvedCommand = command.replace("{VACUUM}", vacuumPwm).replace("{MOTOR_CURRENT}", this.motorCurrent);

            const sendOk = await this.lumen.serial.send([resolvedCommand]);

            // send() returns false (instead of throwing) when the port drops mid-job.
            // Stop here rather than blasting through the rest of the commands, which
            // would otherwise fire a "Cannot Write" prompt for every remaining line.
            // The board is already unreachable, so skip the parking gcode - it would
            // just fail the same way and spam another round of error modals.
            if (!sendOk) {
                console.warn("Job stopped: lost connection to the board.");
                this.isRunning = false;
                this.toast.receivedInput = false;
                this.toast.hide();
                return;
            }

        }

        await this.finishRun();

    }


    export() {
        const data = {
            placements: this.placements.map(p => ({
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
                enabled: p.enabled
            })),
            boardOutline: this.boardOutline,
            padShapes: this.padShapes,
            showPadOverlay: this.showPadOverlay,
            fiducials: this.fiducials.map(f => ({
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
            dispenseDegrees: this.dispenseDegrees,
            motionSpeed: this.motionSpeed,
            extruderSpeed: this.extruderSpeed,
            vacuumPressure: this.vacuumPressure,
            motorCurrent: this.motorCurrent,
            travelHeight: this.travelHeight,
            preGcode: this.preGcode,
            postGcode: this.postGcode,
            invertDispense: this.invertDispense,
            tipXoffset: this.lumen.tipXoffset,
            tipYoffset: this.lumen.tipYoffset,
            zOffset: this.lumen.zOffset
        };
        return JSON.stringify(data, null, 2);
    }

    // performs a linear transformation on all placement points based on three fiducial points
    // realFids should be an array of three [x,y] coordinates representing where the fiducials actually are
    transformPlacements(realFids) {
        // Get the original fiducial positions from our job
        const origFids = [
            [this.fiducials[0].x, this.fiducials[0].y],
            [this.fiducials[1].x, this.fiducials[1].y],
            [this.fiducials[2].x, this.fiducials[2].y]
        ]

        const matrix = fromTriangles(origFids, realFids);

        for (let point of this.placements) {

            let transformedPoint = applyToPoint(matrix, [point.x, point.y])

            point.calX = transformedPoint[0];
            point.calY = transformedPoint[1];

        }

    }

}
