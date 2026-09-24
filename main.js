import './style.css'
import { modalManager } from './modal.js'
import { toastManager } from './toast.js'
import { serialManager } from './serialManager.js';
import { onOpenCVReady } from './opencv-bridge.js';
import { VideoManager } from './video.js';
import { Job } from './job.js';
import { Lumen } from './lumen.js'
import { getPasteDispenseSettings, setPasteDispenseSettings, resetPasteDispenseSettings, suggestedDispenseDegrees, DEFAULT_NOZZLE_GAUGE_RATIOS } from './gerberImport.js';

let modal = new modalManager();
let toast = new toastManager();

let serial = new serialManager(modal);

let lumen = new Lumen(serial);
let currentJob = new Job(lumen, toast);

setupHardwareVersionGate();

// Gates the whole app behind picking a paste extruder hardware version
// (see Job.hardwareVersion in job.js, which the actual G-code branches on) -
// first-time visitors see a full-screen choice (#hardwareGate) before
// #top-controls/#main-app/#footer ever become visible; the header dropdown
// (#hardwareVersionSelect, always visible next to the title) lets it be
// changed again later without re-triggering that gate. Runs as early as
// possible (top-level, before the OpenCV/camera setup below, which can take
// a moment to load) so the gate itself isn't delayed by anything else.
function setupHardwareVersionGate(){
  const STORAGE_KEY = 'lumenPasteUtility.hardwareVersion';
  const gate = document.getElementById('hardwareGate');
  const select = document.getElementById('hardwareVersionSelect');
  const lockedElements = ['top-controls', 'main-app', 'footer']
    .map(id => document.getElementById(id))
    .filter(Boolean);

  function applyHardwareVersion(version, { persist }){
    currentJob.hardwareVersion = version;
    if (select) select.value = version;
    if (persist) localStorage.setItem(STORAGE_KEY, version);

    gate?.classList.remove('visible');
    for (const el of lockedElements) el.classList.remove('hw-locked');

    // Retraction Degrees/Dwell Milliseconds only mean anything for the V1
    // Beta plunger (see plungerDispenseCommands() in job.js) - hide them
    // entirely for V2 instead of leaving dead, unused inputs on screen.
    for (const el of document.querySelectorAll('.hw-plunger-only')) {
      el.classList.toggle('hw-hidden-for-hw', version !== 'v1-beta');
    }
  }

  select?.addEventListener('change', () => {
    if (select.value) applyHardwareVersion(select.value, { persist: true });
  });

  for (const option of gate?.querySelectorAll('.hardware-gate-option') ?? []) {
    option.addEventListener('click', () => {
      applyHardwareVersion(option.dataset.hardwareVersion, { persist: true });
    });
  }

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'v1-beta' || stored === 'v2') {
    applyHardwareVersion(stored, { persist: false });
  } else {
    // No choice saved yet - keep the rest of the app hidden and put up the
    // gate instead of defaulting silently, since which hardware is running
    // changes the actual dispense G-code (see Job.pointDispenseCommands()).
    for (const el of lockedElements) el.classList.add('hw-locked');
    gate?.classList.add('visible');
  }
}

