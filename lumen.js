// tipXoffset/tipYoffset/zOffset used to live here, but different boards on
// the same bed can need different nozzle offsets (different heights, a tip
// swap between boards, etc.) - they're per-board data now, owned by each
// entry in Job.boards (see createEmptyBoard() in job.js) instead of this
// shared, job-wide singleton.
export class Lumen {
    constructor(serial){
        this.serial = serial;
        this.video = null;
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
        
            // mm per pixel is the inverse of the camera's live pxPerMm (see
            // VideoManager) - read fresh every call so retuning the Camera
            // Scale input takes effect on the very next jog, no reload
            // needed.
            const mmPerPixel = 1 / this.video.pxPerMm;
            const scaledOffsetX = offsetX * mmPerPixel;
            const scaledOffsetY = offsetY * mmPerPixel;
        
            // Send jog commands using relative positioning
            await this.serial.goToRelative(scaledOffsetX.toFixed(1), scaledOffsetY.toFixed(1));
        }
    }

}