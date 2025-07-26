import {parse} from '@tracespace/parser'
import {fromTriangles, applyToPoint, applyToPoints} from 'transformation-matrix';

class Point {
    constructor(x, y, z) {

        //these are the raw positions from the gerber import
        this.x = x;
        this.y = y;
        this.z = z;

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

        this.dispenseDegrees = 30;
        this.retractionDegrees = 1;  
        this.dwellMilliseconds = 100;  
        this.lumen = lumen;
        this.toast = toast;

        this.jobCanvas = document.getElementById('pointViz');

        this.clickedFidBuffer = [];
    }

    // this does a few things
    // it takes all the points and fids in a job, and draws them on the canvas
    // it also saves all the drawn positions to the point and fid objects for easier click detection
    // 
    drawJobToCanvas(){


        // const rect = this.jobCanvas.getBoundingClientRect();
        // this.jobCanvas.width = rect.width;
        // this.jobCanvas.height = rect.height;
        // this.jobCanvas.style.width = `${rect.width}px`;
        // this.jobCanvas.style.height = `${rect.height}px`;

        const ctx = this.jobCanvas.getContext("2d");

        // Find bounds of all points
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

        // Add a small margin to the bounds
        const margin = Math.max(maxX - minX, maxY - minY) * 0.1; // 10% margin
        minX -= margin;
        minY -= margin;
        maxX += margin;
        maxY += margin;

        const width = maxX - minX;
        const height = maxY - minY;
        
        // Calculate scale to fit the canvas while maintaining aspect ratio
        const scaleX = this.jobCanvas.width / width;
        const scaleY = this.jobCanvas.height / height;
        const vizScale = Math.min(scaleX, scaleY);
        
        // Calculate shifts to center the points
        const xShift = -minX;
        const yShift = -minY;
        
        // Clear canvas
        ctx.clearRect(0, 0, this.jobCanvas.width, this.jobCanvas.height);        
        
        // Draw fid points in blue
        ctx.fillStyle = "blue";
        for (let point of this.fiducials) {
            
            const newX = (point.x + xShift) * vizScale;
            const newY = (point.y + yShift) * vizScale;

            point.canvasX = newX;
            point.canvasY = newY;

            ctx.beginPath();
            ctx.arc(newX, this.jobCanvas.height - newY, 2, 0, Math.PI * 2);
            ctx.fill();
            
        }

        // Draw paste points in red
        ctx.fillStyle = "red";
        for (let point of this.placements) {
            const newX = (point.x + xShift) * vizScale;
            const newY = (point.y + yShift) * vizScale;

            point.canvasX = newX;
            point.canvasY = newY;

            ctx.beginPath();
            ctx.arc(newX, this.jobCanvas.height - newY, 2, 0, Math.PI * 2);
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

    async parseGerber(fileInputId){
        const fileInput = document.getElementById(fileInputId);
        if (!fileInput || !fileInput.files[0]) {
            console.error('No file selected');
            return [];
        }

        const gerberData = await fileInput.files[0].text();

        const syntaxTree = parse(gerberData)
      
        console.log(syntaxTree)
      
        let positions = [];
        let minX, minY, maxX, maxY;
      
        // iterate through the syntax tree children and save the x and y values for elements of type 'graphic'
        for (const child of syntaxTree.children) {
          if (child.type === 'graphic' && child.graphic === 'shape') {
            positions.push({
                x: child.coordinates.x/1000000,
                y: child.coordinates.y/1000000
            });
      
            if (minX === undefined || child.coordinates.x/1000000 < minX) {
              minX = child.coordinates.x/1000000;
            }
            if (minY === undefined || child.coordinates.y/1000000 < minY) {
              minY = child.coordinates.y/1000000;
            }
            if (maxX === undefined || child.coordinates.x/1000000 > maxX) {
              maxX = child.coordinates.x/1000000;
            }
            if (maxY === undefined || child.coordinates.y/1000000 > maxY) {
              maxY = child.coordinates.y/1000000;
            }
          }
        }
      
        console.log(positions);

        return positions;
    }


    // ok this bad boi does a lot of stuff.

    // then we figure out which are paste, and which are mask only (three of which are fids)
    // then we have them click on fid1 on the canvas, and then have them jog to it
    // then repeat with the other two
    // then we have them move the tip to the z surface of the board, then we save that as z position for every placement.

    async loadJobFromGerbers(){
        // first we pull in the gerber points, scaled the hell down to actual mm.
        const pastePoints = await this.parseGerber('pasteGerberFile');
        let maskPoints = await this.parseGerber('maskGerberFile');

        console.log("pastePoints: ", pastePoints)
        console.log("maskPoints: ", maskPoints)

        // filter out potential fid placements from mask
        maskPoints = maskPoints.filter(element => !pastePoints.includes(element));

        let onlyInMask = [];

        for(const mask of maskPoints){
            if(!pastePoints.includes(mask)){
                onlyInMask.push(mask);
            }
        }

        console.log("onlyInMask: ", onlyInMask)


        // Store points in this.placements
        for(const pointData of pastePoints){
            const newPoint = new Point(pointData.x, pointData.y, 31.5);
            this.placements.push(newPoint);
        }

        // store all POTENTIAL fids in this.fiducials
        for(const maskData of onlyInMask){
            const newPoint = new Point(maskData.x, maskData.y, 31.5);
            this.fiducials.push(newPoint);
        }


        this.drawJobToCanvas();

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

        this.jobCanvas.addEventListener("click", sendClickToToast.bind(this));

        // show the first toast asking them to click
        const fid1_object = await this.toast.show("Please click on FID1 in the display.");

        // show the second toast asking them to click
        const fid2_object = await this.toast.show("Please click on FID2 in the display.");

        // show the third toast asking them to click
        const fid3_object = await this.toast.show("Please click on FID3 in the display.");

        // cancel event listener for fid selection
        this.jobCanvas.removeEventListener('click', sendClickToToast)

        // delete all fids from this.fiducials other than the ones we just got
        this.fiducials = [fid1_object, fid2_object, fid3_object];

        console.log("fiducials: ", this.fiducials)
        console.log("placements: ", this.placements)

        //populate the position list
        this.loadJobIntoPositionList();
        // make some buttons red so that the user knows it's NOT ready to run a job yet

        this.drawJobToCanvas();

        

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

        await this.lumen.serial.send(["G0 Z31.5"]);

        zPos = parseFloat(zPos[2]) - 0.2;

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

        await this.lumen.serial.send(["G0 Z31.5"]);

        await this.lumen.serial.goToRelative(-45,63);

        await this.lumen.serial.send(["G0 Z46.5"]);

        await this.toast.show("Please jog the nozzle tip to be perfectly centered on and touching the fiducial.");

        const nozPos = await this.lumen.grabBoardPosition();

        await this.lumen.serial.send(["G0 Z31.5"]);

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


    loadJobIntoPositionList(){
        // clear existing position elements
        const positionsList = document.querySelector('.positions-list');
        positionsList.innerHTML = '';

        // add new position elements
        for (let placement of this.placements) {
            this.createPositionElement(placement, false);
        }
        for (let fiducial of this.fiducials) {
            this.createPositionElement(fiducial, true);
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
                const point = new Point(p.x, p.y, p.z);
                point.calX = p.calX;
                point.calY = p.calY;
                point.canvasX = p.canvasX;
                point.canvasY = p.canvasY;
                return point;
            });
            this.fiducials = (data.fiducials || []).map(f => {
                const fid = new Fiducial(f.x, f.y, f.z, f.searchX, f.searchY);
                fid.calX = f.calX;
                fid.calY = f.calY;
                fid.canvasX = f.canvasX;
                fid.canvasY = f.canvasY;
                return fid;
            });

            this.dispenseDegrees = data.dispenseDegrees;
            this.retractionDegrees = data.retractionDegrees;
            this.dwellMilliseconds = data.dwellMilliseconds;

            // Set tip offsets if present
            if (typeof data.tipXoffset !== 'undefined') this.lumen.tipXoffset = data.tipXoffset;
            if (typeof data.tipYoffset !== 'undefined') this.lumen.tipYoffset = data.tipYoffset;

            // ui update
            const jobDispenseDeg = document.getElementById('jobDispenseDeg');
            const jobRetractionDeg = document.getElementById('jobRetractionDeg');
            const jobDwellMs = document.getElementById('jobDwellMs');

            if (jobDispenseDeg) jobDispenseDeg.value = this.dispenseDegrees;
            if (jobRetractionDeg) jobRetractionDeg.value = this.retractionDegrees;
            if (jobDwellMs) jobDwellMs.value = this.dwellMilliseconds;
            
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
    }

    createPositionElement(position, isFiducial) {
        const positionsList = document.querySelector('.positions-list');
        const newDiv = document.createElement('div');
        newDiv.className = 'position-item';

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
                "G0 Z31.5",
                `G0 X${writtenX} Y${writtenY}`  // Move to position
            ]);
        });
        
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
      
        positionsList.appendChild(newDiv);
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
    slice(){
        const commands = [];

        commands.push(
            "G90",          // set to absolute mode
            "G92 B0",        // reset b axis to 0
            "G0 Z31.5"      // make sure we're clear of the board
        );

        let currentB = 0;

        console.log(this.positions);

        //cast to floats
        const dispenseDeg = parseFloat(this.dispenseDegrees);
        const retractionDeg = parseFloat(this.retractionDegrees);
        const dwellMs = parseFloat(this.dwellMilliseconds);

        for(const point of this.placements) {

            const dispenseAbsPos = currentB - dispenseDeg;
            const retractionAbsPos = dispenseAbsPos + retractionDeg;

            let x = point.x;
            let y = point.y; 

            if(point.calX != null){
                x = point.calX;
            }
            
            if(point.calY != null){
                y = point.calY;
            }


            commands.push(
            `G0 X${x + this.lumen.tipXoffset} Y${y + this.lumen.tipYoffset}`,                 // Move over
            `G0 Z${point.z}`,                       // Move z down
            `G0 B${dispenseAbsPos}`,          // Extrude paste
            `G0 B${retractionAbsPos}`,        // Retract a small amount
            `G4 P${dwellMs}`,                 // Dwell and wait for paste to actually extrude
            "G0 Z31.5",                       // Move safe z
            );

            currentB = retractionAbsPos;
        }

        commands.push("G0 X250 Y400");

        return commands;

    }

    // slices and executes a job
    async run(){

        let commands = this.slice()

        this.toast.show("Running job. Close this to cancel.");

        for(const command of commands){

            console.log(this.toast.receivedInput)

            if(this.toast.toastObject.style.display == "none"){
                await this.lumen.serial.send(["G0 Z31.5"]);
                await this.lumen.serial.send(["G0 X250 Y400"]);
                return;
            }

            await this.lumen.serial.send([command]);
        
        }

        this.toast.receivedInput = false;
        
    }


    export() {
        const data = {
            placements: this.placements.map(p => ({
                x: p.x,
                y: p.y,
                z: p.z,
                calX: p.calX,
                calY: p.calY,
                canvasX: p.canvasX,
                canvasY: p.canvasY
            })),
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
            retractionDegrees: this.retractionDegrees,
            dwellMilliseconds: this.dwellMilliseconds,
            tipXoffset: this.lumen.tipXoffset,
            tipYoffset: this.lumen.tipYoffset
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