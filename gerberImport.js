import {parse} from '@tracespace/parser'
import {unzipSync} from 'fflate'

// ---- Tunable constants -----------------------------------------------------
// These are engineering defaults, not measured/calibrated values - they're a
// reasonable starting point and are meant to be tuned once you see real
// dispense results on your machine/paste/nozzle combo.

// A 0402 pad is nominally about 0.6mm x 0.6mm; 30 degrees of auger rotation is
// the known-good dispense for a pad that size, so every other pad size scales
// its dispense degrees off this reference.
export const NOMINAL_0402_PAD_AREA_MM2 = 0.36
export const NOMINAL_0402_DISPENSE_DEGREES = 30
export const MIN_DISPENSE_DEGREES = 3
export const MAX_DISPENSE_DEGREES = 300

// Real-world radius a dispensed dot's drawn indicator represents, scaled by
// dispense degrees (see placementDotRadiusMm). Lives here rather than in
// job.js (which also uses it, for the on-canvas dot) so planPadDispense's own
// edge-clearance math (see the tight-pitch stagger block below) reasons about
// the exact same dot size the UI shows, not a separate guess.
export const PLACEMENT_DOT_REFERENCE_RADIUS_MM = 0.15

export function placementDotRadiusMm(dispenseDegrees) {
    const degrees = Math.max(dispenseDegrees, 0.01)
    return PLACEMENT_DOT_REFERENCE_RADIUS_MM * Math.sqrt(degrees / NOMINAL_0402_DISPENSE_DEGREES)
}

// A pad is "elongated" (gets a line of dots instead of one dot) once its
// length:width ratio and absolute length clear both of these. Lowered from an
// earlier 1.2mm floor - IC gull-wing leads (SOIC/TSOP/QFP) are frequently
// shorter than that and were collapsing to a single dot.
//
// These (through STAGGER_OFFSET_FRACTION/TIGHT_PITCH_VOLUME_MULTIPLIER below)
// are `let`, not `const` - they're exposed as the Advanced Settings tab's
// normal/grid/stagger paste tuning (see getPasteDispenseSettings/
// setPasteDispenseSettings at the bottom of this section), and every
// function below reads the live module binding each time it runs, so a
// setPasteDispenseSettings() call takes effect on the next gerber import
// with no other wiring needed.
export let ELONGATED_ASPECT_RATIO = 2.2
export let ELONGATED_MIN_LENGTH_MM = 0.6

// But below this width, a pad is too "fine" to usefully split into multiple
// dots - the deposits would just merge into each other (or the tip can't
// resolve them at all) - so it stays a single dot no matter how long it is.
export let MIN_LINE_WIDTH_MM = 0.3

// Elongated pads get a bit more total paste than the flat area formula alone
// would give them - a long thin lead needs enough paste along its whole
// length to wet properly, not just "area equivalent" to a square pad.
export let ELONGATED_VOLUME_MULTIPLIER = 1.3

// Spacing between dots along a line, and how far dots stay inset from the
// pad's edge so paste doesn't get squeezed out past the pad. 0.15 put the two
// dots on a short-but-still-"line" pad (e.g. a SOT-23 leg, ~1.5mm long) right
// at the tips - only 0.15mm from the edge, well inside where a dispensed
// blob's own spread reaches past the copper. 0.3 keeps every line pattern's
// dots noticeably more inset regardless of pad length, not just this board's
// specific parts.
export let DOT_PITCH_MM = 0.9
export let PAD_EDGE_INSET_MM = 0.3

// Grid dots (see POWER_PAD_MIN_AREA_MM2 below) use a tighter pitch than a
// line does, for even coverage across a big open thermal/power pad. Each
// dot's own share of the pad's total volume is no longer capped by splitting
// a pad-wide ceiling across however many dots this pitch produces (see
// totalDispenseDegreesForPad/clampDotDegrees) - so a tighter pitch here now
// means more, still-appropriately-sized dots instead of more, thinner ones.
export let GRID_DOT_PITCH_MM = 1.5

// Grid pads use a bigger edge inset than PAD_EDGE_INSET_MM: a grid's outer
// ring of dots sits close to the pad edge on two axes at once (not just one,
// like a line pattern), so a spread-out deposit there is much more likely to
// squeeze past the copper. Pulling the whole grid in tighter keeps every
// dot's spread within the pad while leaving the per-dot volume (and dot
// count) unchanged.
export let GRID_EDGE_INSET_MM = 0.8

// A pad this big (e.g. a QFN/thermal power pad) gets a grid of dots instead
// of a single deposit.
export let POWER_PAD_MIN_AREA_MM2 = 4.0

// Pads whose nearest-neighbor edge-to-edge gap is under this are treated as
// fine-pitch (TSOP/QFP/SOIC-style, i.e. gull-wing IC leads sitting in a tight
// row). See planPadDispense() for what that changes.
export let TIGHT_PITCH_GAP_MM = 0.35

// A pad wider than this is never treated as a fine-pitch lead, no matter how
// close its neighbor sits - real QFP/SOIC/TSOP leads are rarely wider than
// ~0.6mm, so this comfortably covers them while excluding chunky power/tab
// pads (1mm+) that can legitimately sit just as close to a neighbor.
export let TIGHT_PITCH_MAX_PAD_WIDTH_MM = 1.0

// A tight-pitch pad's single stagger dot is nudged along the pad's own long
// axis by this fraction of the pad's own half-length, so it stays inside the
// pad's copper. Kept under 1.0 so the dot can't land past the pad edge.
export let STAGGER_OFFSET_FRACTION = 0.85

// Extra multiplier on a tight-pitch (staggered) pad's own dispense volume,
// on top of whatever ELONGATED_VOLUME_MULTIPLIER already gave it - fine-pitch
// leads are the pads most prone to solder bridging, so this is the lever for
// dialing volume down (or up) on just that pad population without touching
// every other pad's dispense math. 1.0 = no change from the normal/elongated
// volume.
export let TIGHT_PITCH_VOLUME_MULTIPLIER = 0.2

// Pads within this Y distance of each other are considered the same "row"
// when sorting into a deterministic raster (bottom-to-top, left-to-right).
export const ROW_TOLERANCE_MM = 1.0

// Fallback-only: on a board with no %TO.C% component attributes at all (see
// groupPadsByComponent), pads this close - row/column-aligned edge-to-edge,
// same test as tight-pitch neighbors but more permissive - are clustered
// into one synthetic "component" purely from geometry, so the Job Positions
// list still gets a collapsible per-part breakdown instead of one flat list
// of every pad. Kept fairly tight rather than generous: single-linkage
// clustering chains transitively (A-B close, B-C close => A and C cluster
// together even if far apart), so a too-generous threshold on a densely
// packed board can walk pad-to-pad across totally unrelated components and
// merge a big chunk of the board into one group - measured on a real densely
// packed board, 2.0mm did exactly that (a 40-pad connector legitimately
// clustering alone at every threshold up to 1.5mm ballooned to 61 pads,
// absorbing unrelated nearby parts, right as the threshold crossed 2.0mm).
export const COMPONENT_CLUSTER_GAP_MM = 1.0

// A "candidate fiducial" (a mask opening with no paste under it - see
// findFiducialCandidates()) this close to a drilled hole is treated as the
// same physical feature (a through-hole pin/via/mounting hole), not a
// fiducial - real SMD fiducial marks are never drilled. Looser than the
// paste/mask dedup tolerance since a drill file's coordinate format is
// occasionally lower-precision than the gerber's.
export const FIDUCIAL_DRILL_MATCH_TOLERANCE_MM = 0.08