onOpenCVReady(cv => {
  console.log("OpenCV loaded");
  
  const videoManager = new VideoManager(cv);

  lumen.addVideoManager(videoManager);

  const canvas = document.getElementById('opencv-canvas');
  const cameraSelect = document.getElementById('camera-select');
  const processButton = document.getElementById('process-button');
  
  videoManager.populateCameraList(cameraSelect);

  let isCameraRunning = false;

  // Device labels are blank until getUserMedia grants permission (see the
  // "connect" handler below, which repopulates the list once that happens),
  // but the selector itself was never wired to actually switch the running
  // stream when changed - picking a different camera did nothing until now.
  cameraSelect.addEventListener('change', async () => {
    if (!isCameraRunning) return;

    try {
      videoManager.stopVideo(canvas);
      await videoManager.startVideo(cameraSelect.value, canvas);
    } catch (err) {
      alert('Error switching camera: ' + err.message);
    }
  });

  // Camera Scale (px/mm) - lets a different camera/lens/working height be
  // retuned without touching code. videoManager.pxPerMm is read live by
  // both jogToFiducial() (lumen.js) and CVdetectCircle() (video.js), so this
  // takes effect on the very next jog/detection, no reload needed.
  const cameraPxPerMm = document.getElementById('cameraPxPerMm');
  if (cameraPxPerMm) {
    cameraPxPerMm.value = videoManager.pxPerMm;
    cameraPxPerMm.addEventListener('change', (e) => {
      const value = Number(e.target.value);
      if (value > 0) videoManager.pxPerMm = value;
    });
  }

  // Fiducial Confidence - HoughCircles' accumulator threshold
  // (videoManager.fiducialConfidence), read live by CVdetectCircle() on
  // every call. Lower catches more real fiducials in poor lighting/focus but
  // lets more false positives (silkscreen, pads) through too; higher is the
  // reverse - tune to whatever this camera/board/lighting needs instead of
  // living with a single hardcoded compromise.
  const fiducialConfidence = document.getElementById('fiducialConfidence');
  const fiducialConfidenceValue = document.getElementById('fiducialConfidenceValue');
  if (fiducialConfidence) {
    fiducialConfidence.value = videoManager.fiducialConfidence;
    if (fiducialConfidenceValue) fiducialConfidenceValue.textContent = videoManager.fiducialConfidence;
    fiducialConfidence.addEventListener('input', (e) => {
      const value = Number(e.target.value);
      videoManager.fiducialConfidence = value;
      if (fiducialConfidenceValue) fiducialConfidenceValue.textContent = value;
    });
  }

  // Scroll-to-zoom on the camera feed. Prefers the camera's own hardware/
  // driver zoom (see VideoManager.zoomBy()/getZoomCapabilities()) when the
  // device exposes one - a real zoom changes what the sensor actually reads
  // out, so it's genuinely more detail for fiducial detection to work with
  // too, not just a bigger view of the same pixels. Most webcams don't
  // support it though (confirmed on the camera this was tested with), so
  // falls back to a plain CSS scale on the canvas (clipped by its
  // .video-feed-viewport wrapper) the first time zoomBy() reports it can't -
  // a display-only zoom that has no effect on fiducial detection or jog
  // math, but at least does *something* visually on hardware that can't
  // really zoom.
  let cameraZoom = 1;
  const CAMERA_ZOOM_MIN = 1;
  const CAMERA_ZOOM_MAX = 4;
  const CAMERA_ZOOM_STEP = 0.1;

  function applyCssZoom(direction) {
    cameraZoom = Math.min(CAMERA_ZOOM_MAX, Math.max(CAMERA_ZOOM_MIN, cameraZoom + direction * CAMERA_ZOOM_STEP));
    canvas.style.transform = `scale(${cameraZoom.toFixed(2)})`;
  }

  // null = not yet known which kind this camera gets; true/false once
  // zoomBy() has actually told us. Remembered so every scroll after the
  // first doesn't re-attempt (and wait on) a hardware zoom call already
  // known to fail.
  let hardwareZoomSupported = null;
  let zoomInFlight = false;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();

    const direction = e.deltaY < 0 ? 1 : -1;

    if (hardwareZoomSupported === false) {
      applyCssZoom(direction);
      return;
    }

    if (zoomInFlight) return;
    zoomInFlight = true;
    videoManager.zoomBy(direction).then(applied => {
      hardwareZoomSupported = applied;
      if (!applied) applyCssZoom(direction);
    }).finally(() => {
      zoomInFlight = false;
    });
  }, { passive: false });

  // job stuff
  const importJobButton = document.getElementById('importJob');
  const jobFileInput = document.getElementById('jobFile');
  const exportJobButton = document.getElementById('exportJob');
  
  // settings elements
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

  const jobStencilThicknessPreset = document.getElementById('jobStencilThicknessPreset');
  const jobStencilThicknessMm = document.getElementById('jobStencilThicknessMm');
  const jobNozzleGaugePreset = document.getElementById('jobNozzleGaugePreset');

  // Reflects a stencil thickness (mm) into the preset dropdown/custom-mm-box
  // pair: picks the matching preset option if there is one (hiding the mm
  // box, since the preset already says the value), or "Custom" with the mm
  // box shown and holding the exact value otherwise.
  function syncStencilThicknessUI(thicknessMm) {
    if (!jobStencilThicknessPreset) return;
    const hasOption = [...jobStencilThicknessPreset.options].some(o => o.value !== 'custom' && Number(o.value) === thicknessMm);
    jobStencilThicknessPreset.value = hasOption ? String(thicknessMm) : 'custom';
    if (jobStencilThicknessMm) {
      jobStencilThicknessMm.hidden = hasOption;
      jobStencilThicknessMm.value = thicknessMm;
    }
  }

  // Current stencil thickness per whichever of the preset dropdown/custom-mm
  // box is actually in play right now.
  function getSelectedStencilThicknessMm() {
    if (!jobStencilThicknessPreset) return currentJob.stencilThicknessMm;
    if (jobStencilThicknessPreset.value === 'custom') {
      return jobStencilThicknessMm ? Number(jobStencilThicknessMm.value) : currentJob.stencilThicknessMm;
    }
    return Number(jobStencilThicknessPreset.value);
  }

  // The 0402 baseline (see suggestedDispenseDegrees()) for this stencil
  // thickness and nozzle gauge, scaled by the Dispense Multiplier field -
  // the one number this whole panel is for tuning, once real dispense
  // results show whether the suggested curve is running heavy or light for
  // this specific stencil/paste/tip combo.
  function computeDispenseDegrees(thicknessMm, nozzleGauge, multiplier) {
    const nozzleRatio = DEFAULT_NOZZLE_GAUGE_RATIOS[nozzleGauge] ?? 1;
    return Math.round(suggestedDispenseDegrees(thicknessMm, nozzleRatio) * multiplier * 10) / 10;
  }

  // Pulls the current stencil thickness + nozzle gauge + multiplier from
  // their fields and pushes the resulting dispense degrees into the job -
  // then re-runs every already-loaded board through it immediately, same as
  // an Advanced Settings tweak, so you don't have to re-import a gerber just
  // to test a different thickness/nozzle/multiplier combo.
  function applyDispenseSettings() {
    if (!jobNozzleGaugePreset) return;
    const thicknessMm = getSelectedStencilThicknessMm();
    if (!Number.isFinite(thicknessMm) || thicknessMm <= 0) return;
    const nozzleGauge = Number(jobNozzleGaugePreset.value);
    currentJob.stencilThicknessMm = thicknessMm;
    currentJob.nozzleGauge = nozzleGauge;

    currentJob.dispenseDegrees = computeDispenseDegrees(thicknessMm, nozzleGauge, currentJob.dispenseMultiplier);

    currentJob.recomputeDispensePattern();
  }

  if (jobStencilThicknessPreset) {
    jobStencilThicknessPreset.addEventListener('change', (e) => {
      const hasOption = e.target.value !== 'custom';
      if (jobStencilThicknessMm) {
        jobStencilThicknessMm.hidden = hasOption;
        if (hasOption) jobStencilThicknessMm.value = e.target.value;
        else jobStencilThicknessMm.focus();
      }
      applyDispenseSettings();
    });
  }

  if (jobStencilThicknessMm) {
    jobStencilThicknessMm.addEventListener('change', (e) => {
      const thicknessMm = Number(e.target.value);
      if (!Number.isFinite(thicknessMm) || thicknessMm <= 0) return;
      applyDispenseSettings();
    });
  }

  if (jobNozzleGaugePreset) {
    jobNozzleGaugePreset.addEventListener('change', () => {
      applyDispenseSettings();
    });
  }

  if (jobDispenseMultiplier) {
    jobDispenseMultiplier.addEventListener('input', (e) => {
      const multiplier = Number(e.target.value);
      if (!Number.isFinite(multiplier) || multiplier <= 0) return;
      currentJob.dispenseMultiplier = multiplier;
      currentJob.dispenseDegrees = computeDispenseDegrees(currentJob.stencilThicknessMm, currentJob.nozzleGauge, multiplier);
      // Redraw so placement dots (sized by dispense degrees) reflect the new
      // value immediately for every point still using the job-wide default.
      currentJob.drawJobToCanvas();
    });

    // On blur/enter (not every keystroke): re-run every already-loaded
    // board's pads through the new multiplier, same "immediately re-test
    // without re-importing" behavior the Advanced Settings tab tunables
    // already have.
    jobDispenseMultiplier.addEventListener('change', () => {
      currentJob.recomputeDispensePattern();
    });
  }

  // Sync the UI to the job's initial defaults and compute the starting
  // dispense degrees from them.
  syncStencilThicknessUI(currentJob.stencilThicknessMm);
  if (jobNozzleGaugePreset) jobNozzleGaugePreset.value = currentJob.nozzleGauge;
  if (jobDispenseMultiplier) jobDispenseMultiplier.value = currentJob.dispenseMultiplier;
  applyDispenseSettings();

  if (jobRetractionDeg) {
    jobRetractionDeg.addEventListener('change', (e) => {
      currentJob.retractionDegrees = Number(e.target.value);
    });
  }

  if (jobDwellMs) {
    jobDwellMs.addEventListener('change', (e) => {
      currentJob.dwellMilliseconds = Number(e.target.value);
    });
  }

  if (jobMotionSpeed) {
    jobMotionSpeed.addEventListener('change', (e) => {
      console.log('Motion speed changed:', e.target.value);
      currentJob.motionSpeed = Number(e.target.value);
    });
  }

  if (jobExtruderSpeed) {
    jobExtruderSpeed.addEventListener('change', (e) => {
      console.log('Extruder speed changed:', e.target.value);
      currentJob.extruderSpeed = Number(e.target.value);
    });
  }

  if (jobVacuumPressure) {
    jobVacuumPressure.addEventListener('input', (e) => {
      const percent = Number(e.target.value);
      currentJob.vacuumPressure = percent;
      if (jobVacuumPressureValue) jobVacuumPressureValue.textContent = percent;

      // If a job is actively running, push the new speed to the pump immediately
      // so the air assist level can be tuned live instead of waiting for the next point.
      if (currentJob.isRunning && serial.port?.writable) {
        serial.send([`M106 P2 S${Math.round(percent / 100 * 255)}`]);
      }
    });
  }

  if (jobMotorCurrent) {
    jobMotorCurrent.addEventListener('input', (e) => {
      currentJob.motorCurrent = Number(e.target.value);

      // If a job is actively running, push the new current immediately so it
      // can be tuned live instead of waiting for the next point.
      if (currentJob.isRunning && serial.port?.writable) {
        serial.send([`M906 B ${currentJob.motorCurrent}`]);
      }
    });
  }

  if (jobTravelHeight) {
    jobTravelHeight.addEventListener('change', (e) => {
      currentJob.travelHeight = Number(e.target.value);
    });
  }

  if (jobPreGcode) {
    jobPreGcode.addEventListener('input', (e) => {
      console.log('Pre-gcode changed');
      currentJob.preGcode = e.target.value;
    });
  }

  if (jobPostGcode) {
    jobPostGcode.addEventListener('input', (e) => {
      console.log('Post-gcode changed');
      currentJob.postGcode = e.target.value;
    });
  }

  if (jobInvertDispense) {
    jobInvertDispense.addEventListener('change', (e) => {
      console.log('Invert dispense changed:', e.target.checked);
      currentJob.invertDispense = e.target.checked;
    });
  }

  // Settings tab switcher (Basic / Global / Grid / Line / Staggered) -
  // toggles which panel is visible and which tab button carries the .active
  // style. Panel ids come from the buttons' own data-tab-panel attributes
  // rather than a hardcoded list, so adding another tab+panel pair later
  // doesn't need a matching change here.
  const settingsTabButtons = document.querySelectorAll('.settings-tab-btn');
  const settingsPanelIds = [...settingsTabButtons].map(btn => btn.dataset.tabPanel);
  settingsTabButtons.forEach(tabButton => {
    tabButton.addEventListener('click', () => {
      settingsTabButtons.forEach(btn => btn.classList.remove('active'));
      tabButton.classList.add('active');

      const targetPanelId = tabButton.dataset.tabPanel;
      for (const panelId of settingsPanelIds) {
        const panel = document.getElementById(panelId);
        if (panel) panel.style.display = panelId === targetPanelId ? '' : 'none';
      }
    });
  });

  // Advanced paste-dispense settings (gerberImport.js's tunable constants,
  // exposed via getPasteDispenseSettings/setPasteDispenseSettings) - maps
  // each input's id to the settings key it controls, both for reading on
  // change and for populating the inputs (initial load + Reset to Defaults).
  const pasteSettingsInputIds = {
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

  function refreshPasteSettingsInputs() {
    const settings = getPasteDispenseSettings();
    for (const [elementId, key] of Object.entries(pasteSettingsInputIds)) {
      const el = document.getElementById(elementId);
      if (el) el.value = settings[key];
    }
  }

  refreshPasteSettingsInputs();

  for (const [elementId, key] of Object.entries(pasteSettingsInputIds)) {
    const el = document.getElementById(elementId);
    if (!el) continue;
    el.addEventListener('change', (e) => {
      setPasteDispenseSettings({[key]: Number(e.target.value)});
      // Re-run every pasted board through the new settings immediately,
      // instead of making you re-import each gerber to see the effect.
      // No-ops per board that hasn't been gerber-imported yet.
      currentJob.recomputeDispensePattern();
    });
  }

  // "Reset to Defaults" appears on every advanced tab (Global/Grid/Line/
  // Staggered) since it resets all of gerberImport.js's tunables at once,
  // not just whichever tab you're looking at - #resetAdvancedSettings is the
  // original/first one, the rest share a class since only one element can
  // own an id.
  const resetAdvancedSettingsButtons = document.querySelectorAll('#resetAdvancedSettings, .reset-advanced-settings-alias');
  resetAdvancedSettingsButtons.forEach(button => {
    button.addEventListener('click', () => {
      resetPasteDispenseSettings();
      refreshPasteSettingsInputs();
      currentJob.recomputeDispensePattern();
    });
  });

  // Select All / Select None for the whole Job Positions list, instead of
  // clicking through every type/component checkbox individually.
  const selectAllComponentsButton = document.getElementById('selectAllComponents');
  if (selectAllComponentsButton) {
    selectAllComponentsButton.addEventListener('click', () => {
      currentJob.setAllPlacementsEnabled(true);
    });
  }

  const selectNoneComponentsButton = document.getElementById('selectNoneComponents');
  if (selectNoneComponentsButton) {
    selectNoneComponentsButton.addEventListener('click', () => {
      currentJob.setAllPlacementsEnabled(false);
    });
  }

  // import job
  if (importJobButton && jobFileInput) {
    importJobButton.addEventListener('click', () => {
      jobFileInput.click();
    });

    jobFileInput.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (file) {
        console.log('Reading file:', file.name);
        try {
          const result = await currentJob.importFromFile(file);
          if (!result.success) {
            console.error('Failed to import job:', result.error);
            alert('Failed to import job file: ' + result.error);
          }
        } catch (error) {
          console.error('Error importing job:', error);
          alert('Error importing job file: ' + error.message);
        }
      }
    });
  } else {
    console.error('Import button or file input not found');
  }

  // gerber import - accepts either a single zip (fab output bundle) or several
  // loose gerber files; paste/mask/etc. are auto-detected from file content
  const importGerberButton = document.getElementById('importGerber');
  const gerberFilesInput = document.getElementById('gerberFiles');
  const gerberImportStatus = document.getElementById('gerberImportStatus');

  if (importGerberButton && gerberFilesInput) {
    importGerberButton.addEventListener('click', () => {
      gerberFilesInput.click();
    });

    gerberFilesInput.addEventListener('change', async (event) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;

      if (gerberImportStatus) gerberImportStatus.textContent = 'Importing...';

      try {
        const result = await currentJob.loadGerberFiles(files);
        if (gerberImportStatus && result) {
          gerberImportStatus.textContent = result.fiducialCount >= 3
            ? `${result.padCount} points imported, ${result.fiducialCount} fiducials found`
            : `${result.padCount} points imported (${result.fiducialCount}/3 fiducials found - add manually if needed)`;
        }
      } catch (error) {
        console.error('Error loading gerbers:', error);
        alert('Error loading gerber files: ' + error.message);
        if (gerberImportStatus) gerberImportStatus.textContent = '';
      }

      // allow re-selecting the same file(s) later without needing a change first
      gerberFilesInput.value = '';
    });
  }

  // export job
  if (exportJobButton) {
    exportJobButton.addEventListener('click', async () => {
      try {
        // ensure we have the latest values from the UI
        if (jobDispenseMultiplier) {
          currentJob.dispenseMultiplier = Number(jobDispenseMultiplier.value);
          currentJob.dispenseDegrees = computeDispenseDegrees(currentJob.stencilThicknessMm, currentJob.nozzleGauge, currentJob.dispenseMultiplier);
        }
        if (jobRetractionDeg) currentJob.retractionDegrees = Number(jobRetractionDeg.value);
        if (jobDwellMs) currentJob.dwellMilliseconds = Number(jobDwellMs.value);
        if (jobMotionSpeed) currentJob.motionSpeed = Number(jobMotionSpeed.value);
        if (jobExtruderSpeed) currentJob.extruderSpeed = Number(jobExtruderSpeed.value);
        if (jobVacuumPressure) currentJob.vacuumPressure = Number(jobVacuumPressure.value);
        if (jobMotorCurrent) currentJob.motorCurrent = Number(jobMotorCurrent.value);
        if (jobTravelHeight) currentJob.travelHeight = Number(jobTravelHeight.value);
        if (jobPreGcode) currentJob.preGcode = jobPreGcode.value;
        if (jobPostGcode) currentJob.postGcode = jobPostGcode.value;
        if (jobInvertDispense) currentJob.invertDispense = jobInvertDispense.checked;

        await currentJob.saveToFile();
        
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('Error saving file:', err);
          alert('Error saving file: ' + err.message);
        }
      }
    });
  }
  
  // Add click handler for canvas
  canvas.addEventListener('click', (event) => {

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // calculate scale
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
  
    // scale the click coordinates to match the video
    const scaledX = x * scaleX;
    const scaledY = y * scaleY;
  
    // calculate center of canvas
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
  
    // calculate offset from center
    const offsetX = scaledX - centerX;
    const offsetY = -(scaledY - centerY); 
  
    const scalingFactor = 0.02;
    const scaledOffsetX = offsetX * scalingFactor;
    const scaledOffsetY = offsetY * scalingFactor;
  

    serial.goToRelative(scaledOffsetX.toFixed(1), scaledOffsetY.toFixed(1))
    
  });
  
  document.getElementById("connect").addEventListener("click", async () => {
    const connectButton = document.getElementById("connect");
    
    try {
      if (!isCameraRunning) {
        await serial.connect();
        await videoManager.startVideo(cameraSelect.value, canvas);
        isCameraRunning = true;

        // getUserMedia just granted camera permission, so device labels are
        // now populated (they're blank before permission is granted) -
        // refresh the list so the dropdown shows real camera names.
        await videoManager.populateCameraList(cameraSelect);

        // connect() just forced the ring light on (board boot behavior) -
        // reflect that on the button instead of leaving it stuck on "Off".
        syncRingLightsButton();


        // update button
        connectButton.textContent = 'Connected';
        connectButton.classList.add('connected');
        connectButton.disabled = true;
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  document.getElementById("disconnect").addEventListener("click", async () => {
    try {
      await serial.disconnect();

      if (isCameraRunning) {
        videoManager.stopVideo(canvas);
        isCameraRunning = false;
      }

      // Nothing's actually polling the board's position anymore (see
      // setupMachinePositionPoll() below) - blank the readout instead of
      // leaving the last-known values up looking still-live.
      for (const id of ['machinePosX', 'machinePosY', 'machinePosZ']) {
        const el = document.getElementById(id);
        if (el) el.textContent = '--';
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  processButton.addEventListener('click', () => {
    if (isCameraRunning) {
      lumen.jogToFiducial();
    }
  });

  document.getElementById("homing-fid-button").addEventListener('click', async () => {
    //TODO should make this editable somehow, not gonna be teh same for everyone
    await lumen.serial.goTo(218, 196);
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await lumen.jogToFiducial();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await lumen.jogToFiducial();
    await new Promise(resolve => setTimeout(resolve, 1500));

    lumen.serial.send(["G92 X218 Y196"])
    
  });

  document.getElementById("nozzleOffsetCal").addEventListener('click', async () => {
    // performTipCalibration() sets the active board's tipXoffset/tipYoffset
    // and refreshes the offset-tool display itself now that those are
    // per-board (see updateOffsetDisplay() in job.js).
    await currentJob.performTipCalibration();
  });


});



// REPL EVENT LISTENERS

//clears the contents of the repl text field
function clearReplInput(){
  document.getElementById("repl-input").value = "";
}

// clicks the send button if you hit the enter key while repl filed is focused
document.getElementById("repl-input").addEventListener("keyup", function(event) {
  if (event.code === "Enter"){
    event.preventDefault();
    document.getElementById("send").click();
  }
  else if (event.code === "ArrowUp"){
    event.preventDefault();

    //check to see that our index isnt at the end of commands sent
    if(serial.sentCommandBufferIndex == serial.sentCommandBuffer.length - 1){
      return false;
    }
    //update the buffer index
    serial.sentCommandBufferIndex++;
    //then drop that new element into the field
    document.getElementById("repl-input").value = serial.sentCommandBuffer[serial.sentCommandBufferIndex];

  }
  else if (event.code === "ArrowDown"){
    event.preventDefault();

    //check to see that our index isnt at the end of commands sent
    if(serial.sentCommandBufferIndex == 0){
      return false;
    }
    //update the buffer index
    serial.sentCommandBufferIndex--;
    //then drop that new element into the field
    document.getElementById("repl-input").value = serial.sentCommandBuffer[serial.sentCommandBufferIndex];

  }
});

document.getElementById("send").addEventListener("click", () => {
  serial.sendRepl();
  clearReplInput();
});



// jog pendant event listeners

// The default LumenPnP's actual X-axis travel limit (a software soft limit
// on how far a jog can push the gantry) - distinct from BUILD_PLATES'
// smaller paste-able/no-go-zone-aware extents in job.js, which are about
// where boards can be drawn/pasted, not the gantry's own hard stops.
// Jogging past this would just grind the X axis into its own limit.
const MAX_TRAVEL_X_MM = 400;

// Shrinks a relative jog delta (± dist) so current + delta lands within
// [minMm, maxMm], using the last-polled machine position (see
// setupMachinePositionPoll()) as "current" - or returns delta unchanged if
// that position isn't known yet (nothing to clamp against, so send as
// asked rather than silently refusing to jog at all).
function clampJogDelta(posElementId, delta, maxMm, minMm = 0){
  const posEl = document.getElementById(posElementId);
  const current = parseFloat(posEl?.textContent);
  if (!Number.isFinite(current)) return delta;
  const target = current + delta;
  if (target > maxMm) return maxMm - current;
  if (target < minMm) return minMm - current;
  return delta;
}

function getJogDistance(){
  let distLUT = document.getElementById("jog-distance").value;
  if(distLUT == "1"){
    return 0.1;
  }
  else if(distLUT == "2"){
    return 1;
  }
  else if(distLUT == "3"){ 
    return 10;
  }
  else if(distLUT == "4"){
    return 100;
  }
  else{
    return 1;
  }
}

document.getElementById("jog-yp").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 Y${dist} F${currentJob.motionSpeed}`, "G90"]);
});

document.getElementById("jog-ym").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 Y-${dist} F${currentJob.motionSpeed}`, "G90"]);
});

document.getElementById("jog-xp").addEventListener("click", () => {
  let dist = getJogDistance();
  const clamped = clampJogDelta('machinePosX', dist, MAX_TRAVEL_X_MM);
  if (Math.abs(clamped) < 0.0001) return; // already at/past the limit - nothing to send
  serial.send(["G91", `G0 X${clamped} F${currentJob.motionSpeed}`, "G90"]);
});

document.getElementById("jog-xm").addEventListener("click", () => {
  let dist = getJogDistance();
  const clamped = clampJogDelta('machinePosX', -dist, MAX_TRAVEL_X_MM);
  if (Math.abs(clamped) < 0.0001) return;
  serial.send(["G91", `G0 X${clamped} F${currentJob.motionSpeed}`, "G90"]);
});

document.getElementById("jog-zp").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 Z${dist} F${currentJob.motionSpeed}`, "G90"]);
});

document.getElementById("jog-zm").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 Z-${dist} F${currentJob.motionSpeed}`, "G90"]);
});

