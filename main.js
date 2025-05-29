import './style.css'
import { modalManager } from './modal.js'
import { serialManager } from './serialManager.js';
import { gerberManager } from './gerber.js';
import { onOpenCVReady } from './opencv-bridge.js';
import { VideoManager } from './video.js';
import { Job } from './job.js';
import { Lumen } from './lumen.js'

let modal = new modalManager();
let serial = new serialManager(modal);

let lumen = new Lumen(serial);
let currentJob = new Job(lumen);

onOpenCVReady(cv => {
  console.log("OpenCV loaded");
  
  const videoManager = new VideoManager(cv);

  lumen.addVideoManager(videoManager);

  const canvas = document.getElementById('opencv-canvas');
  const cameraSelect = document.getElementById('camera-select');
  const processButton = document.getElementById('process-button');
  
  videoManager.populateCameraList(cameraSelect);
  
  let isCameraRunning = false;
  
  // job stuff
  const importJobButton = document.getElementById('importJob');
  const jobFileInput = document.getElementById('jobFile');
  const exportJobButton = document.getElementById('exportJob');
  
  // settings elements
  const jobDispenseDeg = document.getElementById('jobDispenseDeg');
  const jobRetractionDeg = document.getElementById('jobRetractionDeg');
  const jobDwellMs = document.getElementById('jobDwellMs');

  console.log('Job settings elements:', { jobDispenseDeg, jobRetractionDeg, jobDwellMs });

  if (jobDispenseDeg) {
    jobDispenseDeg.addEventListener('change', (e) => {
      console.log('Dispense degrees changed:', e.target.value);
      currentJob.dispenseDegrees = Number(e.target.value);
    });
  }

  if (jobRetractionDeg) {
    jobRetractionDeg.addEventListener('change', (e) => {
      console.log('Retraction degrees changed:', e.target.value);
      currentJob.retractionDegrees = Number(e.target.value);
    });
  }

  if (jobDwellMs) {
    jobDwellMs.addEventListener('change', (e) => {
      console.log('Dwell milliseconds changed:', e.target.value);
      currentJob.dwellMilliseconds = Number(e.target.value);
    });
  }

  // Import job functionality
  if (importJobButton && jobFileInput) {
    console.log('Found import elements');
    importJobButton.addEventListener('click', () => {
      console.log('Import button clicked');
      jobFileInput.click();
    });

    jobFileInput.addEventListener('change', async (event) => {
      console.log('File selected');
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

  // Export job functionality
  if (exportJobButton) {
    exportJobButton.addEventListener('click', async () => {
      try {
        // Ensure we have the latest values from the UI
        if (jobDispenseDeg) currentJob.dispenseDegrees = Number(jobDispenseDeg.value);
        if (jobRetractionDeg) currentJob.retractionDegrees = Number(jobRetractionDeg.value);
        if (jobDwellMs) currentJob.dwellMilliseconds = Number(jobDwellMs.value);

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
    console.log(rect)
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    console.log(x, y)


    // Calculate scaling factors
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
  
    // Scale the click coordinates to match the actual video dimensions
    const scaledX = x * scaleX;
    const scaledY = y * scaleY;
  
    // Calculate center of canvas
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
  
    // Calculate offset from center
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
        // Connect to serial port
        await serial.connect();
        
        // Start camera
        await videoManager.startVideo(cameraSelect.value, canvas);
        isCameraRunning = true;
        
        // Update button state and disable it
        connectButton.textContent = 'Connected';
        connectButton.classList.add('connected');
        connectButton.disabled = true;
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
  serial.send(["G91", `G0 Y${dist}`, "G90"]);
});

document.getElementById("jog-ym").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 Y-${dist}`, "G90"]);
});

document.getElementById("jog-xp").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 X${dist}`, "G90"]);
});

document.getElementById("jog-xm").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 X-${dist}`, "G90"]);
});

document.getElementById("jog-zp").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 Z${dist}`, "G90"]);
});

document.getElementById("jog-zm").addEventListener("click", () => {
  let dist = getJogDistance();
  serial.send(["G91", `G0 Z-${dist}`, "G90"]);
});

// Air control
document.getElementById("left-air-on").addEventListener("click", () => {
  serial.send(["M106", "M106 P1 S255"]);
});

document.getElementById("left-air-off").addEventListener("click", () => {
  serial.send(["M107", "M107 P1"]);
});

// Vacuum control
document.getElementById("left-vac").addEventListener("click", () => {
  serial.readLeftVac();
});

// Ring lights control
document.getElementById("ring-lights-on").addEventListener("click", () => {
  serial.send(["M150 P255 R255 U255 B255"]);
});

document.getElementById("ring-lights-off").addEventListener("click", () => {
  serial.send(["M150 P0"]);
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

document.getElementById('capturePosition').addEventListener('click', async () => {
    try {
        await currentJob.capturePosition();
    } catch (error) {
        console.error('Error during capture:', error);
    }
});