// A real SMD fiducial mark is always round and small (help.html tells users
// to use 1mm-diameter fiducials); a mask opening outside this diameter range
// is essentially always some other exposed-but-unpasted pad - a ground/
// thermal tab, shield land, test point, mounting pad, etc - not a fiducial,
// even after it's already passed the drill/repeating-array filters above.
// Wide around the documented 1mm to tolerate boards that don't use exactly
// that size - a real board's fiducials measured right at the original 2.0mm
// upper bound, meaning any board with even slightly larger ones would have
// had real fiducials rejected here, so this leaves much more headroom on
// both ends now. See isFiducialCandidateShape() below for the accompanying
// round-only shape check.
export const FIDUCIAL_CANDIDATE_MIN_DIAMETER_MM = 0.25
export const FIDUCIAL_CANDIDATE_MAX_DIAMETER_MM = 3.0

// Candidates this close together (same row/column) are grouped when checking
// for a repeating array (see excludeRepeatingArrayCandidates()).
export const REPEATING_ARRAY_GROUP_TOLERANCE_MM = 0.02

// Consecutive gaps within this much of each other count as "the same
// spacing" - i.e. an evenly-pitched row, like a connector or header.
export const REPEATING_ARRAY_GAP_TOLERANCE_MM = 0.05
// -----------------------------------------------------------------------------

// Snapshot of the tunables above's factory values, taken once at module load
// (before setPasteDispenseSettings() can ever mutate them) - lets the
// Advanced Settings tab offer a "Reset to defaults" action.
const DEFAULT_PASTE_DISPENSE_SETTINGS = Object.freeze({
    elongatedAspectRatio: ELONGATED_ASPECT_RATIO,
    elongatedMinLengthMm: ELONGATED_MIN_LENGTH_MM,
    minLineWidthMm: MIN_LINE_WIDTH_MM,
    elongatedVolumeMultiplier: ELONGATED_VOLUME_MULTIPLIER,
    dotPitchMm: DOT_PITCH_MM,
    padEdgeInsetMm: PAD_EDGE_INSET_MM,
    gridDotPitchMm: GRID_DOT_PITCH_MM,
    gridEdgeInsetMm: GRID_EDGE_INSET_MM,
    powerPadMinAreaMm2: POWER_PAD_MIN_AREA_MM2,
    tightPitchGapMm: TIGHT_PITCH_GAP_MM,
    tightPitchMaxPadWidthMm: TIGHT_PITCH_MAX_PAD_WIDTH_MM,
    staggerOffsetFraction: STAGGER_OFFSET_FRACTION,
    tightPitchVolumeMultiplier: TIGHT_PITCH_VOLUME_MULTIPLIER,
})

// Reads the live values of every pad-dispense tunable above, for populating
// the Advanced Settings tab's inputs (and for saving them with a job file -
// see Job.export()/importFromFile() in job.js).
export function getPasteDispenseSettings() {
    return {
        elongatedAspectRatio: ELONGATED_ASPECT_RATIO,
        elongatedMinLengthMm: ELONGATED_MIN_LENGTH_MM,
        minLineWidthMm: MIN_LINE_WIDTH_MM,
        elongatedVolumeMultiplier: ELONGATED_VOLUME_MULTIPLIER,
        dotPitchMm: DOT_PITCH_MM,
        padEdgeInsetMm: PAD_EDGE_INSET_MM,
        gridDotPitchMm: GRID_DOT_PITCH_MM,
        gridEdgeInsetMm: GRID_EDGE_INSET_MM,
        powerPadMinAreaMm2: POWER_PAD_MIN_AREA_MM2,
        tightPitchGapMm: TIGHT_PITCH_GAP_MM,
        tightPitchMaxPadWidthMm: TIGHT_PITCH_MAX_PAD_WIDTH_MM,
        staggerOffsetFraction: STAGGER_OFFSET_FRACTION,
        tightPitchVolumeMultiplier: TIGHT_PITCH_VOLUME_MULTIPLIER,
    }
}

// Applies any of the fields above that are present in `settings` (missing
// fields are left untouched, so a partial update - or an older saved job file
// missing newer fields - doesn't reset the rest back to defaults). Every
// classify/plan function above reads these module bindings directly each
// time it runs, so this takes effect on the very next gerber import with no
// other plumbing needed.
export function setPasteDispenseSettings(settings) {
    if (settings.elongatedAspectRatio != null) ELONGATED_ASPECT_RATIO = settings.elongatedAspectRatio
    if (settings.elongatedMinLengthMm != null) ELONGATED_MIN_LENGTH_MM = settings.elongatedMinLengthMm
    if (settings.minLineWidthMm != null) MIN_LINE_WIDTH_MM = settings.minLineWidthMm
    if (settings.elongatedVolumeMultiplier != null) ELONGATED_VOLUME_MULTIPLIER = settings.elongatedVolumeMultiplier
    if (settings.dotPitchMm != null) DOT_PITCH_MM = settings.dotPitchMm
    if (settings.padEdgeInsetMm != null) PAD_EDGE_INSET_MM = settings.padEdgeInsetMm
    if (settings.gridDotPitchMm != null) GRID_DOT_PITCH_MM = settings.gridDotPitchMm
    if (settings.gridEdgeInsetMm != null) GRID_EDGE_INSET_MM = settings.gridEdgeInsetMm
    if (settings.powerPadMinAreaMm2 != null) POWER_PAD_MIN_AREA_MM2 = settings.powerPadMinAreaMm2
    if (settings.tightPitchGapMm != null) TIGHT_PITCH_GAP_MM = settings.tightPitchGapMm
    if (settings.tightPitchMaxPadWidthMm != null) TIGHT_PITCH_MAX_PAD_WIDTH_MM = settings.tightPitchMaxPadWidthMm
    if (settings.staggerOffsetFraction != null) STAGGER_OFFSET_FRACTION = settings.staggerOffsetFraction
    if (settings.tightPitchVolumeMultiplier != null) TIGHT_PITCH_VOLUME_MULTIPLIER = settings.tightPitchVolumeMultiplier
}

export function resetPasteDispenseSettings() {
    setPasteDispenseSettings(DEFAULT_PASTE_DISPENSE_SETTINGS)
    return getPasteDispenseSettings()
}

// Accepts a FileList/array. If it's a single .zip, unzips it (typical fab
// output bundle from KiCad/JLCPCB/EasyEDA); otherwise treats every selected
// file as a loose gerber.
export async function expandFileSelection(fileList) {
    const files = Array.from(fileList)

    if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
        const buffer = new Uint8Array(await files[0].arrayBuffer())
        const entries = unzipSync(buffer)

        return Object.entries(entries)
            .filter(([name, data]) => !name.endsWith('/') && data.length > 0)
            .map(([name, data]) => ({
                name: name.split('/').pop(),
                text: new TextDecoder().decode(data)
            }))
    }

    return Promise.all(files.map(async file => ({name: file.name, text: await file.text()})))
}