// Extrude B motor
const extrudeBtn = document.getElementById('extrude-btn');

if (extrudeBtn) {
  extrudeBtn.addEventListener('click', () => {
    let dist = getJogDistance();
    // Positive B extrudes on this auger; invert direction if invertDispense is enabled
    const direction = currentJob.invertDispense ? -dist : dist;
    // Pump on for the duration of the extrude move, then off
    serial.send([`M106 P2 S${Math.round(currentJob.vacuumPressure / 100 * 255)}`, "G91", `G0 B${direction} F${currentJob.extruderSpeed}`, "G90", "M107 P2"]);
  });
}

// Purge Auger: run the B axis a long way to clear/prime the auger, pump on
// throughout. Sent as a sequence of small chunks (not one giant move) so a
// Stop click actually takes effect within about one chunk's worth of motion
// instead of only after the whole purge has already run - same
// check-between-sends pattern Job.run() uses for its own "close to cancel".
//
// Both stages (picking a duration, then watching it run) go through the
// shared toast's real toast.show()/receivedInput mechanism - same as every
// other toast-driven flow in job.js - rather than poking toastContent/
// toastObject directly. That matters here specifically: toast.js's own
// close (X) button always resolves whatever toast.show() call is currently
// pending, so routing through it is what makes that button actually work as
// "cancel" at both stages, and what makes "the toast closing" and "the
// purge actually stopping" the same event instead of two things that could
// drift out of sync (closing without stopping the motion, or a Stop click
// that doesn't close the toast).
const PURGE_FEEDRATE = 100000; // deg/min, matches the previous fixed purge's feedrate
// A quarter of the old fixed 200000-degree purge (which took 200000/100000 =
// 2 minutes at PURGE_FEEDRATE) - 30s/50000deg is just the starting default
// now, since the toast below lets it be changed per-purge.
const DEFAULT_PURGE_SECONDS = 15;
// Each chunk is its own G0 move, and the M400 after it (see the loop below)
// forces the firmware's motion queue empty before the next chunk is sent -
// so every chunk boundary is a real stop: the auger ramps down to 0 at the
// end of one chunk and back up from 0 at the start of the next, instead of
// Marlin's planner blending consecutive moves into one continuous
// accelerate-cruise-decelerate profile the way it would if chunks were
// queued back to back. That's what read as "speeding up and slowing down"
// with the old 2000-degree (~1.2s) chunk size - each ramp itself is quick,
// but there were ~25 of them back to back over a 30s purge. Sizing chunks
// in whole seconds instead spaces those ramp cycles out enough to read as
// one continuous purge - 5s means at most 6 of them over the 30s default,
// each brief relative to the chunk - at the cost of a longer worst-case
// Stop latency (now ~5s instead of ~1.2s: Stop only ever lets the
// currently in-flight chunk finish, never queues another).
const PURGE_CHUNK_SECONDS = 5;
const PURGE_CHUNK_DEGREES = PURGE_CHUNK_SECONDS * (PURGE_FEEDRATE / 60);

