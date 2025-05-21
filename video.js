export class VideoManager {
  constructor(cv) {
    this.cv = cv;
    this.video = null;
    this.src = null;
    this.dst = null;
    this.isProcessing = false;
    this.isInProcessMode = false;
    this.processTimer = null;
    this.processedFrame = null;
    this.canvas = null;
    this.frame = null;
    this.gray = null;
    this.blurred = null;
    this.circles = null;
    this.cap = null;
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
      this.processVideo();
    } catch (err) {
      console.error('Error starting video:', err);
      throw err;
    }
  }

  processVideo() {
    if (!this.video || !this.video.srcObject) return;

    // Create matrices if they don't exist
    if (!this.frame) {
      this.frame = new this.cv.Mat(this.video.videoHeight, this.video.videoWidth, this.cv.CV_8UC4);
      this.gray = new this.cv.Mat();
      this.blurred = new this.cv.Mat();
      this.circles = new this.cv.Mat();
    }

    if (this.isInProcessMode && this.processedFrame) {
      // Draw reticle on processed frame
      const centerX = this.processedFrame.cols / 2;
      const centerY = this.processedFrame.rows / 2;
      const reticleSize = 20;  // Size of the reticle lines
      const reticleColor = new this.cv.Scalar(255, 200, 0, 255);  // Green color
      const reticleThickness = 3;  // Thin line

      // Draw horizontal line
      this.cv.line(
        this.processedFrame,
        new this.cv.Point(centerX - reticleSize, centerY),
        new this.cv.Point(centerX + reticleSize, centerY),
        reticleColor,
        reticleThickness
      );

      // Draw vertical line
      this.cv.line(
        this.processedFrame,
        new this.cv.Point(centerX, centerY - reticleSize),
        new this.cv.Point(centerX, centerY + reticleSize),
        reticleColor,
        reticleThickness
      );

      // Display the processed frame
      this.cv.imshow(this.canvas, this.processedFrame);
    } else {
      // Draw video frame to canvas
      const context = this.canvas.getContext('2d');
      context.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
      
      // Get image data from canvas
      const imageData = context.getImageData(0, 0, this.video.videoWidth, this.video.videoHeight);
      this.frame.data.set(imageData.data);
      
      // Flip the image in both X and Y axes immediately
      this.cv.flip(this.frame, this.frame, -1);  // -1 means flip both axes
      
      // Convert to grayscale
      this.cv.cvtColor(this.frame, this.gray, this.cv.COLOR_RGBA2GRAY);
      
      // Apply Gaussian blur
      this.cv.GaussianBlur(this.gray, this.blurred, new this.cv.Size(9, 9), 2, 2);
      
      // Detect circles
      this.cv.HoughCircles(
        this.blurred,
        this.circles,
        this.cv.HOUGH_GRADIENT,
        1,
        this.blurred.rows / 8,
        50,
        200,
        25,
        100
      );

      // Draw the detected circles
      for (let i = 0; i < this.circles.cols; i++) {
        const x = this.circles.data32F[i * 3];
        const y = this.circles.data32F[i * 3 + 1];
        const radius = this.circles.data32F[i * 3 + 2];

        // Draw circle center
        this.cv.circle(this.frame, new this.cv.Point(x, y), 3, new this.cv.Scalar(0, 255, 0, 255), -1);
        // Draw circle outline
        this.cv.circle(this.frame, new this.cv.Point(x, y), radius, new this.cv.Scalar(255, 0, 0, 255), 3);
      }

      // Draw reticle on live frame
      const centerX = this.frame.cols / 2;
      const centerY = this.frame.rows / 2;
      const reticleSize = 20;  // Size of the reticle lines
      const reticleColor = new this.cv.Scalar(255, 200, 0, 255);  // Green color
      const reticleThickness = 3;  // Thin line

      // Draw horizontal line
      this.cv.line(
        this.frame,
        new this.cv.Point(centerX - reticleSize, centerY),
        new this.cv.Point(centerX + reticleSize, centerY),
        reticleColor,
        reticleThickness
      );

      // Draw vertical line
      this.cv.line(
        this.frame,
        new this.cv.Point(centerX, centerY - reticleSize),
        new this.cv.Point(centerX, centerY + reticleSize),
        reticleColor,
        reticleThickness
      );

      // Display the frame
      this.cv.imshow(this.canvas, this.frame);
    }
    
    // Schedule next frame
    requestAnimationFrame(() => this.processVideo());
  }

  startProcessing(canvas) {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
    }
    
    // Create matrices if they don't exist
    if (!this.src) {
      this.src = new this.cv.Mat(this.video.videoHeight, this.video.videoWidth, this.cv.CV_8UC4);
      this.dst = new this.cv.Mat();
    }
    
    // Get the current frame
    const context = canvas.getContext('2d');
    context.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
    
    // Get image data from canvas
    const imageData = context.getImageData(0, 0, this.video.videoWidth, this.video.videoHeight);
    this.src.data.set(imageData.data);
    
    // Flip the image in both X and Y axes immediately
    this.cv.flip(this.src, this.src, -1);  // -1 means flip both axes
    
    // Convert to grayscale
    this.cv.cvtColor(this.src, this.dst, this.cv.COLOR_RGBA2GRAY);
    
    // Apply Gaussian blur
    const blurred = new this.cv.Mat();
    this.cv.GaussianBlur(this.dst, blurred, new this.cv.Size(9, 9), 2, 2);
    
    // Detect circles
    const circles = new this.cv.Mat();
    this.cv.HoughCircles(
      blurred,
      circles,
      this.cv.HOUGH_GRADIENT,
      1,
      blurred.rows / 8,
      100,
      25,
      10,
      100
    );

    // Find circle with highest confidence
    let highestConfidence = -1;
    let bestCircle = null;
    
    for (let i = 0; i < circles.cols; i++) {
      const x = circles.data32F[i * 3];
      const y = circles.data32F[i * 3 + 1];
      const radius = circles.data32F[i * 3 + 2];
      const confidence = circles.data32F[i * 3 + 3];
      
      if (confidence > highestConfidence) {
        highestConfidence = confidence;
        bestCircle = { x, y, radius, confidence };
      }
    }

    // Convert blurred image to color for display
    this.processedFrame = new this.cv.Mat();
    this.cv.cvtColor(blurred, this.processedFrame, this.cv.COLOR_GRAY2RGBA);
    
    // Draw circle if found
    if (bestCircle) {
      this.cv.circle(this.processedFrame, new this.cv.Point(bestCircle.x, bestCircle.y), 3, new this.cv.Scalar(0, 255, 0, 255), -1);
      this.cv.circle(this.processedFrame, new this.cv.Point(bestCircle.x, bestCircle.y), bestCircle.radius, new this.cv.Scalar(0, 255, 0, 255), 2);
    }

    // Clean up
    blurred.delete();
    circles.delete();
    
    // Enter process mode
    this.isInProcessMode = true;
    
    // Set timer to return to normal view after 2 seconds
    this.processTimer = setTimeout(() => {
      this.isInProcessMode = false;
      if (this.processedFrame) {
        this.processedFrame.delete();
        this.processedFrame = null;
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