// KiCad, Altium, and EasyEDA all emit the Gerber X2 %TF.FileFunction% attribute
// on modern exports, so we can identify a layer from its own content instead of
// guessing per-vendor filename conventions. Falls back to filename heuristics
// for older exports that don't include it.
function classifyFile(name, tree) {
    let fileFunction = null

    for (const child of tree.children) {
        // Standalone %TF.FileFunction,...*% attributes come through as 'unimplemented'
        // nodes, but Altium (and some other tools) instead embed the same attribute in
        // an X1-compatible extended comment - `G04 #@! TF.FileFunction,...*` - which the
        // parser reports as a plain 'comment' node. Check both.
        if (child.type === 'unimplemented' && typeof child.value === 'string' && child.value.includes('TF.FileFunction')) {
            fileFunction = child.value
            break
        }
        if (child.type === 'comment' && typeof child.comment === 'string' && child.comment.includes('TF.FileFunction')) {
            fileFunction = child.comment
            break
        }
    }

    if (fileFunction) {
        const isBottom = /,\s*Bot(tom)?\b/i.test(fileFunction)
        if (/FileFunction,\s*Paste/i.test(fileFunction)) return {kind: 'paste', side: isBottom ? 'bottom' : 'top'}
        if (/FileFunction,\s*Soldermask/i.test(fileFunction)) return {kind: 'mask', side: isBottom ? 'bottom' : 'top'}
        // "Profile" is the board outline/edge-cuts layer; NP/P (non-plated/plated
        // edge routing) is irrelevant to us, just the shape.
        if (/FileFunction,\s*Profile/i.test(fileFunction)) return {kind: 'outline', side: null}
        return {kind: 'other', side: null}
    }

    const lower = name.toLowerCase()
    const isBottom = /(^|[^a-z])(bot|bottom)([^a-z]|$)/.test(lower) || /\.(gbp|gbs)$/.test(lower)

    if (lower.includes('paste') || /\.gtp$/.test(lower) || /\.gbp$/.test(lower)) {
        return {kind: 'paste', side: isBottom ? 'bottom' : 'top'}
    }
    if (lower.includes('mask') || /\.gts$/.test(lower) || /\.gbs$/.test(lower)) {
        return {kind: 'mask', side: isBottom ? 'bottom' : 'top'}
    }
    if (/(^|[^a-z])(edge[._-]?cuts?|outline|profile|board[._-]?outline)([^a-z]|$)/.test(lower) ||
        /\.(gm1|gko|gml)$/.test(lower)) {
        return {kind: 'outline', side: null}
    }

    return {kind: 'other', side: null}
}

// Resolves a macro primitive parameter, which may be a literal number, a
// variable reference ($1, $2, ...) filled in from the aperture's ADD command,
// or an arithmetic expression combining either.
function evalMacroValue(value, variableValues) {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
        const match = /^\$(\d+)$/.exec(value)
        return match ? (variableValues[Number(match[1]) - 1] ?? 0) : 0
    }
    if (value && typeof value === 'object' && 'operator' in value) {
        const left = evalMacroValue(value.left, variableValues)
        const right = evalMacroValue(value.right, variableValues)
        switch (value.operator) {
            case '+': return left + right
            case '-': return left - right
            case 'x': return left * right
            case '/': return left / right
        }
    }
    return 0
}

function rotatedRectBounds(cx, cy, w, h, rotationDeg) {
    const rad = (rotationDeg || 0) * Math.PI / 180
    const hw = w / 2, hh = h / 2
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
        const rx = cx + x * Math.cos(rad) - y * Math.sin(rad)
        const ry = cy + x * Math.sin(rad) + y * Math.cos(rad)
        minX = Math.min(minX, rx); maxX = Math.max(maxX, rx)
        minY = Math.min(minY, ry); maxY = Math.max(maxY, ry)
    }
    return {minX, minY, maxX, maxY}
}

// Computes the overall (axis-aligned) bounding box of a macro aperture by
// unioning the bounds of its primitives - circles, center-line rects, and
// vector lines, which covers the vast majority of real pad macros (e.g.
// Altium's rounded-rectangle pads). Outline/polygon/moire/thermal primitives
// aren't modeled; if the macro is built entirely from those, this returns
// null and the caller falls back to a nominal dot rather than guessing wrong.
function macroShapeBounds(macroChildren, variableValues) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let found = false

    for (const prim of macroChildren) {
        if (prim.type !== 'macroPrimitive') continue
        const p = prim.parameters.map(v => evalMacroValue(v, variableValues))
        let bounds = null

        if (prim.code === '1') {
            // circle: exposure, diameter, centerX, centerY
            const [, diameter, cx = 0, cy = 0] = p
            const r = diameter / 2
            bounds = {minX: cx - r, maxX: cx + r, minY: cy - r, maxY: cy + r}
        } else if (prim.code === '21') {
            // center line: exposure, width, height, centerX, centerY, rotation
            const [, width, height, cx = 0, cy = 0, rotation = 0] = p
            bounds = rotatedRectBounds(cx, cy, width, height, rotation)
        } else if (prim.code === '20' || prim.code === '2') {
            // vector line: exposure, width, startX, startY, endX, endY, rotation
            const [, width, x1, y1, x2, y2, rotation = 0] = p
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
            const length = Math.hypot(x2 - x1, y2 - y1)
            const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI
            bounds = rotatedRectBounds(cx, cy, length, width, angle + rotation)
        }

        if (bounds) {
            minX = Math.min(minX, bounds.minX); maxX = Math.max(maxX, bounds.maxX)
            minY = Math.min(minY, bounds.minY); maxY = Math.max(maxY, bounds.maxY)
            found = true
        }
    }

    return found ? {xSize: maxX - minX, ySize: maxY - minY} : null
}

// Turns a tool (aperture) definition into pad geometry in mm, including an
// approximate area used for dispense-volume scaling.
function padFromTool(x, y, tool, macros) {
    if (!tool) {
        // A flash before any tool was selected means a malformed file - fall
        // back to a nominal small pad rather than losing the point.
        return {x, y, shape: 'unknown', xSize: 0.3, ySize: 0.3, diameter: 0.3, area: NOMINAL_0402_PAD_AREA_MM2}
    }

    if (tool.type === 'circle') {
        const d = tool.diameter
        return {x, y, shape: 'circle', xSize: d, ySize: d, diameter: d, area: Math.PI * (d / 2) ** 2}
    }

    if (tool.type === 'rectangle') {
        const {xSize, ySize} = tool
        return {x, y, shape: 'rectangle', xSize, ySize, diameter: null, area: xSize * ySize}
    }

    if (tool.type === 'obround') {
        const {xSize, ySize} = tool
        const r = Math.min(xSize, ySize) / 2
        // Stadium shape: rectangle area minus the square the rounded ends replace, plus the circle they form.
        const area = xSize * ySize - (2 * r) ** 2 + Math.PI * r ** 2
        return {x, y, shape: 'obround', xSize, ySize, diameter: null, area}
    }

    if (tool.type === 'polygon') {
        const d = tool.diameter
        return {x, y, shape: 'polygon', xSize: d, ySize: d, diameter: d, area: Math.PI * (d / 2) ** 2}
    }

    if (tool.type === 'macroShape') {
        const macroChildren = macros?.get(tool.name)
        const bounds = macroChildren ? macroShapeBounds(macroChildren, tool.variableValues || []) : null
        if (bounds && bounds.xSize > 0 && bounds.ySize > 0) {
            const {xSize, ySize} = bounds
            return {x, y, shape: 'rectangle', xSize, ySize, diameter: null, area: xSize * ySize}
        }
    }

    // Anything else we don't model (or a macro shape we couldn't resolve): we
    // don't know its true silhouette, so treat it as a nominal dot rather than
    // guessing wrong.
    return {x, y, shape: 'unknown', xSize: 0.3, ySize: 0.3, diameter: 0.3, area: NOMINAL_0402_PAD_AREA_MM2}
}

// Extracts the component refdes a %TO.C,<refdes>*% (or its X1-comment
// equivalent, `G04 #@! TO.C,<refdes>*`) attribute node carries, or 'TD' if
// the node is the matching attribute-delete that clears it back to null.
function refdesAttribute(child) {
    const text = child.type === 'unimplemented' && typeof child.value === 'string' ? child.value
        : child.type === 'comment' && typeof child.comment === 'string' ? child.comment
        : null
    if (!text) return null

    const refdesMatch = /TO\.C,\s*([^*]+)/.exec(text)
    if (refdesMatch) return {refdes: refdesMatch[1].trim()}
    if (/(^|[^A-Z])TD\b/.test(text)) return {refdes: null}
    return null
}

