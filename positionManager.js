export class PositionManager {
    constructor(serialManager) {
        this.positions = [];
        this.outputContainer = document.getElementById("capture-output");
        this.serial = serialManager;
    }

    addPosition(x, y, z) {
        const position = [x, y, z];
        this.positions.push(position);
        this.createPositionElement(position);
        return position;
    }

    removePosition(position) {
        const index = this.positions.indexOf(position);
        if (index > -1) {
            this.positions.splice(index, 1);
        }
    }

    createPositionElement(position) {
        const newDiv = document.createElement("div");
        newDiv.className = "position-item";
        newDiv.innerHTML = `Position: ${position.join(", ")} <button class="remove-btn">X</button>`;
        
        // Add event listener to the remove button
        newDiv.querySelector(".remove-btn").addEventListener("click", () => {
            newDiv.remove();
            this.removePosition(position);
        });

        this.outputContainer.appendChild(newDiv);
    }

    clearAll() {
        this.positions = [];
        this.outputContainer.innerHTML = '';
    }

    getPositions() {
        return this.positions;
    }

    setPositions(positions) {
        this.clearAll();
        positions.forEach(pos => this.addPosition(...pos));
    }

    exportToJSON() {
        return JSON.stringify(this.positions);
    }

    importFromJSON(jsonString) {
        try {
            const positions = JSON.parse(jsonString);
            this.setPositions(positions);
            return true;
        } catch (e) {
            console.error('Failed to parse positions JSON:', e);
            return false;
        }
    }

    async capture() {
        this.serial.clearInspectBuffer();
        await this.serial.send(["G92"]);

        const pattern = /X:(.*?) Y:(.*?) Z:(.*?) A:(.*?) B:(.*?) /;
        const re = new RegExp(pattern, 'i');

        console.log("serial inspect buffer: ", this.serial.inspectBuffer);

        for (var i = 0; i < this.serial.inspectBuffer.length; i++) {
            let currLine = this.serial.inspectBuffer[i];
            console.log(currLine);
            
            let result = re.test(currLine);

            if(result) {
                const matches = re.exec(currLine);
                this.addPosition(
                    matches[1],
                    matches[2],
                    matches[3]
                );
            }
        }
    }

    exportCaptured() {
        const data = this.exportToJSON();
        const blob = new Blob([data], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'positions.json';
        a.click();
        URL.revokeObjectURL(url);
    }
} 