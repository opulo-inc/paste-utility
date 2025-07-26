export class Lumen {
    constructor(serial){
        this.serial = serial;
        this.video = null;
        this.tipXoffset = 0;
        this.tipYoffset = 0;

    }

    addVideoManager(videoManager){
        this.video = videoManager;
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

        return positionArray;

    }

    // ALL FUNCTIONS that have cv must call this.video.displayCvFrame(); to have it show in the UI

    async jogToFiducial(){
        const circle = this.video.CVdetectCircle();

        // set a 2 second timer to show whatever's in this.video.cvFrame
        this.video.displayCvFrame(1000);

        // if we got a circle
        if (circle) {
            const [x_px, y_px] = circle;

            const centerX = this.video.canvas.width / 2;
            const centerY = this.video.canvas.height / 2;
            const offsetX = x_px - centerX;
            const offsetY = -(y_px - centerY);  // Invert Y coordinate
        
            const scalingFactor = 0.02;
            const scaledOffsetX = offsetX * scalingFactor;
            const scaledOffsetY = offsetY * scalingFactor;
        
            // Send jog commands using relative positioning
            await this.serial.goToRelative(scaledOffsetX.toFixed(1), scaledOffsetY.toFixed(1));
        }
    }

}