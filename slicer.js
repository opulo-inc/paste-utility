export class slicer {

    constructor(serial, modal) {
        this.positions = [];
        this.shift_x;
        this.shift_y;
        this.z_position;
        this.serial = serial;
        this.commands = [];
        this.modal = modal;
    }

    slice(dispenseDeg, retractionDeg, dwellMs){
        const commands = [];

        commands.push(
            "G90",          // set to absolute mode
            "G28",          // home all axis
            "G28",
            "G92 B0"        // reset b axis to 0
        );

        let currentB = 0;

        console.log(this.positions);

        //cast to floats
        dispenseDeg = parseFloat(dispenseDeg);
        retractionDeg = parseFloat(retractionDeg);
        dwellMs = parseFloat(dwellMs);

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

        this.commands = commands;

    }

    send(){

    
        this.serial.send(this.commands);

   
    }

}