let purgeRunning = false;

const purgeAugerBtn = document.getElementById('purgeAuger');
if (purgeAugerBtn) {
  purgeAugerBtn.addEventListener('click', async () => {
    if (purgeRunning) return; // already showing/running its own toast
    if (currentJob.isRunning) {
      alert("Can't purge the auger while a job is running.");
      return;
    }

    purgeRunning = true;
    purgeAugerBtn.disabled = true;
    try {
      const seconds = await promptPurgeDuration();
      if (seconds != null) await runPurge(seconds);
    } finally {
      purgeAugerBtn.disabled = false;
      purgeRunning = false;
    }
  });
}

// Shows the duration-entry toast and resolves with the chosen number of
// seconds, or null if closed/cancelled (toast.js's close button always
// resolves a pending toast.show() with `false`).
async function promptPurgeDuration() {
  const resultPromise = toast.show(
    `Purge Auger - runs the auger for the duration below, pump on throughout.<br>` +
    `<label>Duration (seconds): <input type="number" id="purgeDurationInput" min="1" max="600" step="1" value="${DEFAULT_PURGE_SECONDS}"></label>` +
    `<button id="purgeStartBtn" class="goldenrod-button" type="button">Start</button>`
  );
  // toast.show() already reset receivedInput and set the markup above
  // synchronously before returning the (still-pending) promise, so the
  // button exists in the DOM right now to wire up.
  document.getElementById('purgeStartBtn')?.addEventListener('click', () => {
    const input = document.getElementById('purgeDurationInput');
    toast.receivedInput = Math.max(1, Number(input?.value) || DEFAULT_PURGE_SECONDS);
  });
  const result = await resultPromise;
  return result === false ? null : result;
}

