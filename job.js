export class Job {
    constructor(serial) {
        this.points = [];  // Array of {x, y, z} coordinate objects
        this.dispenseDegrees = 30;  // Default value
        this.retractionDegrees = 1;  // Default value
        this.dwellMilliseconds = 100;  // Default value
        this.serial = serial;
    }

    /**
     * Capture the current position and add it to the job
     * @returns {Promise<void>}
     */
    async capture() {
        console.log('Job capture method called');
        if (!this.serial) {
            console.error('Serial manager not set');
            return;
        }
        console.log('Serial manager is set, proceeding with capture');

        this.serial.clearInspectBuffer();
        console.log('Inspect buffer cleared');
        
        await this.serial.send(["G92"]);
        console.log('G92 command sent');

        const pattern = /X:(.*?) Y:(.*?) Z:(.*?) A:(.*?) B:(.*?) /;
        const re = new RegExp(pattern, 'i');

        console.log("Serial inspect buffer contents:", this.serial.inspectBuffer);

        for (var i = 0; i < this.serial.inspectBuffer.length; i++) {
            let currLine = this.serial.inspectBuffer[i];
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

    /**
     * Add a point to the job
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} z - Z coordinate
     */
    addPoint(x, y, z) {
        this.points.push({ x, y, z });
    }

    /**
     * Clear all points from the job
     */
    clearPoints() {
        this.points = [];
    }

    /**
     * Set the job parameters
     * @param {number} dispenseDegrees - Degrees to dispense
     * @param {number} retractionDegrees - Degrees to retract
     * @param {number} dwellMilliseconds - Milliseconds to dwell
     */
    setParameters(dispenseDegrees, retractionDegrees, dwellMilliseconds) {
        this.dispenseDegrees = dispenseDegrees;
        this.retractionDegrees = retractionDegrees;
        this.dwellMilliseconds = dwellMilliseconds;
    }

    /**
     * Import job data from a JSON file
     * @param {File} file - The file to import
     * @returns {Promise<{success: boolean, error?: string}>} - Import result
     */
    async importFromFile(file) {
        try {
            // Read the file
            const jsonString = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = (error) => reject(error);
                reader.readAsText(file);
            });

            // Parse and validate the data
            const data = JSON.parse(jsonString);
            
            // Validate required fields
            if (!data.points || !Array.isArray(data.points)) {
                throw new Error('Invalid points data');
            }
            if (typeof data.dispenseDegrees !== 'number') {
                throw new Error('Invalid dispense degrees');
            }
            if (typeof data.retractionDegrees !== 'number') {
                throw new Error('Invalid retraction degrees');
            }
            if (typeof data.dwellMilliseconds !== 'number') {
                throw new Error('Invalid dwell milliseconds');
            }

            // Import the data
            this.points = data.points;
            this.dispenseDegrees = data.dispenseDegrees;
            this.retractionDegrees = data.retractionDegrees;
            this.dwellMilliseconds = data.dwellMilliseconds;

            // Update UI elements
            const jobDispenseDeg = document.getElementById('jobDispenseDeg');
            const jobRetractionDeg = document.getElementById('jobRetractionDeg');
            const jobDwellMs = document.getElementById('jobDwellMs');

            if (jobDispenseDeg) jobDispenseDeg.value = this.dispenseDegrees;
            if (jobRetractionDeg) jobRetractionDeg.value = this.retractionDegrees;
            if (jobDwellMs) jobDwellMs.value = this.dwellMilliseconds;
            
            // Clear and repopulate positions
            const positionsList = document.querySelector('.positions-list');
            positionsList.innerHTML = '';
            this.points.forEach(point => {
                this.createPositionElement([point.x, point.y, point.z]);
            });

            return { success: true };
        } catch (error) {
            console.error('Error importing job:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Save the job to a file using the native file picker
     * @returns {Promise<void>}
     */
    async saveToFile() {
        const jsonData = this.export();
        const blob = new Blob([jsonData], { type: 'application/json' });
        
        // Show the native save dialog
        const handle = await window.showSaveFilePicker({
            suggestedName: 'job.json',
            types: [{
                description: 'JSON Files',
                accept: {
                    'application/json': ['.json']
                }
            }]
        });
        
        // Create a FileSystemWritableFileStream to write to
        const writable = await handle.createWritable();
        // Write the contents
        await writable.write(blob);
        // Close the file and write the contents to disk
        await writable.close();
    }

    /**
     * Get the number of points in the job
     * @returns {number} - Number of points
     */
    getPointCount() {
        return this.points.length;
    }

    /**
     * Get a point by index
     * @param {number} index - Index of the point to get
     * @returns {Object|null} - Point object or null if index is invalid
     */
    getPoint(index) {
        if (index >= 0 && index < this.points.length) {
            return this.points[index];
        }
        return null;
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
            this.serial.send([
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

    /**
     * Capture the current position and update UI
     * @param {Function} createPositionElement - Function to create UI element for position
     * @returns {Promise<void>}
     */
    async capturePosition() {
        console.log('Starting capture...');
        await this.capture();
        console.log('Capture completed');
        
        const lastPoint = this.getPoint(this.getPointCount() - 1);
        console.log('Last captured point:', lastPoint);
        
        if (lastPoint) {
            console.log('Creating position element for point:', lastPoint);
            this.createPositionElement([lastPoint.x, lastPoint.y, lastPoint.z]);
        } else {
            console.log('No point was captured');
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
        this.serial.send(this.slice())
    }

    /**
     * Export job data to a JSON string
     * @returns {string} - JSON string containing job data
     */
    export() {
        const data = {
            points: this.points,
            dispenseDegrees: this.dispenseDegrees,
            retractionDegrees: this.retractionDegrees,
            dwellMilliseconds: this.dwellMilliseconds
        };
        return JSON.stringify(data, null, 2);  // Pretty print with 2-space indentation
    }

} 