// Walks a parsed gerber tree, linking each flash (D03) to its active aperture
// so we get real pad geometry, not just bare center points. Also tracks the
// %TO.C,<refdes>% component attribute KiCad/Altium/EasyEDA write ahead of a
// component's flashes (cleared by the matching TD), so each pad can be
// grouped by the part it belongs to - see groupPadsByComponent().
function extractPads(tree) {
    let decimalScale = 1000000
    let unitScale = 1
    let lastX = NaN
    let lastY = NaN
    const tools = new Map()
    const macros = new Map()
    let activeTool = null
    let activeRefdes = null
    const pads = []

    for (const child of tree.children) {
        if (child.type === 'units') {
            unitScale = child.units === 'in' ? 25.4 : 1
        } else if (child.type === 'coordinateFormat') {
            if (child.format) decimalScale = Math.pow(10, child.format[1])
        } else if (child.type === 'toolMacro') {
            macros.set(child.name, child.children)
        } else if (child.type === 'toolDefinition') {
            tools.set(child.code, child.shape)
        } else if (child.type === 'toolChange') {
            activeTool = tools.get(child.code) || null
        } else if (child.type === 'comment' || child.type === 'unimplemented') {
            const attr = refdesAttribute(child)
            if (attr) activeRefdes = attr.refdes
        } else if (child.type === 'graphic') {
            // Gerber coordinates are modal across every graphic op, not just flashes -
            // e.g. Altium commonly writes a separate move (D02) that sets position,
            // then a flash (D03) with no coordinates of its own that inherits it. Track
            // the running position from moves/segments too, or flashes like that would
            // never resolve to a real point.
            const rawX = child.coordinates.x !== undefined ? Number(child.coordinates.x) : NaN
            const rawY = child.coordinates.y !== undefined ? Number(child.coordinates.y) : NaN

            const resolvedX = Number.isNaN(rawX) ? lastX : rawX
            const resolvedY = Number.isNaN(rawY) ? lastY : rawY

            if (!Number.isNaN(rawX)) lastX = rawX
            if (!Number.isNaN(rawY)) lastY = rawY

            if (child.graphic === 'shape') {
                if (Number.isNaN(resolvedX) || Number.isNaN(resolvedY)) continue

                const x = resolvedX / decimalScale * unitScale
                const y = resolvedY / decimalScale * unitScale

                pads.push({...padFromTool(x, y, activeTool, macros), refdes: activeRefdes})
            }
        }
    }

    return pads
}

// Tessellates a gerber arc segment (start -> end, sweeping around a center
// given as start-relative I/J offsets, per spec) into short line segments,
// since the canvas outline renderer just draws straight strokes.
function tessellateArc(x1, y1, x2, y2, cx, cy, clockwise, stepsPerFullCircle = 32) {
    const r = Math.hypot(x1 - cx, y1 - cy)
    const a1 = Math.atan2(y1 - cy, x1 - cx)
    let a2 = Math.atan2(y2 - cy, x2 - cx)

    if (clockwise) {
        if (a2 >= a1) a2 -= 2 * Math.PI
    } else {
        if (a2 <= a1) a2 += 2 * Math.PI
    }

    const steps = Math.max(1, Math.round(stepsPerFullCircle * Math.abs(a2 - a1) / (2 * Math.PI)))
    const segments = []
    let prevX = x1, prevY = y1
    for (let i = 1; i <= steps; i++) {
        const a = a1 + (a2 - a1) * (i / steps)
        const x = cx + r * Math.cos(a)
        const y = cy + r * Math.sin(a)
        segments.push({x1: prevX, y1: prevY, x2: x, y2: y})
        prevX = x; prevY = y
    }
    return segments
}

// Board outline layers (KiCad Edge_Cuts, Altium/Gerber "Profile") are drawn as
// a collection of independent line/arc graphic shapes rather than flashes, and
// - at least from KiCad - not even as one continuous path (each edge gets its
// own move+draw). We don't need path connectivity to render it though: just
// collect every individual segment and stroke them all.
function extractOutline(tree) {
    let decimalScale = 1000000
    let unitScale = 1
    let mode = 'line'
    let curX = 0, curY = 0
    const segments = []

    for (const child of tree.children) {
        if (child.type === 'units') {
            unitScale = child.units === 'in' ? 25.4 : 1
        } else if (child.type === 'coordinateFormat') {
            if (child.format) decimalScale = Math.pow(10, child.format[1])
        } else if (child.type === 'interpolateMode') {
            mode = child.mode
        } else if (child.type === 'graphic' && (child.graphic === 'move' || child.graphic === 'segment')) {
            const rawX = child.coordinates.x !== undefined ? Number(child.coordinates.x) : undefined
            const rawY = child.coordinates.y !== undefined ? Number(child.coordinates.y) : undefined
            const x = rawX !== undefined ? rawX / decimalScale * unitScale : curX
            const y = rawY !== undefined ? rawY / decimalScale * unitScale : curY

            if (child.graphic === 'segment') {
                if (mode === 'cwArc' || mode === 'ccwArc') {
                    const rawI = child.coordinates.i !== undefined ? Number(child.coordinates.i) : 0
                    const rawJ = child.coordinates.j !== undefined ? Number(child.coordinates.j) : 0
                    const cx = curX + rawI / decimalScale * unitScale
                    const cy = curY + rawJ / decimalScale * unitScale
                    segments.push(...tessellateArc(curX, curY, x, y, cx, cy, mode === 'cwArc'))
                } else {
                    segments.push({x1: curX, y1: curY, x2: x, y2: y})
                }
            }

            curX = x; curY = y
        }
    }

    return segments
}

// Excellon drill files are used for exactly one thing here: telling a real
// SMD fiducial mark (never drilled) apart from a through-hole pin/via/mount
// hole that happens to have no paste either (see findFiducialCandidates()).
// Excellon's coordinate format is notoriously inconsistent across tools, so
// this only trusts formats it can identify with confidence - a literal
// decimal point in a coordinate (self-describing, e.g. modern KiCad's
// "Decimal format" output) or an explicit ";FILE_FORMAT=I:D" header comment
// (JLCPCB/EasyEDA). Returns null rather than guess when neither is present,
// so an unrecognized dialect just falls back to skipping this filter instead
// of risking wrong hole positions.
function parseDrillHoles(text) {
    const isInch = /\bINCH\b/i.test(text) && !/\bMETRIC\b/i.test(text)
    const hasDecimalPoints = /[XY]-?\d*\.\d+/.test(text)

    let decimalPlaces = null
    const formatMatch = text.match(/FILE_FORMAT[=,](\d+)[:.](\d+)/i)
    if (formatMatch) decimalPlaces = Number(formatMatch[2])

    if (!hasDecimalPoints && decimalPlaces === null) return null

    const unitScale = isInch ? 25.4 : 1
    const holes = []
    let lastX = 0, lastY = 0
    const tokenPattern = /([XY])(-?\d+\.?\d*)/g

    for (const line of text.split(/\r?\n/)) {
        let x = null, y = null, match
        tokenPattern.lastIndex = 0
        while ((match = tokenPattern.exec(line))) {
            const [, axis, raw] = match
            const value = raw.includes('.') ? Number(raw) * unitScale : Number(raw) / (10 ** decimalPlaces) * unitScale
            if (axis === 'X') x = value; else y = value

            // A slot ("Gxx" between two coordinate pairs on one line) has two
            // full pairs on the same line - emit each pair as soon as it's
            // complete instead of only keeping the last one.
            if (x !== null && y !== null) {
                holes.push({x, y})
                lastX = x; lastY = y
                x = null; y = null
            }
        }
        // A lone axis token with the other carried over (modal, some dialects
        // allow omitting an unchanged axis).
        if (x !== null || y !== null) {
            holes.push({x: x ?? lastX, y: y ?? lastY})
            lastX = x ?? lastX; lastY = y ?? lastY
        }
    }

    return holes
}

