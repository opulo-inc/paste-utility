import {parse} from '@tracespace/parser'

export class gerberManager {

    // responsible for 
    // 1. loading gerber file
    // 2. dropping mm positions from gerber file into slicer object
    // 3. rendering onto the canvas
    // 4. grabbing the current position of the board

    constructor(serial) {
        this.mm_positions = [];
        this.shift_x;
        this.shift_y;
        this.z_position;
        this.serial = serial;
    }

    async parseGerber(){

        const gerberData = await document.getElementById("gerberFile").files[0].text();

        const syntaxTree = parse(gerberData)
      
        console.log(syntaxTree)
      
        let positions = [];
        let minX, minY, maxX, maxY;
      
        // iterate through the syntax tree children and save the x and y values for elements of type 'graphic'
        for (const child of syntaxTree.children) {
          if (child.type === 'graphic') {
            positions.push([child.coordinates.x/1000000, child.coordinates.y/1000000]);
      
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

        this.mm_positions = positions;
      
      // drawing on canvas
      
        const canvas = document.getElementById("pointViz");
        const ctx = canvas.getContext("2d");
      
        const width = maxX - minX;
        const height = maxY - minY;
      
        let xShift, yShift, scale;
      
        if (width > height) {
          xShift = -minX;
          yShift = -minY + (width - height) / 2;
      
          scale = canvas.width / width;
        }
        else{
          xShift = -minX + (height - width) / 2;
          yShift = -minY;
      
          scale = canvas.height / height;
        }
      
        console.log("xShift: ", xShift, "yShift: ", yShift, "scale: ", scale);
      
        let firstFlag = true;
      
        for (const [x, y] of positions) {
      
          console.log("x: ", x, "y: ", y);
      
          const newX = (x + xShift) * scale;
          const newY = (y + yShift) * scale;
          console.log("drawing at: ", newX, newY);
      
          if (firstFlag) {
            ctx.fillStyle="green";
            ctx.fillRect(newX - 6, canvas.height - newY - 6, 15, 15);
            firstFlag = false;
          }
          else{
            ctx.fillStyle="red";
            ctx.fillRect(newX, canvas.height - newY, 5, 5);
      
          }
        }

    }

    async grabBoardPosition(){

        console.log("grabbing board position");
        this.serial.clearInspectBuffer();

        await this.serial.send(["G92"])

        console.log("sent G92");

        const pattern = /X:(.*?) Y:(.*?) Z:(.*?) A:(.*?) B:(.*?) /

        const re = new RegExp(pattern, 'i');

        console.log("serial inspect buffer: ", this.serial.inspectBuffer)

        let positionArray = [];

        for (var i=0; i < this.serial.inspectBuffer.length; i++) {

            let currLine = this.serial.inspectBuffer[i];
            console.log(currLine);
            
            let result = re.test(currLine);

            if(result){
                const matches = re.exec(currLine)

                positionArray = [matches[1], matches[2], matches[3]];
                break;
            }
        }

        console.log("positionArray: ", positionArray);

        this.shift_x = positionArray[0] - this.mm_positions[0][0];
        this.shift_y = positionArray[1] - this.mm_positions[0][1];
        this.z_position = positionArray[2];

        console.log("shift_x: ", this.shift_x, "shift_y: ", this.shift_y, "z_position: ", this.z_position);

    }

    async sendToSlicer(slicer){

        let newPositions = [];

        for (const [x, y] of this.mm_positions) {
            console.log("x: ", x, "y: ", y);
            console.log("shift_x: ", this.shift_x, "shift_y: ", this.shift_y, "z_position: ", this.z_position);
            newPositions.push([x + this.shift_x, y + this.shift_y, this.z_position]);
        }

        console.log(newPositions);

        slicer.positions = newPositions;

    }
    
}