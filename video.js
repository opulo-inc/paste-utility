export class VideoManager {
  constructor(cv, serial) {
    this.cv = cv;
    this.video = null;

    this.serial = serial;

    // canvas object that we write to
    this.canvas = null;

    // this is the raw frame from the cam, oriented correctly
    this.frame = null;

    // this is the frame that's been processed through CV
    this.cvFrame = null;

    // flag that determines if we should display the cv image
    this.displayCv = false;

    // flag that determines if we need to do the cv operation, or if we can just display this.cvFrame
    this.needsCv = false;

    // timer that keeps track of how long we show the cv image
    this.cvDisplayTimer = null;

  }

  async populateCameraList(selectElement) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');
      
      // Clear existing options
      selectElement.innerHTML = '';
      
      // Add each video device as an option
      videoDevices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `Camera ${videoDevices.indexOf(device) + 1}`;
        selectElement.appendChild(option);
        
        // If this device has "top" in its name, select it
        if (device.label && device.label.toLowerCase().includes('top')) {
          selectElement.value = device.deviceId;
        }
      });
    } catch (err) {
      console.error('Error populating camera list:', err);
    }
  }

  async startVideo(cameraId, canvas) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: cameraId ? { exact: cameraId } : undefined
        }
      });

      this.video = document.createElement('video');
      this.video.srcObject = stream;
      this.video.setAttribute('playsinline', true);
      this.canvas = canvas;

      // Wait for video metadata to load
      await new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          // Set canvas dimensions to match video
          this.canvas.width = this.video.videoWidth;
          this.canvas.height = this.video.videoHeight;
          resolve();
        };
      });

      // Start video
      await this.video.play();
      this.videoTick();
    } catch (err) {
      console.error('Error starting video:', err);
      throw err;
    }
  }

  addReticle(frame){
    // Draw reticle on processed frame
    const centerX = frame.cols / 2;
    const centerY = frame.rows / 2;
    const reticleSize = 20;  // Size of the reticle lines
    const reticleColor = new this.cv.Scalar(255, 200, 0, 255);  // Green color
    const reticleThickness = 3;  // Thin line
    
    // Always clone the input frame to avoid modifying the original
    let frameWithReticle = frame.clone();
    
    // Draw horizontal line
    this.cv.line(
        frameWithReticle,
        new this.cv.Point(centerX - reticleSize, centerY),
        new this.cv.Point(centerX + reticleSize, centerY),
        reticleColor,
        reticleThickness
    );

    // Draw vertical line
    this.cv.line(
        frameWithReticle,
        new this.cv.Point(centerX, centerY - reticleSize),
        new this.cv.Point(centerX, centerY + reticleSize),
        reticleColor,
        reticleThickness
    );

    return frameWithReticle;
  }

  showFrame(frame){

    // Display the processed frame
    this.cv.imshow(this.canvas, frame);

  }

  // Returns the position of the highest-scoring circle, or null if no circles found
  detectCircle() {
    try {
        // Clone frame to this.cvFrame
        this.cvFrame = this.frame.clone();

        // Convert to grayscale
        let gray = new this.cv.Mat();
        this.cv.cvtColor(this.cvFrame, gray, this.cv.COLOR_RGBA2GRAY);
        
        // Apply Gaussian blur
        this.cv.GaussianBlur(gray, gray, new this.cv.Size(9, 9), 2, 2);
        
        // Create a Mat to store the circles
        let circles = new this.cv.Mat();
        
        // Detect circles
        this.cv.HoughCircles(
            gray,
            circles,
            this.cv.HOUGH_GRADIENT,
            1,
            gray.rows / 8,
            50,
            50,
            25,
            100
        );

        let bestCircle = null;
        if (circles.cols > 0) {
            // Get the first (highest-scoring) circle
            const x = circles.data32F[0];
            const y = circles.data32F[1];
            const radius = circles.data32F[2];
            bestCircle = [x, y];

            // Draw the detected circle
            this.cv.circle(this.cvFrame, new this.cv.Point(x, y), 3, new this.cv.Scalar(0, 255, 0, 255), -1);
            this.cv.circle(this.cvFrame, new this.cv.Point(x, y), radius, new this.cv.Scalar(255, 0, 0, 255), 3);
        }

        // Clean up
        gray.delete();
        circles.delete();

        return bestCircle;
    } catch (error) {
        console.error('Error in detectCircle:', error);
        return null;
    }
  }

  // this is what runs like 60hz, and determines if we're showing processed or just streaming
  // then it kicks off whichever we're doing!

  videoTick() {
    // first, we check if shit is set up(TODO move this to startvideo) 

    // exit if shit isnt set up
    if (!this.video || !this.video.srcObject) return;

    // Create frame mat if it doesn't exist or if dimensions changed
    if (!this.frame || 
        this.frame.rows !== this.video.videoHeight || 
        this.frame.cols !== this.video.videoWidth) {
      if (this.frame) {
        this.frame.delete();
      }
      this.frame = new this.cv.Mat(this.video.videoHeight, this.video.videoWidth, this.cv.CV_8UC4);
    }

    // Only update the frame if we're not in CV display mode
    if (!this.displayCv) {
        // draw video to canvas so we can pull from it
        const context = this.canvas.getContext('2d');
        context.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
        
        // pull image data out of the canvas
        const imageData = context.getImageData(0, 0, this.video.videoWidth, this.video.videoHeight);
        
        // Convert ImageData to Mat
        const tempMat = this.cv.matFromImageData(imageData);
        tempMat.copyTo(this.frame);
        tempMat.delete();
        
        // Flip the image in both X and Y axes immediately
        this.cv.flip(this.frame, this.frame, -1);  // -1 means flip both axes

        this.frame = this.addReticle(this.frame);
        this.showFrame(this.frame);
    } else {
        // if we need to perform cv
        if (this.needsCv) {
            console.log("Performing CV");
            
            // Get the current frame for processing
            const context = this.canvas.getContext('2d');
            context.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
            const imageData = context.getImageData(0, 0, this.video.videoWidth, this.video.videoHeight);
            const tempMat = this.cv.matFromImageData(imageData);
            tempMat.copyTo(this.frame);
            tempMat.delete();
            this.cv.flip(this.frame, this.frame, -1);

            const [x_px, y_px] = this.detectCircle();
            if (x_px !== null && y_px !== null) {
                // Calculate center of canvas
                const centerX = this.canvas.width / 2;
                const centerY = this.canvas.height / 2;
            
                // Calculate offset from center
                const offsetX = x_px - centerX;
                const offsetY = -(y_px - centerY);  // Invert Y coordinate
            
                const scalingFactor = 0.02;
                // Scale down the offsets
                const scaledOffsetX = offsetX * scalingFactor;
                const scaledOffsetY = offsetY * scalingFactor;
            
                console.log(`Circle detected at offset from center: X=${offsetX.toFixed(1)}, Y=${offsetY.toFixed(1)}`);
                console.log(`Sending jog commands: X=${scaledOffsetX.toFixed(1)}, Y=${scaledOffsetY.toFixed(1)}`);

                // Send jog commands using relative positioning
                this.serial.goToRelative(scaledOffsetX.toFixed(1), scaledOffsetY.toFixed(1));
            }

            this.cvFrame = this.addReticle(this.cvFrame);
            this.needsCv = false;
        }

        // Show the processed frame
        this.showFrame(this.cvFrame);
    }
    
    // set next frame to fire
    requestAnimationFrame(() => this.videoTick());
  }

  startProcessing() {
    // Enter cv display mode, request we perform cv
    this.needsCv = true;
    this.displayCv = true;
    
    // Set timer to return to normal view after 2 seconds
    if (this.processTimer) {
      clearTimeout(this.processTimer);
    }
    
    this.processTimer = setTimeout(() => {
      this.displayCv = false;
      this.needsCv = false;
      if (this.cvFrame) {
        this.cvFrame.delete();
        this.cvFrame = null;
      }
      this.processTimer = null;
    }, 2000);
  }

  stopVideo(canvas) {
    console.log('Stopping video...');
    this.isProcessing = false;
    
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    
    if (this.processedFrame) {
      this.processedFrame.delete();
      this.processedFrame = null;
    }
    
    if (this.video && this.video.srcObject) {
      this.video.srcObject.getTracks().forEach(track => track.stop());
      this.video.remove(); // Remove video element from DOM
      this.video = null; // Clear the video reference
    }
    if (this.src) {
      this.src.delete();
      this.src = null;
    }
    if (this.dst) {
      this.dst.delete();
      this.dst = null;
    }
    
    // Clear canvas
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    console.log('Video stopped and cleaned up');
  }
} 