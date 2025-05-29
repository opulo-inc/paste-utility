export class Lumen {
    constructor(serial){
        this.serial = serial;
        this.video = null;

    }

    addVideoManager(videoManager){
        this.video = videoManager;
    }

    // ALL FUNCTIONS that have cv must call this.video.displayCvFrame(); to have it show in the UI

    jogToFiducial(){

        const [x_px, y_px] = this.video.CVdetectCircle();

        // set a 2 second timer to show whatever's in this.video.cvFrame
        this.video.displayCvFrame(1000);

        // if we got some shit
        if (x_px !== null && y_px !== null) {

            // Calculate center of canvas
            const centerX = this.video.canvas.width / 2;
            const centerY = this.video.canvas.height / 2;
        
            // Calculate offset from center
            const offsetX = x_px - centerX;
            const offsetY = -(y_px - centerY);  // Invert Y coordinate
        
            const scalingFactor = 0.02;
            const scaledOffsetX = offsetX * scalingFactor;
            const scaledOffsetY = offsetY * scalingFactor;
        
            // Send jog commands using relative positioning
            this.serial.goToRelative(scaledOffsetX.toFixed(1), scaledOffsetY.toFixed(1));
        }
    }




}