// A cheap, content-based check for whether a file is an Excellon drill file -
// filenames for these vary a lot more across fabs (.drl/.xln/.txt/.tap) than
// gerber layers do, but every dialect starts its header with M48.
function looksLikeDrillFile(name, text) {
    return /^\s*M48\b/im.test(text) || /\.(drl|xln)$/i.test(name)
}

// Drops any point that's part of an evenly-pitched row or column of 3+
// points - a connector, header, or card-edge finger array, not fiducials
// (which are always isolated). Used alongside drill-hole exclusion in
// findFiducialCandidates() to cut down false positives on boards without
// Gerber X2 metadata to identify fiducials more directly.
function excludeRepeatingArrayPoints(points, groupTolerance = REPEATING_ARRAY_GROUP_TOLERANCE_MM, gapTolerance = REPEATING_ARRAY_GAP_TOLERANCE_MM) {
    const excluded = new Set()

    const markEvenRuns = (primaryAxis, secondaryAxis) => {
        const groups = []
        for (const point of points) {
            let group = groups.find(g => Math.abs(g.key - point[primaryAxis]) < groupTolerance)
            if (!group) {
                group = {key: point[primaryAxis], members: []}
                groups.push(group)
            }
            group.members.push(point)
        }

        for (const group of groups) {
            if (group.members.length < 3) continue
            const sorted = [...group.members].sort((a, b) => a[secondaryAxis] - b[secondaryAxis])
            const gaps = sorted.slice(1).map((p, i) => p[secondaryAxis] - sorted[i][secondaryAxis])

            let runStart = 0
            for (let i = 1; i <= gaps.length; i++) {
                const stillConsistent = i < gaps.length && Math.abs(gaps[i] - gaps[i - 1]) < gapTolerance
                if (!stillConsistent) {
                    if (i - runStart >= 2) for (let j = runStart; j <= i; j++) excluded.add(sorted[j])
                    runStart = i
                }
            }
        }
    }

    markEvenRuns('y', 'x')
    markEvenRuns('x', 'y')

    return points.filter(point => !excluded.has(point))
}

// True for a mask opening whose aperture is round (circle/polygon) and sized
// like a real fiducial (see FIDUCIAL_CANDIDATE_MIN/MAX_DIAMETER_MM) - false
// for a rectangular/obround pad (a test point, ground/thermal tab, shield
// land, connector pad, etc: exposed with no paste, but not a fiducial) or a
// round one outside the plausible size range. A point with no shape/diameter
// at all (e.g. hand-built rather than coming from extractPads()) passes
// through unfiltered rather than being dropped on missing data.
//
// 'unknown' (a flash extractPads() couldn't resolve a real silhouette for -
// see padFromTool) is rejected here too, deliberately: it comes with a
// synthetic placeholder diameter rather than one read off the real aperture,
// so there's no genuine size to check - happens to be small enough to always
// clear FIDUCIAL_CANDIDATE_MIN_DIAMETER_MM regardless of the flash's real
// size, which would make this check meaningless for that shape rather than
// actually filtering it. Fiducials are near-universally plain circle
// apertures in every major ECAD's gerber export, so an 'unknown' one is far
// more likely something else entirely (an unmodeled macro on an ordinary
// pad) - worth losing on a genuinely unusual board in exchange for not
// letting every 'unknown' flash through unchecked. The manual "add fiducials
// yourself" fallback (see loadGerberFiles()) covers that rare case.
function isFiducialCandidateShape(point) {
    if (point.shape == null) return true
    if (point.shape !== 'circle' && point.shape !== 'polygon') return false

    const diameter = point.diameter ?? Math.max(point.xSize ?? 0, point.ySize ?? 0)
    return diameter >= FIDUCIAL_CANDIDATE_MIN_DIAMETER_MM && diameter <= FIDUCIAL_CANDIDATE_MAX_DIAMETER_MM
}

// Narrows raw "mask opening with no paste" points down to plausible fiducial
// candidates: drops anything that coincides with a drilled hole (a real SMD
// fiducial is never drilled), anything that isn't round and fiducial-sized
// (see isFiducialCandidateShape()), and anything that's part of an
// evenly-pitched row/column of 3+ (a connector or header footprint, not
// fiducials). None of these checks need Gerber X2 metadata, so this works
// the same whether or not the board's export included component attributes.
export function findFiducialCandidates(maskOnlyPoints, drillHoles) {
    const notDrilled = drillHoles.length === 0 ? maskOnlyPoints : maskOnlyPoints.filter(point =>
        !drillHoles.some(hole =>
            Math.abs(hole.x - point.x) < FIDUCIAL_DRILL_MATCH_TOLERANCE_MM &&
            Math.abs(hole.y - point.y) < FIDUCIAL_DRILL_MATCH_TOLERANCE_MM
        )
    )

    const plausiblyShaped = notDrilled.filter(isFiducialCandidateShape)

    return excludeRepeatingArrayPoints(plausiblyShaped)
}

// Reads the selected file(s), classifies each one, and returns the paste pad
// geometry, raw mask flash points (used to spot fiducial candidates), and the
// board outline (if an Edge_Cuts/Profile layer was included).
export async function importGerberSet(fileList) {
    const files = await expandFileSelection(fileList)
    const warnings = []
    const detected = []

    let pastePads = null
    let pasteSide = null
    let maskFlashes = null
    let maskSide = null
    let outline = null
    const drillHoles = []

    for (const file of files) {
        if (/\.(pdf|csv|md|zip)$/i.test(file.name)) continue

        // Drill files aren't gerbers (Excellon, not RS-274X) and can't go
        // through the parser below - handled separately, only for the
        // fiducial-candidate filter (see findFiducialCandidates()).
        if (looksLikeDrillFile(file.name, file.text)) {
            const holes = parseDrillHoles(file.text)
            if (holes) drillHoles.push(...holes)
            continue
        }

        // Not drill content and not a gerber - e.g. a fab readme.
        if (/\.txt$/i.test(file.name)) continue

        // A full fab-output zip includes copper/silkscreen/drill layers too, and
        // those can be large (dense routing, lots of arcs/regions). Fully parsing
        // every file in the bundle to find the ones we care about is what was
        // freezing the tab on a real multi-layer board. Do a cheap raw-text/filename
        // check first and only run the real (expensive) parser on files that could
        // plausibly be a paste, mask, or outline layer.
        const looksRelevant =
            /FileFunction,\s*(Paste|Soldermask|Profile)/i.test(file.text) ||
            /paste|mask|edge[._-]?cuts?|outline|profile/i.test(file.name) ||
            /\.(gtp|gbp|gts|gbs|gm1|gko|gml)$/i.test(file.name)

        if (!looksRelevant) continue

        // Yield to the browser between files so the tab can repaint/stay responsive
        // instead of blocking the main thread through the whole import.
        await new Promise(resolve => setTimeout(resolve, 0))

        let tree
        try {
            tree = parse(file.text)
        } catch (error) {
            warnings.push(`Could not parse ${file.name}: ${error.message}`)
            continue
        }

        if (tree.filetype !== 'gerber') continue

        const {kind, side} = classifyFile(file.name, tree)
        if (kind !== 'other') detected.push(`${file.name} -> ${kind}${side ? ' (' + side + ')' : ''}`)

        if (kind === 'paste' && (pastePads === null || (pasteSide === 'bottom' && side === 'top'))) {
            pastePads = extractPads(tree)
            pasteSide = side
        } else if (kind === 'mask' && (maskFlashes === null || (maskSide === 'bottom' && side === 'top'))) {
            // Keeps shape/diameter (previously stripped down to just {x, y}) -
            // findFiducialCandidates() needs them to tell a real round fiducial
            // opening apart from an ordinary rectangular/obround pad that
            // just happens to have no paste under it.
            maskFlashes = extractPads(tree)
            maskSide = side
        } else if (kind === 'outline' && outline === null) {
            outline = extractOutline(tree)
        }
    }

    if (!pastePads) {
        throw new Error(
            "Couldn't find a paste layer in the selected file(s). " +
            (detected.length ? `Detected: ${detected.join(', ')}. ` : '') +
            'Make sure the solder paste gerber (e.g. *-F_Paste.gbr / *.GTP) is included.'
        )
    }

    if (!maskFlashes) {
        warnings.push('No solder mask layer detected - skipping automatic fiducial candidate detection.')
        maskFlashes = []
    }

    if (!outline) outline = []

    return {pastePads, maskFlashes, outline, warnings, detected, drillHoles}
}

