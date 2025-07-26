export class toastManager {
    constructor(){
        this.toastObject = document.getElementById("toast");

        this.toastContent = document.getElementById("toast-content");
        this.toastClose = document.getElementById("toast-close");

        this.receivedInput = undefined;

        // Set up event listeners
        this.setupEventListeners();
    }

    timeout = async ms => new Promise(res => setTimeout(res, ms));

    setupEventListeners() {
        // Close button handler
        this.toastClose.addEventListener("click", () => {
            this.receivedInput = false;
        });

    }

    hide() {
        this.toastObject.style.display = "none";
    }

    async waitForUserSelection() {
        //wait for a buttonpress in another function to ste received input to something other than -1
        while (this.receivedInput === undefined) await this.timeout(50);

        //grab value
        let userValue = this.receivedInput;
        //reset for the next thing
        this.receivedInput = undefined;

        this.hide();

        return userValue;

    }

    show(contents) {

        this.toastContent.innerHTML = contents;

        this.toastObject.style.display = "flex";

        let response = this.waitForUserSelection();

        return response;
        
    }
}