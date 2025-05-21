import './style.css'
import { modalManager } from './modal.js'
import { serialManager } from './serialManager.js';
import { feederBus } from './feederBus';
import { gerberManager } from './gerber.js';
import { slicer } from './slicer.js';
import { commands } from './commands.js'
import { PositionManager } from './positionManager.js'
import { getOpenCV, onOpenCVReady } from './opencv-bridge.js';
import { VideoManager } from './video.js';

onOpenCVReady(cv => {
  console.log("OpenCV is ready to use!");
  
  const videoManager = new VideoManager(cv);
  const canvas = document.getElementById('opencv-canvas');
  const cameraSelect = document.getElementById('camera-select');
  const cameraToggle = document.getElementById('camera-toggle');
  const processButton = document.getElementById('process-button');
  
  // Initialize camera list
  videoManager.populateCameraList(cameraSelect);
  
  let isCameraRunning = false;
  
  // Add click handler for canvas
  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    
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
    const offsetY = -(scaledY - centerY);  // Invert Y coordinate
    
    const scalingFactor = 0.021;
    // Scale down the offsets by 0.1
    const scaledOffsetX = offsetX * scalingFactor;
    const scaledOffsetY = offsetY * scalingFactor;
    
    console.log(`Clicked at offset from center: X=${offsetX.toFixed(1)}, Y=${offsetY.toFixed(1)}`);
    console.log(`Sending jog commands: X=${scaledOffsetX.toFixed(1)}, Y=${scaledOffsetY.toFixed(1)}`);
    
    // Send jog commands using relative positioning
    serial.send([
      "G91",  // Set relative positioning
      `G0 X${scaledOffsetX.toFixed(1)} Y${scaledOffsetY.toFixed(1)}`,  // Move relative to current position
      "G90"   // Set absolute positioning
    ]);
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
      videoManager.startProcessing(canvas);
    }
  });
});

let modal = new modalManager();
let serial = new serialManager(modal);
let feeder = new feederBus(serial, modal);
let gerber = new gerberManager(serial);
let _slicer = new slicer(serial);
let positionManager = new PositionManager(serial);

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

document.getElementById("capture-button").addEventListener("click", () => {
  positionManager.capture();
});

document.getElementById("export-captured").addEventListener("click", () => {
  positionManager.exportCaptured();
});

document.getElementById("send").addEventListener("click", () => {
  serial.sendRepl();
  clearReplInput();
});

document.getElementById("home").addEventListener("click", () => {
  serial.send(["G28"]);
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