function padLength(pad) {
    if (pad.shape === 'rectangle' || pad.shape === 'obround') return Math.max(pad.xSize, pad.ySize)
    return pad.diameter ?? Math.max(pad.xSize, pad.ySize)
}

function padWidth(pad) {
    if (pad.shape === 'rectangle' || pad.shape === 'obround') return Math.min(pad.xSize, pad.ySize)
    return pad.diameter ?? Math.min(pad.xSize, pad.ySize)
}

function padLongAxisIsX(pad) {
    return pad.xSize >= pad.ySize
}

// Resolves the "mechanics" settings planPadDispense()/totalDispenseDegreesForPad()
// use to place dots once a pad's already classified - as opposed to the
// classification thresholds in classifyPad()/tagTightPitchPads(), which stay
// board-wide for now (a pad's tight-pitch-ness depends on its neighbors,
// possibly in a different component, so classifying it per-component doesn't
// have a clean meaning yet). `overrides` is a per-component partial settings
// object (see Job.componentOverrides in job.js) - any key it doesn't set
// falls back to the board-wide Advanced Settings value.
function resolveMechanicsSettings(overrides) {
    return {
        elongatedVolumeMultiplier: overrides?.elongatedVolumeMultiplier ?? ELONGATED_VOLUME_MULTIPLIER,
        dotPitchMm: overrides?.dotPitchMm ?? DOT_PITCH_MM,
        padEdgeInsetMm: overrides?.padEdgeInsetMm ?? PAD_EDGE_INSET_MM,
        gridDotPitchMm: overrides?.gridDotPitchMm ?? GRID_DOT_PITCH_MM,
        gridEdgeInsetMm: overrides?.gridEdgeInsetMm ?? GRID_EDGE_INSET_MM,
        staggerOffsetFraction: overrides?.staggerOffsetFraction ?? STAGGER_OFFSET_FRACTION,
        tightPitchVolumeMultiplier: overrides?.tightPitchVolumeMultiplier ?? TIGHT_PITCH_VOLUME_MULTIPLIER,
    }
}

function classifyPad(pad) {
    const length = padLength(pad)
    const width = padWidth(pad)
    const aspect = width > 0 ? length / width : 1

    if ((pad.shape === 'rectangle' || pad.shape === 'obround') &&
        aspect >= ELONGATED_ASPECT_RATIO && length >= ELONGATED_MIN_LENGTH_MM &&
        width >= MIN_LINE_WIDTH_MM) {
        return 'line'
    }

    if (pad.area >= POWER_PAD_MIN_AREA_MM2) return 'grid'

    return 'point'
}

// Returns the pad's total (uncapped) area-scaled dispense volume, before it
// gets split across however many dots the pattern uses. MAX_DISPENSE_DEGREES
// is a safety/practical ceiling on one dispense ACTION, so it's applied to
// each dot's own share once the split happens (see planPadDispense), not
// here - capping the pad's total up front was quietly starving big grid pads
// split into many dots (a 16mm2 pad's 12 dots were getting 25 degrees each
// instead of the ~110 the pad's real area calls for, because the 300-degree
// ceiling was being spent once for the whole pad instead of once per dot).
function totalDispenseDegreesForPad(pad, baseDispenseDegrees, kind, mechanics) {
    let raw = baseDispenseDegrees * (pad.area / NOMINAL_0402_PAD_AREA_MM2)
    if (kind === 'line') raw *= mechanics.elongatedVolumeMultiplier
    if (pad.tightPitch) raw *= mechanics.tightPitchVolumeMultiplier
    return raw
}

function clampDotDegrees(degrees) {
    return Math.min(MAX_DISPENSE_DEGREES, Math.max(MIN_DISPENSE_DEGREES, degrees))
}

