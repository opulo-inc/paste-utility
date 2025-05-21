export class modalManager {

    constructor() {
        this.modalObject = document.getElementById("modal");
        this.overlay = document.getElementById("overlay");

        this.modalTitle = document.getElementById("modal-title");
        this.modalContent = document.getElementById("modal-content");

        this.modalNumInput = document.getElementById("modal-num-input");

        this.modalClose = document.getElementById("modal-close");
        this.modalOK = document.getElementById("modal-ok");
        this.modalNG = document.getElementById("modal-ng");

        this.receivedInput = undefined;

        // Set up event listeners
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Close button handler
        this.modalClose.addEventListener("click", () => {
            this.receivedInput = false;
            this.hide();
        });

        // OK button handlers
        this.modalOK.addEventListener("keyup", (event) => {
            if (event.code === "Enter") {
                event.preventDefault();
                this.receivedInput = true;
                this.hide();
            }
        });

        this.modalOK.addEventListener("click", () => {
            this.receivedInput = true;
            this.hide();
        });

        // NG (No Good) button handler
        this.modalNG.addEventListener("click", () => {
            this.receivedInput = false;
            this.hide();
        });
    }

    timeout = async ms => new Promise(res => setTimeout(res, ms));

    hide() {
        this.modalObject.style.display = "none";
        this.overlay.style.display = "none";
    }

    //styles are:
    //  0 = classic ok and cancel
    //      can return true for ok, false for cancel
    //  1 = num input field, ok and cancel
    //      returns false for cancel, input field value for ok
    show(title, contents, style) {

        if(style === undefined){
            style = 0;
        }

        this.modalTitle.innerHTML = title;
        this.modalContent.innerHTML = contents;

        this.modalObject.style.display = "flex";
        this.overlay.style.display = "block";

        // if no input field
        if(style == 0){
            this.modalNumInput.style.display = "none";
        }
        else if (style == 1){
            this.modalNumInput.style.display = "block";
            this.modalNumInput.value = 1;
        }

        this.modalOK.focus();

        let response = this.waitForUserSelection();

        if(response && style == 1){
            response = this.modalNumInput.value;
        }

        return response;
        
    }

    async waitForUserSelection() {
        //wait for a buttonpress in another function to ste received input to something other than -1
        while (this.receivedInput === undefined) await this.timeout(50);

        //grab value
        let userValue = this.receivedInput;
        //reset for the next thing
        this.receivedInput = undefined;

        return userValue;

    }

}