// Runs the actual chunked purge, showing live progress in a second
// toast.show() call - stoppable via either its own "Stop" button or the
// toast's normal close (X) button, both of which resolve the SAME pending
// promise (see toast.js), so either one both closes the toast and stops the
// remaining motion together.
async function runPurge(seconds) {
  const totalDegrees = seconds * (PURGE_FEEDRATE / 60);
  // Positive B extrudes on this auger; invert direction if invertDispense is enabled
  const direction = currentJob.invertDispense ? -1 : 1;
  let stopRequested = false;

  const donePromise = toast.show(
    `Purging auger (${seconds}s)... <span id="purgeProgress">0%</span><br>` +
    `<button id="purgeStopBtn" class="goldenrod-button" type="button">Stop</button>`
  );
  document.getElementById('purgeStopBtn')?.addEventListener('click', () => {
    toast.receivedInput = 'stop';
  });
  donePromise.then(() => { stopRequested = true; });

  await serial.send([`M106 P2 S${Math.round(currentJob.vacuumPressure / 100 * 255)}`, `M906 B ${currentJob.motorCurrent}`, "G91"]);

  let sentDegrees = 0;
  while (sentDegrees < totalDegrees && !stopRequested) {
    const chunk = Math.min(PURGE_CHUNK_DEGREES, totalDegrees - sentDegrees);
    // M400 ("Finish Moves") is the fix here, not just the chunking: Marlin
    // (this firmware - see the G4 dwell already used for the plunger's own
    // extrude timing in job.js's plungerDispenseCommands()) sends a G0
    // move's own "ok" back as soon as the move is QUEUED into the planner,
    // not once it's physically finished - moves can queue several deep, so
    // without this every chunk's "ok" was coming back near-instantly and
    // the whole loop (all ~totalDegrees/PURGE_CHUNK_DEGREES chunks) was
    // dumping onto the firmware in a fraction of a second, way ahead of the
    // auger's real physical position. That's exactly why the displayed
    // percentage didn't track reality, and why Stop appeared to do nothing:
    // by the time it was clicked, every chunk was already queued and the
    // firmware just kept working through all of them regardless. M400
    // blocks its own "ok" until the queue actually drains, so this await
    // now genuinely waits for the physical motion, sentDegrees/the percentage
    // only advances once that chunk is real, and the while condition above
    // gets a real chance to see stopRequested between chunks - so Stop now
    // only lets the current (~PURGE_CHUNK_SECONDS) chunk finish, not the
    // whole queue.
    const sendOk = await serial.send([`G0 B${direction * chunk} F${PURGE_FEEDRATE}`, "M400"]);
    if (!sendOk) break;

    sentDegrees += chunk;
    // Updates the progress span's own text in place - doesn't touch the
    // Stop button or its listener, unlike replacing toastContent.innerHTML
    // wholesale would.
    const progressEl = document.getElementById('purgeProgress');
    if (progressEl) progressEl.textContent = `${Math.round(sentDegrees / totalDegrees * 100)}%`;
  }

  await serial.send(["G90", "M107 P2"]);

  // Same air purge Job.finishRun() does at the end of every job run (finished
  // or cancelled) - V2 (auger) only, since P3 isn't wired up on the V1 Beta
  // plunger. Runs whether the purge finished on its own or was stopped early
  // (both end up here).
  if (currentJob.hardwareVersion === 'v2') {
    await serial.send(["M106 P3", "G4 P500", "M107 P3"]);
  }

  // If the loop ended on its own (ran the full duration, or a send failed)
  // rather than via Stop/close, the toast is still showing and its
  // waitForUserSelection() poll is still waiting - resolve it the normal way
  // instead of leaving that poll dangling forever.
  if (!stopRequested) toast.receivedInput = 'finished';
}