// Returns {points, pattern}: points are dispense sub-points as {dx, dy,
// dispenseDegrees} offsets (mm) from the pad center, splitting the pad's
// total (area-scaled) dispense volume across however many dots the pattern
// needs - each dot's own share is what gets clamped to
// [MIN,MAX]_DISPENSE_DEGREES, not the pad's total (see
// totalDispenseDegreesForPad). pattern is the pad's final classification
// ('dot'/'line'/'grid'/'staggered') after the tight-pitch line->dot demotion
// below - job.js stamps it onto each resulting Point as dispensePattern, for
// the Job Positions list's per-component pattern badges/overrides.
//
// `overrides` (optional) is a per-component partial settings object (see
// Job.componentOverrides) that only affects dot *placement* within whatever
// pattern classifyPad() already picked - see resolveMechanicsSettings() for
// why classification itself stays board-wide for now.
export function planPadDispense(pad, baseDispenseDegrees, staggerSign = 0, overrides = null) {
    const mechanics = resolveMechanicsSettings(overrides)
    let kind = classifyPad(pad)
    const total = totalDispenseDegreesForPad(pad, baseDispenseDegrees, kind, mechanics)
    const alongX = padLongAxisIsX(pad)

    // A gull-wing IC lead (elongated pad, normally 'line') that's sitting in a
    // tight-pitch row gets exactly one dot instead of a line of them: with
    // leads packed this close together, spreading volume along the lead's
    // length just multiplies how many deposits could bridge to the next lead
    // over. It keeps the same (elongated-scaled) total volume as a line
    // pattern would have used, just delivered as a single deposit.
    if (kind === 'line' && pad.tightPitch) kind = 'point'

    let points

    if (kind === 'line') {
        const length = padLength(pad)
        const usable = Math.max(length - 2 * mechanics.padEdgeInsetMm, 0.1)

        // Only split into multiple dots once there's a full dotPitchMm of
        // usable length to actually space them across - a pad just barely
        // over the elongated threshold clamps `usable` down near its 0.1mm
        // floor, and forcing a minimum of 2 dots there (the old
        // Math.max(2, ...)) placed them only ~0.1-0.3mm apart: well inside
        // each dot's own drawn radius, so they rendered right on top of each
        // other instead of as a real line pattern.
        // dotPitchMm > 0 guards against a zero/negative Advanced Settings
        // value (the Dot Pitch input's own min="0.1" only constrains the
        // spinner arrows, not a manually typed value) - dividing by it would
        // otherwise produce an Infinity/negative dotCount and the loop below
        // would never terminate, freezing the tab.
        const dotCount = mechanics.dotPitchMm > 0 && usable >= mechanics.dotPitchMm ? Math.round(usable / mechanics.dotPitchMm) + 1 : 1
        const spacing = dotCount > 1 ? usable / (dotCount - 1) : 0

        points = []
        for (let i = 0; i < dotCount; i++) {
            const offset = dotCount > 1 ? -usable / 2 + i * spacing : 0
            points.push({
                dx: alongX ? offset : 0,
                dy: alongX ? 0 : offset,
                dispenseDegrees: clampDotDegrees(total / dotCount)
            })
        }
    } else if (kind === 'grid') {
        // Grid dots use a tighter pitch than a line does (gridDotPitchMm <
        // dotPitchMm) - see GRID_DOT_PITCH_MM's definition for why.
        const usableX = Math.max(pad.xSize - 2 * mechanics.gridEdgeInsetMm, 0.1)
        const usableY = Math.max(pad.ySize - 2 * mechanics.gridEdgeInsetMm, 0.1)

        // As with the 'line' pattern above, only split an axis into multiple
        // dots once there's a full gridDotPitchMm of usable room on that
        // axis - a wide, flat connector/screw-terminal pad (e.g. J-type
        // parts) is big enough in area to classify as 'grid' but often has
        // one short axis that clamps down near its 0.1mm floor. Forcing a
        // minimum of 2 rows/cols there (the old Math.max(2, ...)) placed
        // that axis's two dot rows/columns only ~0.1mm apart - on top of
        // each other instead of a real grid.
        // gridDotPitchMm > 0 guards against a zero/negative Advanced
        // Settings value the same way dotPitchMm is guarded above - see
        // that comment.
        const cols = mechanics.gridDotPitchMm > 0 && usableX >= mechanics.gridDotPitchMm ? Math.round(usableX / mechanics.gridDotPitchMm) + 1 : 1
        const rows = mechanics.gridDotPitchMm > 0 && usableY >= mechanics.gridDotPitchMm ? Math.round(usableY / mechanics.gridDotPitchMm) + 1 : 1
        const stepX = cols > 1 ? usableX / (cols - 1) : 0
        const stepY = rows > 1 ? usableY / (rows - 1) : 0
        const dotCount = cols * rows

        points = []
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                points.push({
                    dx: cols > 1 ? -usableX / 2 + c * stepX : 0,
                    dy: rows > 1 ? -usableY / 2 + r * stepY : 0,
                    dispenseDegrees: clampDotDegrees(total / dotCount)
                })
            }
        }
    } else {
        points = [{dx: 0, dy: 0, dispenseDegrees: clampDotDegrees(total)}]
    }

    // Final pattern name for whoever's placing this pad's dots - 'point'
    // becomes 'staggered' once it's actually getting the alternating nudge
    // below, so job.js can tag each Point with a name that also doubles as
    // the Job Positions list's per-component pattern indicator/override key
    // (see resolveMechanicsSettings() and Job.componentOverrides).
    const isStaggered = pad.tightPitch && kind === 'point' && staggerSign !== 0
    const pattern = isStaggered ? 'staggered' : (kind === 'point' ? 'dot' : kind)

    if (isStaggered) {
        // Nudge the dot along the pad's own LONG axis, alternating direction
        // pad-to-pad (staggerSign - see computeAlternatingSigns), so a row of
        // closely spaced IC leads doesn't dispense as one continuous line.
        // Distancing comes straight from the pad's own edge (half its
        // length) - the long axis gives far more room to separate adjacent
        // dots than nudging across the pad's (narrow, tight-pitch) width
        // would.
        const desiredOffset = (padLength(pad) / 2) * mechanics.staggerOffsetFraction

        // But never push the dot far enough that it (or its real dispensed
        // paste, which can spread wider than the on-screen indicator) could
        // land past the pad's edge. Sized off TWICE the dot's own drawn
        // radius - not the radius itself - as a safety margin: the actual
        // dot stays its normal size, this just keeps clearance to the true
        // edge generous even if the paste spreads further than expected.
        const radius = placementDotRadiusMm(points[0].dispenseDegrees)
        const maxOffset = Math.max(0, padLength(pad) / 2 - 2 * radius)

        const offset = Math.min(desiredOffset, maxOffset) * staggerSign

        points = points.map(p => ({
            ...p,
            dx: p.dx + (alongX ? offset : 0),
            dy: p.dy + (alongX ? 0 : offset)
        }))
    }

    return { points, pattern }
}

// Deterministic bottom-to-top, left-to-right scan order (rows grouped by Y
// within a tolerance, sorted by X within each row) instead of whatever order
// the gerber happens to list flashes in.
export function sortPadsRasterOrder(pads, rowToleranceMm = ROW_TOLERANCE_MM) {
    const byY = [...pads].sort((a, b) => a.y - b.y || a.x - b.x)
    const rows = []

    for (const pad of byY) {
        const row = rows.find(r => Math.abs(r.y - pad.y) <= rowToleranceMm)
        if (row) {
            row.y = (row.y * row.pads.length + pad.y) / (row.pads.length + 1)
            row.pads.push(pad)
        } else {
            rows.push({y: pad.y, pads: [pad]})
        }
    }

    rows.sort((a, b) => a.y - b.y)

    const result = []
    for (const row of rows) {
        row.pads.sort((a, b) => a.x - b.x)
        result.push(...row.pads)
    }
    return result
}

// Gerber coordinates go through integer-units -> decimal-scale division, which
// leaves sub-micron floating point noise on otherwise-identical spacings (two
// pad pairs at the same nominal pitch can come out as e.g. 0.349999999 and
// 0.350000001mm). Comparing that noisy value straight against gapThreshold
// made pads with genuinely identical spacing land on opposite sides of the
// tight-pitch cutoff depending on which way the noise happened to round -
// exactly the kind of "some pads on this part get treated differently than
// others" inconsistency this rounding avoids. A micron is far finer than
// anything the gap threshold logic needs to resolve.
const GAP_ROUNDING_MM = 0.001
function roundGap(value) {
    return Math.round(value / GAP_ROUNDING_MM) * GAP_ROUNDING_MM
}

function isTightNeighbor(padA, padB, gapThreshold) {
    const halfAX = (padA.xSize ?? padA.diameter ?? 0.3) / 2
    const halfAY = (padA.ySize ?? padA.diameter ?? 0.3) / 2
    const halfBX = (padB.xSize ?? padB.diameter ?? 0.3) / 2
    const halfBY = (padB.ySize ?? padB.diameter ?? 0.3) / 2

    const dxGap = roundGap(Math.abs(padA.x - padB.x) - (halfAX + halfBX))
    const dyGap = roundGap(Math.abs(padA.y - padB.y) - (halfAY + halfBY))

    // Close on one axis while roughly aligned on the other = neighbors in a row/column.
    const rowNeighbors = dyGap < 0 && dxGap >= 0 && dxGap < gapThreshold
    const colNeighbors = dxGap < 0 && dyGap >= 0 && dyGap < gapThreshold

    return rowNeighbors || colNeighbors
}

// Flags pads (TSOP/QFP-style fine pitch) whose nearest-neighbor gap is under
// the threshold, so planPadDispense() can fall back to a single staggered dot.
// Gated to pads narrower than TIGHT_PITCH_MAX_PAD_WIDTH_MM: isTightNeighbor()
// only looks at the absolute edge-to-edge gap, with no regard to how wide the
// pads themselves are, so two large pads that just happen to sit close
// together (e.g. a power IC's wide drain/source tabs) would otherwise get
// flagged exactly like a fine-pitch lead row - and for an elongated pad,
// that flag collapses its normal multi-dot "line" coverage down to a single
// dot (see planPadDispense), which is wrong for a pad that size.
export function tagTightPitchPads(pads, gapThreshold = TIGHT_PITCH_GAP_MM) {
    return pads.map((pad, i) => ({
        ...pad,
        tightPitch: padWidth(pad) <= TIGHT_PITCH_MAX_PAD_WIDTH_MM &&
            pads.some((other, j) => j !== i && isTightNeighbor(pad, other, gapThreshold))
    }))
}

