import './style.css'
import { modalManager } from './modal.js'
import { toastManager } from './toast.js'
import { serialManager } from './serialManager.js';
import { onOpenCVReady } from './opencv-bridge.js';
import { VideoManager } from './video.js';
import { Job } from './job.js';
import { Lumen } from './lumen.js'
import { getPasteDispenseSettings, setPasteDispenseSettings, resetPasteDispenseSettings } from './gerberImport.js';

let modal = new modalManager();
let toast = new toastManager();

let serial = new serialManager(modal);

let lumen = new Lumen(serial);
let currentJob = new Job(lumen, toast);

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

  // job stuff
  const importJobButton = document.getElementById('importJob');
  const jobFileInput = document.getElementById('jobFile');
  const exportJobButton = document.getElementById('exportJob');
  
  // settings elements
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

  if (jobDispenseDeg) {
    jobDispenseDeg.addEventListener('input', (e) => {
      currentJob.dispenseDegrees = Number(e.target.value);
      // Redraw so placement dots (sized by dispense degrees) reflect the new
      // value immediately for every point still using the job-wide default.
      currentJob.drawJobToCanvas();
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

  // Basic/Advanced settings tab switcher - toggles which panel is visible
  // and which tab button carries the .active style.
  const settingsTabButtons = document.querySelectorAll('.settings-tab-btn');
  settingsTabButtons.forEach(tabButton => {
    tabButton.addEventListener('click', () => {
      settingsTabButtons.forEach(btn => btn.classList.remove('active'));
      tabButton.classList.add('active');

      const targetPanelId = tabButton.dataset.tabPanel;
      document.getElementById('basicSettingsPanel').style.display =
        targetPanelId === 'basicSettingsPanel' ? '' : 'none';
      document.getElementById('advancedSettingsPanel').style.display =
        targetPanelId === 'advancedSettingsPanel' ? '' : 'none';
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
      // Re-run the board that's already loaded through the new settings
      // immediately, instead of making you re-import the gerber to see the
      // effect. No-ops (returns false) if nothing's been gerber-imported yet.
      currentJob.recomputeDispensePattern();
    });
  }

  const resetAdvancedSettingsButton = document.getElementById('resetAdvancedSettings');
  if (resetAdvancedSettingsButton) {
    resetAdvancedSettingsButton.addEventListener('click', () => {
      resetPasteDispenseSettings();
      refreshPasteSettingsInputs();
      currentJob.recomputeDispensePattern();
    });
  }

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
        if (jobDispenseDeg) currentJob.dispenseDegrees = Number(jobDispenseDeg.value);
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
    await currentJob.performTipCalibration();

    // performTipCalibration sets tipXoffset/tipYoffset directly, so refresh the
    // offset tool's on-screen values to match instead of leaving them stale.
    document.getElementById("x-offset-value").textContent = `${lumen.tipXoffset.toFixed(1)}mm`;
    document.getElementById("y-offset-value").textContent = `${lumen.tipYoffset.toFixed(1)}mm`;
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
  serial.send(["G91", `G0 X${dist} F${currentJob.motionSpeed}`, "G90"]);
});

document.getElementById("jog-xm").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 X-${dist} F${currentJob.motionSpeed}`, "G90"]);
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

// Purge Auger: run the B axis a long way to clear/prime the auger, pump on throughout
const purgeAugerBtn = document.getElementById('purgeAuger');
if (purgeAugerBtn) {
  purgeAugerBtn.addEventListener('click', () => {
    serial.send([`M106 P2 S${Math.round(currentJob.vacuumPressure / 100 * 255)}`, `M906 B ${currentJob.motorCurrent}`, "G91", "G0 B200000 F100000", "G90", "M107 P2"]);
  });
}

// Offset tuning: nudge the dispense position by 0.1mm and jog the physical tip to match.
// Shared by the X/Y/Z offset tools in the Extruder Settings panel.
const offsetStep = 0.1;

function adjustOffset(lumenProperty, gcodeAxis, valueElementId, delta) {
  // Only keep the new value if the machine is actually connected to receive
  // the matching jog - otherwise the stored offset (and the UI) would show a
  // change that never happened on the physical machine, so it'd look "saved"
  // while actually being stale/wrong the next time a job runs.
  if (!serial.isConnected()) {
    serial.send(["G91", `G0 ${gcodeAxis}${delta} F${currentJob.motionSpeed}`, "G90"]);
    return;
  }

  lumen[lumenProperty] = Math.round((lumen[lumenProperty] + delta) * 10) / 10;
  document.getElementById(valueElementId).textContent = `${lumen[lumenProperty].toFixed(1)}mm`;
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