// Offset tuning: nudge the dispense position by 0.1mm and jog the physical tip to match.
// Shared by the X/Y/Z offset tools in the Extruder Settings panel.
const offsetStep = 0.1;

function adjustOffset(jobProperty, gcodeAxis, valueElementId, delta) {
  // Only keep the new value if the machine is actually connected to receive
  // the matching jog - otherwise the stored offset (and the UI) would show a
  // change that never happened on the physical machine, so it'd look "saved"
  // while actually being stale/wrong the next time a job runs.
  if (!serial.isConnected()) {
    serial.send(["G91", `G0 ${gcodeAxis}${delta} F${currentJob.motionSpeed}`, "G90"]);
    return;
  }

  // tipXoffset/tipYoffset/zOffset are per-board (see the getters in job.js) -
  // this always adjusts whichever board's tab is currently active.
  currentJob[jobProperty] = Math.round((currentJob[jobProperty] + delta) * 10) / 10;
  document.getElementById(valueElementId).textContent = `${currentJob[jobProperty].toFixed(1)}mm`;
  serial.send(["G91", `G0 ${gcodeAxis}${delta} F${currentJob.motionSpeed}`, "G90"]);
}

document.getElementById("x-offset-up").addEventListener("click", () => {
  adjustOffset("tipXoffset", "X", "x-offset-value", offsetStep);
});

document.getElementById("x-offset-down").addEventListener("click", () => {
  adjustOffset("tipXoffset", "X", "x-offset-value", -offsetStep);
});

document.getElementById("y-offset-up").addEventListener("click", () => {
  adjustOffset("tipYoffset", "Y", "y-offset-value", offsetStep);
});

document.getElementById("y-offset-down").addEventListener("click", () => {
  adjustOffset("tipYoffset", "Y", "y-offset-value", -offsetStep);
});

// This machine's Z is inverted from typical printer convention: a positive Z
// gcode delta moves the tip DOWN toward the board, negative moves it UP (see
// the dispense move comments in job.js slice()). So "up" sends a negative
// delta and "down" sends a positive one, to match the on-screen button labels.
document.getElementById("z-offset-up").addEventListener("click", () => {
  adjustOffset("zOffset", "Z", "z-offset-value", -offsetStep);
});

document.getElementById("z-offset-down").addEventListener("click", () => {
  adjustOffset("zOffset", "Z", "z-offset-value", offsetStep);
});

// Air control
const leftAirToggle = document.getElementById("left-air-toggle");
let leftAirOn = false;
leftAirToggle.addEventListener("click", () => {
  if (!serial.isConnected()) {
    serial.send(["M106"]); // triggers the same "Cannot Write" prompt as any other command
    return;
  }
  leftAirOn = !leftAirOn;
  serial.send(leftAirOn ? ["M106", "M106 P1 S255"] : ["M107", "M107 P1"]);
  leftAirToggle.textContent = `Left Air: ${leftAirOn ? 'On' : 'Off'}`;
  leftAirToggle.classList.toggle('active', leftAirOn);
});

const rightAirToggle = document.getElementById("right-air-toggle");
let rightAirOn = false;
rightAirToggle.addEventListener("click", () => {
  if (!serial.isConnected()) {
    serial.send(["M106 P2"]); // triggers the same "Cannot Write" prompt as any other command
    return;
  }
  rightAirOn = !rightAirOn;
  // P2 only - this is positive-pressure paste air-assist, not the vacuum
  // setup (P3 is the vacuum pump's channel and doesn't apply here).
  serial.send(rightAirOn ? ["M106 P2 S255"] : ["M107 P2"]);
  rightAirToggle.textContent = `Right Air: ${rightAirOn ? 'On' : 'Off'}`;
  rightAirToggle.classList.toggle('active', rightAirOn);
});

// Vacuum control
document.getElementById("left-vac").addEventListener("click", () => {
  serial.readLeftVac();
});

document.getElementById("right-vac").addEventListener("click", () => {
  serial.readRightVac();
});

// Ring lights control - serial.ringLightsOn (not a locally tracked bool) is
// the source of truth, since the board also gets forced on at connect time
// (see serialManager.connect()) independent of this button.
const ringLightsToggle = document.getElementById("ring-lights-toggle");

function syncRingLightsButton() {
  ringLightsToggle.textContent = `Ring Lights: ${serial.ringLightsOn ? 'On' : 'Off'}`;
  ringLightsToggle.classList.toggle('active', serial.ringLightsOn);
}

ringLightsToggle.addEventListener("click", async () => {
  if (!serial.isConnected()) {
    serial.send(["M150 P0"]); // triggers the same "Cannot Write" prompt as any other command
    return;
  }
  // Only flip the button once the board actually acknowledged the command -
  // otherwise a dropped connection mid-send leaves the button lying about
  // the real light state.
  await serial.setRingLights(!serial.ringLightsOn);
  syncRingLightsButton();
});

// Stepper control
document.getElementById("disable-steppers").addEventListener("click", () => {
  serial.send(["M18"]);
});

// Homing controls
document.getElementById("home-x").addEventListener("click", () => {
  serial.send(["G28 X"]);
});

document.getElementById("home-y").addEventListener("click", () => {
  serial.send(["G28 Y"]);
});

document.getElementById("home-z").addEventListener("click", () => {
  serial.send(["G28 Z"]);
});

document.getElementById('getRoughBoardPosition').addEventListener('click', async () => {
  try {
      await currentJob.findBoardRoughPosition();
  } catch (error) {
      console.error('Error during capture:', error);
  }
});