// Assigns alternating +1/-1 to tight-pitch pads via proper graph 2-coloring
// (BFS over the tight-neighbor adjacency graph), not a running toggle that
// flips while walking pads in whatever order a group happens to list them.
// A running toggle only alternates correctly along a single straight line -
// a pad with tight neighbors in two directions at once (a fine-pitch part
// with pads in two dimensions, not just a single row) has no consistent
// "next" pad for a linear toggle to follow, so two pads that are genuinely
// adjacent to each other could end up getting the same sign depending on
// traversal order. This is independent of group/traversal order entirely
// (row/column adjacency alone determines the graph), which is also what
// makes it safe to compute once up front rather than threaded through
// whatever order components get visited in (see groupPadsByComponent).
//
// Used as planPadDispense()'s staggerSign - the perpendicular nudge
// direction for a tight-pitch pad's single dot.
//
// This eliminates the vast majority of same-sign adjacent pairs, but not
// literally all of them: the adjacency graph is bipartite (safely
// 2-colorable) for a simple row or grid of same-size pads, but a
// differently-sized pad that happens to be a tight neighbor of two pads that
// are themselves tight neighbors forms a triangle - an odd cycle, where one
// edge is mathematically guaranteed to end up same-signed no matter the
// coloring. That's a real, rare board layout, not a bug in this function.
export function computeAlternatingSigns(taggedPads, gapThreshold = TIGHT_PITCH_GAP_MM) {
    const tightPads = taggedPads.filter(pad => pad.tightPitch)
    const signs = new Map()

    for (const start of tightPads) {
        if (signs.has(start)) continue
        signs.set(start, 1)
        const queue = [start]

        while (queue.length) {
            const pad = queue.shift()
            const sign = signs.get(pad)
            for (const other of tightPads) {
                if (other === pad || signs.has(other)) continue
                if (isTightNeighbor(pad, other, gapThreshold)) {
                    signs.set(other, -sign)
                    queue.push(other)
                }
            }
        }
    }

    return signs
}

// Buckets a refdes into the coarse categories the Job Positions list groups
// by, from its standard reference-designator letter prefix (IPC-7351/typical
// EDA convention: R = resistor, C = capacitor, U = IC). Everything else
// (connectors, inductors, diodes, transistors, crystals, switches, ...) is
// "other" rather than guessing at a dozen more one-off prefixes.
export function classifyComponentType(refdes) {
    if (!refdes) return 'other'
    const prefix = /^[A-Za-z_]+/.exec(refdes)?.[0]?.toUpperCase() ?? ''
    if (prefix === 'R') return 'resistor'
    if (prefix === 'C') return 'capacitor'
    if (prefix === 'U') return 'ic'
    return 'other'
}

// 'multipad' and 'inferred' are only ever produced by
// clusterPadsGeometrically() (see groupPadsByComponent) - kept after the
// real, refdes-confirmed types so those always list first.
export const COMPONENT_TYPE_ORDER = ['resistor', 'capacitor', 'ic', 'other', 'multipad', 'inferred']

// Splits a refdes into its letter prefix and numeric suffix so "R2" sorts
// before "R10" (a plain string sort would put "R10" first).
function compareRefdesNatural(a, b) {
    const matchA = /^([A-Za-z_]*)(\d*)$/.exec(a)
    const matchB = /^([A-Za-z_]*)(\d*)$/.exec(b)
    if (!matchA || !matchB) return a.localeCompare(b)

    const prefixCompare = matchA[1].localeCompare(matchB[1])
    if (prefixCompare !== 0) return prefixCompare

    if (matchA[2] && matchB[2]) return Number(matchA[2]) - Number(matchB[2])
    return a.localeCompare(b)
}

// Union-Find clustering of pads with no refdes into synthetic per-footprint
// groups, purely from geometry (row/column adjacency, like isTightNeighbor
// but at COMPONENT_CLUSTER_GAP_MM instead of the much tighter fine-pitch
// threshold). This is a best-effort reconstruction, not a real designator:
// without any text/net data there's no way to confirm true footprint
// boundaries, or tell a resistor from a capacitor (both use identical
// footprints) - see groupPadsByComponent for how the result gets labeled.
function clusterPadsGeometrically(pads, gapThreshold = COMPONENT_CLUSTER_GAP_MM) {
    const parent = pads.map((_, i) => i)
    const find = i => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
        return i
    }
    const union = (i, j) => {
        const rootI = find(i), rootJ = find(j)
        if (rootI !== rootJ) parent[rootI] = rootJ
    }

    for (let i = 0; i < pads.length; i++) {
        for (let j = i + 1; j < pads.length; j++) {
            if (isTightNeighbor(pads[i], pads[j], gapThreshold)) union(i, j)
        }
    }

    const clusters = new Map()
    for (let i = 0; i < pads.length; i++) {
        const root = find(i)
        if (!clusters.has(root)) clusters.set(root, [])
        clusters.get(root).push(pads[i])
    }

    return [...clusters.values()]
}

// Groups pads by their %TO.C% component (refdes), ordered by component type
// (COMPONENT_TYPE_ORDER) then naturally by refdes (R1, R2, ... R10) - this is
// both the Job Positions list's grouping and the actual dispense order for a
// full run, so pasting proceeds one component at a time instead of a bottom-
// left-to-top-right raster across unrelated parts. Pads with no component
// attribute at all (an older/non-X2 gerber export) instead get clustered
// geometrically (see clusterPadsGeometrically) and labeled generically
// ("Part 1", "Part 2", ... - a space distinguishes these from a real
// designator like "R1"), bucketed only by pad count since real part type
// can't be inferred from geometry alone.
export function groupPadsByComponent(pads) {
    const byRefdes = new Map()
    const loose = []

    for (const pad of pads) {
        if (!pad.refdes) { loose.push(pad); continue }
        if (!byRefdes.has(pad.refdes)) byRefdes.set(pad.refdes, [])
        byRefdes.get(pad.refdes).push(pad)
    }

    const componentGroups = [...byRefdes.entries()].map(([refdes, groupPads]) => ({
        refdes,
        type: classifyComponentType(refdes),
        pads: groupPads
    }))

    componentGroups.sort((a, b) =>
        COMPONENT_TYPE_ORDER.indexOf(a.type) - COMPONENT_TYPE_ORDER.indexOf(b.type) ||
        compareRefdesNatural(a.refdes, b.refdes)
    )

    const clusterCentroids = clusterPadsGeometrically(loose).map(clusterPads => ({
        x: clusterPads.reduce((sum, p) => sum + p.x, 0) / clusterPads.length,
        y: clusterPads.reduce((sum, p) => sum + p.y, 0) / clusterPads.length,
        pads: clusterPads
    }))

    // Every cluster gets a synthetic "Part N" group - bucketed into just two
    // inferred types: 'multipad' (more than 2 pads - confident enough a
    // cluster this size is one real component) and 'inferred' (everything
    // else: 1-2 pad clusters, where geometry alone can't tell a lone/
    // 2-pad footprint's true boundary as reliably).
    const looseGroups = []
    let partNumber = 1
    for (const cluster of sortPadsRasterOrder(clusterCentroids)) {
        const clusterPads = sortPadsRasterOrder(cluster.pads)
        looseGroups.push({
            refdes: `Part ${partNumber++}`,
            type: clusterPads.length > 2 ? 'multipad' : 'inferred',
            pads: clusterPads
        })
    }

    return [...componentGroups, ...looseGroups]
}
