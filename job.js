export class Job {
    constructor(lumen) {
        this.points = [];  
        this.dispenseDegrees = 30;  
        this.retractionDegrees = 1;  
        this.dwellMilliseconds = 100;  
        this.lumen = lumen;
    }

    async capture() {
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
                    Number(matches[1]),
                    Number(matches[2]),
                    Number(matches[3])
                );
                console.log('Point added to job');
                return;  // Only capture the first valid position
            }
        }
        console.log('No valid position found in inspect buffer');
    }

    addPoint(x, y, z) {
        this.points.push({ x, y, z });
    }


    async importFromFile(file) {
    
        const jsonString = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (error) => reject(error);
            reader.readAsText(file);
        });

        const data = JSON.parse(jsonString);
        
        this.points = data.points;
        this.dispenseDegrees = data.dispenseDegrees;
        this.retractionDegrees = data.retractionDegrees;
        this.dwellMilliseconds = data.dwellMilliseconds;

        // ui update
        const jobDispenseDeg = document.getElementById('jobDispenseDeg');
        const jobRetractionDeg = document.getElementById('jobRetractionDeg');
        const jobDwellMs = document.getElementById('jobDwellMs');

        if (jobDispenseDeg) jobDispenseDeg.value = this.dispenseDegrees;
        if (jobRetractionDeg) jobRetractionDeg.value = this.retractionDegrees;
        if (jobDwellMs) jobDwellMs.value = this.dwellMilliseconds;
        
        const positionsList = document.querySelector('.positions-list');
        positionsList.innerHTML = '';
        this.points.forEach(point => {
            this.createPositionElement([point.x, point.y, point.z]);
        });

        
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

    createPositionElement(position) {
        const positionsList = document.querySelector('.positions-list');
        const newDiv = document.createElement('div');
        newDiv.className = 'position-item';
        newDiv.innerHTML = `
            <span class="position-text">Position: X:${position[0]} Y:${position[1]} Z:${position[2]}</span>
            <div class="button-group">
                <button class="move-btn">☉</button>
                <button class="remove-btn">X</button>
            </div>
        `;
        
        // Add click handler for Move To button
        newDiv.querySelector('.move-btn').addEventListener('click', () => {
            this.lumen.serial.send([
                "G90",  // Set absolute positioning
                `G0 X${position[0]} Y${position[1]} Z${position[2]}`  // Move to position
            ]);
        });
        
        // Add click handler for Remove button
        newDiv.querySelector('.remove-btn').addEventListener('click', () => {
            newDiv.remove();
            this.points = this.points.filter(p => 
                p.x !== position[0] || p.y !== position[1] || p.z !== position[2]
            );
        });
      
        positionsList.appendChild(newDiv);
    }


    async capturePosition() {

        await this.capture();
        
        const lastPoint = this.getPoint(this.getPointCount() - 1);
        console.log('Last captured point:', lastPoint);
        
        if (lastPoint) {
            
            this.createPositionElement([lastPoint.x, lastPoint.y, lastPoint.z]);
        } 
    }

    // generates array of commands to send
    // in format serial.send(commands)
    slice(){
        const commands = [];

        commands.push(
            "G90",          // set to absolute mode
            "G92 B0"        // reset b axis to 0
        );

        let currentB = 0;

        console.log(this.positions);

        //cast to floats
        dispenseDeg = parseFloat(this.dispenseDegrees);
        retractionDeg = parseFloat(this.retractionDegrees);
        dwellMs = parseFloat(this.dwellMilliseconds);

        for(const [x, y, z] of this.positions) {

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

    // slices and executes a job
    run(){

        //todo make it such that we can cancel a job

        //send sliced gcode
        this.lumen.serial.send(this.slice())
    }


    export() {
        const data = {
            points: this.points,
            dispenseDegrees: this.dispenseDegrees,
            retractionDegrees: this.retractionDegrees,
            dwellMilliseconds: this.dwellMilliseconds
        };
        return JSON.stringify(data, null, 2);
    }

} 