document.getElementById('runJob').addEventListener('click', async () => {
  try {
      await currentJob.run();
  } catch (error) {
      console.error('Error during run:', error);
  }
});

document.getElementById('resumeJob').addEventListener('click', async () => {
  try {
      await currentJob.run(currentJob.lastRunStoppedAtPoint);
  } catch (error) {
      console.error('Error during resume:', error);
  }
});

document.getElementById('performFidCal').addEventListener('click', async () => {
  try {
    await currentJob.performFiducialCalibration();
  } catch (error) {
    console.error('Error during fid cal:', error);
  }
});

document.getElementById('captureNewPos').addEventListener('click', async () => {
  try {
    await currentJob.captureNewPosition();
  } catch (error) {
    console.error('Error during pos capture:', error);
  }
});

// Setup Checklist (import panel) - a single guided front door that walks a
// user through connecting, importing, calibrating, and running a job in
// order, instead of hunting each step's control down across separate
// panels. Every checklist button just forwards its click to the real
// control that already lives elsewhere (one source of truth for the actual
// logic); this only decides what's done/next and enables/disables
// accordingly. Steps whose action would error or behave oddly if clicked
// out of order (rough position needs a connection and exactly 3 fiducials;
// fid cal needs a rough position first) are locked until their
// prerequisite is met - the rest are left open since nothing breaks if
// they're done in a different order.
function setupSetupChecklist(){
  const checklist = document.getElementById('setupChecklist');
  if (!checklist) return;

  // Floating popup open/closed state (see .floating-popup in style.css) -
  // remembered across reloads like the rest of this page's layout, but
  // defaults to open since this is the primary onboarding flow for anyone
  // who hasn't seen it yet.
  const POPUP_STORAGE_KEY = 'lumenPasteUtility.setupChecklistOpen';
  const popup = document.getElementById('setupChecklistPopup');
  const toggleButton = document.getElementById('setupChecklistToggle');
  const closeButton = document.getElementById('setupChecklistClose');

  const setPopupOpen = (open) => {
    if (popup) popup.classList.toggle('visible', open);
    localStorage.setItem(POPUP_STORAGE_KEY, open ? '1' : '0');
  };

  const savedOpen = localStorage.getItem(POPUP_STORAGE_KEY);
  setPopupOpen(savedOpen === null ? true : savedOpen === '1');

  if (toggleButton) toggleButton.addEventListener('click', () => {
    setPopupOpen(!popup?.classList.contains('visible'));
  });
  if (closeButton) closeButton.addEventListener('click', () => setPopupOpen(false));

  // Dragging by the header - lets the popup be moved out of the way of the
  // machine controls/camera feed it floats over, since it has no dimming
  // overlay and is meant to stay open while those stay usable. Position
  // (top-left, in px) persists across reloads the same way panel layout
  // does; switches the popup from its default CSS `top/right` anchor to an
  // explicit `left/top` the first time it's dragged or restored.
  const POS_STORAGE_KEY = 'lumenPasteUtility.setupChecklistPos';
  const header = popup?.querySelector('.floating-popup-header');

  const applyPosition = (left, top) => {
    if (!popup) return;
    const maxLeft = Math.max(0, window.innerWidth - popup.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - popup.offsetHeight);
    const clampedLeft = Math.min(Math.max(left, 0), maxLeft);
    const clampedTop = Math.min(Math.max(top, 0), maxTop);
    popup.style.left = `${clampedLeft}px`;
    popup.style.top = `${clampedTop}px`;
    popup.style.right = 'auto';
    return { left: clampedLeft, top: clampedTop };
  };

  try {
    const savedPos = JSON.parse(localStorage.getItem(POS_STORAGE_KEY) || 'null');
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      applyPosition(savedPos.left, savedPos.top);
    }
  } catch (error) {
    console.warn('Could not restore Setup Checklist position:', error);
  }

  if (header) {
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    header.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.btn-close')) return;
      const rect = popup.getBoundingClientRect();
      dragOffsetX = event.clientX - rect.left;
      dragOffsetY = event.clientY - rect.top;
      header.setPointerCapture(event.pointerId);
      document.body.classList.add('dragging-popup');
    });

    header.addEventListener('pointermove', (event) => {
      if (!header.hasPointerCapture(event.pointerId)) return;
      applyPosition(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
    });

    const endDrag = (event) => {
      if (!header.hasPointerCapture(event.pointerId)) return;
      header.releasePointerCapture(event.pointerId);
      document.body.classList.remove('dragging-popup');
      const rect = popup.getBoundingClientRect();
      localStorage.setItem(POS_STORAGE_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  }

  const forward = (fromId, toId) => {
    const from = document.getElementById(fromId);
    const to = document.getElementById(toId);
    if (from && to) from.addEventListener('click', () => to.click());
  };

  forward('checklistConnect', 'connect');
  forward('checklistImportJob', 'importJob');
  forward('checklistImportGerber', 'importGerber');
  forward('checklistRoughPos', 'getRoughBoardPosition');
  forward('checklistFidCal', 'performFidCal');
  forward('checklistNozzleCal', 'nozzleOffsetCal');
  forward('checklistExport', 'exportJob');
  forward('checklistRun', 'runJob');

  // Just a scroll-to for the settings step - there's nothing to auto-detect
  // as "done" here, so clicking through is what marks it visited.
  let settingsVisited = false;
  const goSettingsButton = document.getElementById('checklistGoSettings');
  if (goSettingsButton) {
    goSettingsButton.addEventListener('click', () => {
      const settingsPanel = document.querySelector('.panel[data-panel-id="extruder-settings"]');
      if (settingsPanel) {
        settingsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        settingsPanel.classList.add('checklist-highlight');
        setTimeout(() => settingsPanel.classList.remove('checklist-highlight'), 1500);
      }
      settingsVisited = true;
      updateChecklistState();
    });
  }

  function updateChecklistState(){
    const connected = serial.isConnected();
    const jobLoaded = currentJob.boards.some(b => b.placements.length > 0);
    const fids = currentJob.fiducials;
    const hasThreeFids = fids.length === 3;
    const roughDone = hasThreeFids && fids.every(f => typeof f.searchX === 'number' && Number.isFinite(f.searchX));
    // fidCalMatrix alone isn't enough here - findBoardRoughPosition() (the
    // PREVIOUS step) already sets it too, from the rough jogged positions,
    // so checking just that would mark this step done a step early. Matches
    // Job.boardsMissingFiducialCalibration()'s definition of "actually
    // calibrated": fid cal itself only ever sets a fiducial's calX/calY
    // (rough position never does), so requiring those is what actually
    // distinguishes "camera-precise fid cal has run" from "only roughly
    // jogged so far".
    const fidCalDone = hasThreeFids && fids.every(f => f.calX != null && f.calY != null);
    // No dedicated "calibrated" flag exists on the nozzle offset itself, so
    // treat a nonzero offset as evidence a calibration has actually been
    // run rather than left at its zero default. Per-board now (see
    // Job.tipXoffset), so this only reflects the ACTIVE board's own offset -
    // matches the rest of this checklist, which is already active-board-only
    // (this.fiducials et al).
    const nozzleCalDone = currentJob.tipXoffset !== 0 || currentJob.tipYoffset !== 0;
    const ranJob = currentJob.lastRunDurationMs != null;

    const steps = [
      { id: 'checklistStepConnect', done: connected, locked: false, reason: '' },
      { id: 'checklistStepImport', done: jobLoaded, locked: false, reason: '' },
      // Doesn't lock on !hasThreeFids anymore - findBoardRoughPosition()
      // itself now offers designating 3 pads as fiducial substitutes (see
      // Job.pickPadsAsFiducials()) when a board doesn't already have exactly
      // 3, so it's no longer a hard prerequisite to even attempt this step.
      { id: 'checklistStepRoughPos', done: roughDone, locked: !connected || !jobLoaded,
        reason: !connected ? 'Connect to the machine first' : !jobLoaded ? 'Import a job first' : '' },
      { id: 'checklistStepFidCal', done: fidCalDone, locked: !connected || !roughDone,
        reason: !connected ? 'Connect to the machine first' : !roughDone ? 'Set the rough board position first' : '' },
      { id: 'checklistStepNozzleCal', done: nozzleCalDone, locked: !connected,
        reason: !connected ? 'Connect to the machine first' : '' },
      { id: 'checklistStepSettings', done: settingsVisited, locked: false, reason: '' },
      // Exporting is just a local file save - it doesn't need a machine
      // connection, so the step itself (and the Export button) only locks on
      // having a job loaded; Run gets its own stricter check below.
      { id: 'checklistStepRun', done: ranJob, locked: !jobLoaded, reason: !jobLoaded ? 'Import a job first' : '' },
    ];

    for (const step of steps) {
      const el = document.getElementById(step.id);
      if (!el) continue;
      el.classList.toggle('done', step.done);
      el.classList.toggle('locked', step.locked);
      for (const btn of el.querySelectorAll('button')) {
        btn.disabled = step.locked;
        btn.title = step.locked ? step.reason : '';
      }
    }

    const connectBtn = document.getElementById('checklistConnect');
    if (connectBtn) {
      connectBtn.disabled = connected;
      connectBtn.textContent = connected ? 'Connected' : 'Connect';
    }

    // Run additionally needs a live connection, on top of the step's own
    // job-loaded check above.
    const runBtn = document.getElementById('checklistRun');
    if (runBtn) {
      const runLocked = !connected || !jobLoaded;
      runBtn.disabled = runLocked;
      runBtn.title = runLocked ? (!connected ? 'Connect to the machine first' : 'Import a job first') : '';
    }
  }

  updateChecklistState();
  setInterval(updateChecklistState, 500);
}

setupSetupChecklist();

// Makes every .panel in #leftColumn/#rightColumn reorderable (drag its
// .panel-drag-handle up/down within its own column) and resizable (native
// browser resize handle on .panel-body's bottom-right corner - see the CSS).
// Order and resized heights persist per panel id in localStorage, restored
// on load, so a layout the user sets up survives a page refresh.
function setupPanels(){
  const STORAGE_PREFIX = 'lumenPasteUtility.panel.';
  const columns = [document.getElementById('leftColumn'), document.getElementById('rightColumn')];

  for (const column of columns) {
    if (!column) continue;

    // Restore a saved panel order before wiring anything else, so dragging
    // always starts from the user's last layout instead of resetting it.
    try {
      const savedOrder = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${column.id}.order`) || 'null');
      if (Array.isArray(savedOrder)) {
        for (const panelId of savedOrder) {
          const panel = column.querySelector(`:scope > .panel[data-panel-id="${panelId}"]`);
          if (panel) column.appendChild(panel);
        }
      }
    } catch (error) {
      console.warn('Could not restore panel order:', error);
    }

    const panels = [...column.querySelectorAll(':scope > .panel')];

    for (const panel of panels) {
      const panelId = panel.dataset.panelId;
      const body = panel.querySelector('.panel-body');
      const handle = panel.querySelector('.panel-drag-handle');
      if (!panelId || !body || !handle) continue;

      // Restore a saved resize height. Left unset (falls back to the CSS
      // default) if nothing's saved yet.
      const savedHeight = localStorage.getItem(`${STORAGE_PREFIX}${panelId}.height`);
      if (savedHeight) body.style.height = savedHeight;

      // The native resize handle doesn't fire its own event - a
      // ResizeObserver is the simplest way to notice the user let go of it
      // and persist the result. This also re-saves (harmlessly) whenever
      // savedHeight is applied above or the window reflows the panel.
      new ResizeObserver(() => {
        localStorage.setItem(`${STORAGE_PREFIX}${panelId}.height`, `${body.offsetHeight}px`);
      }).observe(body);

      // Only the drag handle starts a reorder drag - the panel's own
      // interactive content (buttons, inputs, the canvas) would otherwise
      // fight the browser's native drag gesture.
      handle.draggable = true;
      handle.addEventListener('dragstart', (event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', panelId);
        panel.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => {
        panel.classList.remove('dragging');
        const order = [...column.querySelectorAll(':scope > .panel')].map(p => p.dataset.panelId);
        localStorage.setItem(`${STORAGE_PREFIX}${column.id}.order`, JSON.stringify(order));
      });
    }

    // Reorders live as the dragged panel crosses the vertical midpoint of a
    // sibling, standard drag-and-drop-list pattern - insertBefore/appendChild
    // just move the existing DOM node, so React-less panels here don't need
    // any state beyond "where is this element right now".
    column.addEventListener('dragover', (event) => {
      const dragging = column.querySelector(':scope > .panel.dragging');
      if (!dragging) return;
      event.preventDefault();

      const siblings = [...column.querySelectorAll(':scope > .panel:not(.dragging)')];
      const nextSibling = siblings.find(sibling => {
        const rect = sibling.getBoundingClientRect();
        return event.clientY < rect.top + rect.height / 2;
      });

      if (nextSibling) column.insertBefore(dragging, nextSibling);
      else column.appendChild(dragging);
    });
  }
}


setupPanels();

// Polls the board for its current position about once a second while
// connected, and shows it next to the jog controls (see
// .machine-position-row in index.html) - "where the machine is exactly"
// without having to jog and watch for a response yourself. Skips a tick
// (rather than sending anything) whenever the port is already busy - a job
// run, a jog, anything already inside serial.send() - since
// grabBoardPosition() shares send()'s not-reentrant ok-response state and
// would otherwise race it.
function setupMachinePositionPoll(){
  const posX = document.getElementById('machinePosX');
  const posY = document.getElementById('machinePosY');
  const posZ = document.getElementById('machinePosZ');
  if (!posX || !posY || !posZ) return;

  setInterval(async () => {
    if (!serial.isConnected() || serial.sending || currentJob.isRunning) return;

    try {
      const position = await lumen.grabBoardPosition();
      if (position.length < 3) return; // no position line found this tick - leave the last known values up
      posX.textContent = parseFloat(position[0]).toFixed(2);
      posY.textContent = parseFloat(position[1]).toFixed(2);
      posZ.textContent = parseFloat(position[2]).toFixed(2);
    } catch (error) {
      console.warn('Machine position poll failed:', error);
    }
  }, 1000);
}

setupMachinePositionPoll();
