export class VideoManager {
  constructor(cv) {
    this.cv = cv;
    this.video = null;
    this.src = null;
    this.dst = null;
    this.isProcessing = false;
  }

  async populateCameraList(selectElement) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');
      
      videoDevices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `Camera ${videoDevices.indexOf(device) + 1}`;
        selectElement.appendChild(option);
      });
    } catch (err) {
      console.error('Error getting camera list:', err);
      throw err;
    }
  }

  async startVideo(deviceId, colorCanvas, grayCanvas, canvasFrame) {
    try {
      console.log('Starting video...');

      // Get selected camera
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId
        }
      });

      console.log('Got media stream:', stream);
      
      // Create new video element
      this.video = document.createElement('video');
      this.video.setAttribute('playsinline', '');
      this.video.setAttribute('autoplay', '');
      this.video.style.display = 'none'; // Hide the video element
      document.body.appendChild(this.video); // Add to DOM
      this.video.srcObject = stream;
      
      // Wait for video to be ready
      await new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          console.log('Video metadata loaded:', {
            width: this.video.videoWidth,
            height: this.video.videoHeight
          });
          
          // Set canvas dimensions to match video
          colorCanvas.width = this.video.videoWidth;
          colorCanvas.height = this.video.videoHeight;
          grayCanvas.width = this.video.videoWidth;
          grayCanvas.height = this.video.videoHeight;
          canvasFrame.width = this.video.videoWidth;
          canvasFrame.height = this.video.videoHeight;
          
          resolve();
        };
      });
      
      await this.video.play();
      console.log('Video element created and playing');
      
      // Create new matrices with video dimensions
      this.src = new this.cv.Mat(this.video.videoHeight, this.video.videoWidth, this.cv.CV_8UC4);
      this.dst = new this.cv.Mat();
      
      // Get canvas context
      const context = canvasFrame.getContext('2d', { willReadFrequently: true });
      
      console.log('OpenCV setup complete');
      
      // Start processing
      this.isProcessing = true;
      this.processVideo(colorCanvas, grayCanvas, canvasFrame);
      
    } catch (err) {
      console.error('Error starting camera:', err);
      throw err;
    }
  }

  processVideo(colorCanvas, grayCanvas, canvasFrame) {
    if (!this.isProcessing) return;

    try {
      let begin = Date.now();
      
      // Draw video frame to hidden canvas
      const context = canvasFrame.getContext('2d');
      context.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
      
      // Get image data from canvas
      const imageData = context.getImageData(0, 0, this.video.videoWidth, this.video.videoHeight);
      this.src.data.set(imageData.data);
      
      // Display color image
      this.cv.imshow('opencv-canvas', this.src);
      
      // Convert to grayscale for circle detection
      this.cv.cvtColor(this.src, this.dst, this.cv.COLOR_RGBA2GRAY);
      
      // Apply Gaussian blur to reduce noise
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
        30,
        0,
        0
      );

      // Convert back to color for drawing circles
      this.cv.cvtColor(this.dst, this.dst, this.cv.COLOR_GRAY2RGBA);
      
      // Draw detected circles
      for (let i = 0; i < circles.cols; i++) {
        const x = circles.data32F[i * 3];
        const y = circles.data32F[i * 3 + 1];
        const radius = circles.data32F[i * 3 + 2];
        
        // Draw circle center
        this.cv.circle(this.dst, new this.cv.Point(x, y), 3, new this.cv.Scalar(0, 255, 0, 255), -1);
        // Draw circle outline
        this.cv.circle(this.dst, new this.cv.Point(x, y), radius, new this.cv.Scalar(0, 255, 0, 255), 2);
      }

      // Display the result with circles
      this.cv.imshow('opencv-canvas-gray', this.dst);

      // Clean up
      blurred.delete();
      circles.delete();

      // Schedule next frame
      let delay = 1000/30 - (Date.now() - begin);
      setTimeout(() => this.processVideo(colorCanvas, grayCanvas, canvasFrame), delay);
      
    } catch (err) {
      console.error('Error processing video:', err);
      console.error('Error details:', err.stack);
    }
  }

  stopVideo(colorCanvas, grayCanvas) {
    console.log('Stopping video...');
    this.isProcessing = false;
    
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
    
    // Clear canvases
    const ctx1 = colorCanvas.getContext('2d');
    const ctx2 = grayCanvas.getContext('2d');
    ctx1.clearRect(0, 0, colorCanvas.width, colorCanvas.height);
    ctx2.clearRect(0, 0, grayCanvas.width, grayCanvas.height);
    
    console.log('Video stopped and cleaned up');
  }
} 