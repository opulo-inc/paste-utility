import './style.css'
import { modalManager } from './modal.js'
import { serialManager } from './serialManager.js';
import { feederBus } from './feederBus';
import { commands } from './commands.js'

let modal = new modalManager();
let serial = new serialManager(modal);
let feeder = new feederBus(serial, modal);

let positions = [];

document.getElementById("modal-close").addEventListener("click", () => {
  modal.receivedInput = false;
  modal.hide();
});

document.getElementById("modal-ok").addEventListener("keyup", function(event) {
  if (event.code === "Enter"){
    event.preventDefault();
    modal.receivedInput = true;
    modal.hide();
  }
});

document.getElementById("modal-ok").addEventListener("click", () => {
  modal.receivedInput = true;
  modal.hide();
});

document.getElementById("modal-ng").addEventListener("click", () => {
  modal.receivedInput = false;
  modal.hide();
});



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
  capture();
});

document.getElementById("export-captured").addEventListener("click", () => {
  exportCaptured();
});

document.getElementById("connect").addEventListener("click", () => {
  serial.connect();
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


document.addEventListener("keyup", function(event) {

  if(event.getModifierState("Shift") && !event.getModifierState("Alt")){
    if (event.code === "ArrowUp"){
      console.log("we saw shift arrow up!")
      serial.send(["G91", "G0 Y10", "G90"]);
    }
    else if (event.code === "ArrowDown"){
      console.log("we saw shift arrow down!")
      serial.send(["G91", "G0 Y-10", "G90"]);
    }
    else if (event.code === "ArrowLeft"){
      console.log("we saw shift arrow left!")
      serial.send(["G91", "G0 X-10", "G90"]);
    }
    else if (event.code === "ArrowRight"){
      console.log("we saw shift arrow right!")
      serial.send(["G91", "G0 X10", "G90"]);
    }
    else if (event.code === "BracketLeft"){
      console.log("we saw shift comma!")
      serial.send(["G91", "G0 Z-10", "G90"]);
    }
    else if (event.code === "BracketRight"){
      console.log("we saw shift period!")
      serial.send(["G91", "G0 Z10", "G90"]);
    }
  }

  else if(!event.getModifierState("Shift") && event.getModifierState("Alt")){
    if (event.code === "ArrowUp"){
      console.log("we saw shift arrow up!")
      serial.send(["G91", "G0 Y1", "G90"]);
    }
    else if (event.code === "ArrowDown"){
      console.log("we saw shift arrow down!")
      serial.send(["G91", "G0 Y-1", "G90"]);
    }
    else if (event.code === "ArrowLeft"){
      console.log("we saw shift arrow left!")
      serial.send(["G91", "G0 X-1", "G90"]);
    }
    else if (event.code === "ArrowRight"){
      console.log("we saw shift arrow right!")
      serial.send(["G91", "G0 X1", "G90"]);
    }
    else if (event.code === "BracketLeft"){
      console.log("we saw shift comma!")
      serial.send(["G91", "G0 Z-1", "G90"]);
    }
    else if (event.code === "BracketRight"){
      console.log("we saw shift period!")
      serial.send(["G91", "G0 Z1", "G90"]);
    }
  }

  else if(event.getModifierState("Shift") && event.getModifierState("Alt")){
    if (event.code === "ArrowUp"){
      console.log("we saw shift arrow up!")
      serial.send(["G91", "G0 Y0.1", "G90"]);
    }
    else if (event.code === "ArrowDown"){
      console.log("we saw shift arrow down!")
      serial.send(["G91", "G0 Y-0.1", "G90"]);
    }
    else if (event.code === "ArrowLeft"){
      console.log("we saw shift arrow left!")
      serial.send(["G91", "G0 X-0.1", "G90"]);
    }
    else if (event.code === "ArrowRight"){
      console.log("we saw shift arrow right!")
      serial.send(["G91", "G0 X0.1", "G90"]);
    }
    else if (event.code === "BracketLeft"){
      console.log("we saw shift comma!")
      serial.send(["G91", "G0 Z-0.1", "G90"]);
    }
    else if (event.code === "BracketRight"){
      console.log("we saw shift period!")
      serial.send(["G91", "G0 Z0.1", "G90"]);
    }
  }
  
});

function exportCaptured(){
  //this function needs to save the positions array to a file
  //after convertiong it to a json object
  // it also needs to give the user the opportunity to name it
  //and save it to their computer
  const data = JSON.stringify(positions);
  const blob = new Blob([data], {type: 'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href =
    URL.createObjectURL(blob);
  a.download = 'positions.json';
  a.click();
  URL.revokeObjectURL(url);

}

async function capture(){
  
  serial.clearInspectBuffer();

  await serial.send(["G92"])

  const pattern = /X:(.*?) Y:(.*?) Z:(.*?) A:(.*?) B:(.*?) /

  const re = new RegExp(pattern, 'i');

  console.log("serial inspect buffer: ",serial.inspectBuffer)

  for (var i=0; i < serial.inspectBuffer.length; i++) {

      let currLine = serial.inspectBuffer[i];
      console.log(currLine);
      
      let result = re.test(currLine);

      if(result){
        const matches = re.exec(currLine)

        let newPositionArray = [matches[1], matches[2], matches[3]];
        positions.push(newPositionArray);

        // Create a new div element
        const newDiv = document.createElement("div");
        newDiv.className = "position-item";
        newDiv.innerHTML = `Position: ${newPositionArray.join(", ")} <button class="remove-btn">X</button>`;
        
        // Append the new div to the capture-output div
        document.getElementById("capture-output").appendChild(newDiv);
        
        // Add event listener to the remove button
        newDiv.querySelector(".remove-btn").addEventListener("click", function() {
          // Remove the div from the DOM
          newDiv.remove();

          // Remove the position from the array
          const index = positions.indexOf(newPositionArray);
          if (index > -1) {
            positions.splice(index, 1);
          }

          console.log("positions: ",positions);
          
        });
      }
  }

  console.log("positions: ",positions);
  
}


const pastingForm = document.getElementById("pastingForm");
const generatedGcodeOutput = document.getElementById("generatedGcode");

pastingForm.addEventListener("submit", async (e) => {
  e.preventDefault();  // Don't let the form submit the page.
  const action = e.submitter.name;  // either "generate" or "execute"
  const formData = new FormData(pastingForm);
  const data = Object.fromEntries(formData.entries());

  data.fileData = JSON.parse(await data.dataFile.text());
  delete data.dataFile;


  const gcode = generateGCode(data.fileData, data);
  generatedGcodeOutput.style.display = "block";
  generatedGcodeOutput.innerHTML = gcode.join("\n");

  if (action != "execute") {
    return;
  }

  let resp = modal.show("Ensure Nozzles Are Level", "Manually level the nozzles before hitting ok.");

  console.log("now we'll execute!!", resp);

  resp.then((result) => {
    console.log(result);
    serial.send(gcode);

  })
});



function generateGCode(positions, {dispenseDeg, retractionDeg, dwellMs}) {

  const commands = [];

  commands.push(
    "G90",          // set to absolute mode
    "G28",          // home all axis
    "G28",
    "G92 B0"        // reset b axis to 0
  );

  let currentB = 0;

  //cast to floats
  dispenseDeg = parseFloat(dispenseDeg);
  retractionDeg = parseFloat(retractionDeg);
  dwellMs = parseFloat(dwellMs);

  for(const [x, y, z] of positions) {

    const dispenseAbsPos = currentB + dispenseDeg;
    const retractionAbsPos = dispenseAbsPos - retractionDeg;

    commands.push(
      `G0 X${x} Y${y}`,                 // Move over
      `G0 Z${z}`,                       // Move z down
      `G0 B${dispenseAbsPos}`,          // Extrude paste
      `G0 B${retractionAbsPos}`,        // Retract a small amount
      `G4 P${dwellMs}`,                 // Dwell and wait for paste to actually extrude
      "G0 Z31.5",                       // Move safe z
    );

    currentB = retractionAbsPos;
  }

  commands.push("G0 X300 Y400");

  return commands;
}

