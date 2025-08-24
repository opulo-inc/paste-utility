export class VideoManager {
  constructor(cv) {
    this.cv = cv;
    this.video = null;

    // canvas object that we write to
    this.canvas = null;

    // this is the raw frame from the cam, oriented correctly
    this.frame = null;

    // this is the frame that's been processed through CV
    this.cvFrame = null;

    // flag that determines if we should display the cv image
    this.displayCv = false;

    // timer that keeps track of how long we show the cv image
    this.cvDisplayTimer = null;
  }

  async populateCameraList(selectElement) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');
      selectElement.innerHTML = '';
      
      videoDevices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `Camera ${videoDevices.indexOf(device) + 1}`;
        selectElement.appendChild(option);
        
        // if likely top cam, select it
        if (device.label && device.label.toLowerCase().includes('top')) {
          selectElement.value = device.deviceId;
        }
      });
    } catch (err) {
      console.error('Error populating camera list:', err);
    }
  }

  async startVideo(cameraId, canvas) {
    
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: cameraId ? { exact: cameraId } : undefined
        }
      });

      this.video = document.createElement('video');
      this.video.srcObject = stream;
      this.video.setAttribute('playsinline', true);
      this.canvas = canvas;

      await new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          // set canvas dimensions to match video
          this.canvas.width = this.video.videoWidth;
          this.canvas.height = this.video.videoHeight;
          resolve();
        };
      });

      await this.video.play();

      this.frame = new this.cv.Mat(this.video.videoHeight, this.video.videoWidth, this.cv.CV_8UC4);

      this.videoTick();
    
  }

  addReticle(frame){
    const centerX = frame.cols / 2;
    const centerY = frame.rows / 2;
    const reticleSize = 20;  
    const reticleColor = new this.cv.Scalar(255, 200, 0, 255); 
    const reticleThickness = 3;  
    
    let frameWithReticle = frame.clone();
    
    // horizontal line
    this.cv.line(
        frameWithReticle,
        new this.cv.Point(centerX - reticleSize, centerY),
        new this.cv.Point(centerX + reticleSize, centerY),
        reticleColor,
        reticleThickness
    );

    // vertical line
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

  // ALL FUNCTIONS that start with CV create a new frame in this.cvFrame that can be displayed
  // with this.displayCvFrame (which should only be called by lumen)
  // and they all return data that's useful for decision making

  // returns the position of the highest-scoring circle, or null if no circles found
  //also adds result of cv to this.cvFrame
  CVdetectCircle() {
    try {
        // clone frame to this.cvFrame
        this.cvFrame = this.frame.clone();

        let gray = new this.cv.Mat();
        this.cv.cvtColor(this.cvFrame, gray, this.cv.COLOR_RGBA2GRAY);
        this.cv.GaussianBlur(gray, gray, new this.cv.Size(9, 9), 2, 2);
        let circles = new this.cv.Mat();
        
        this.cv.HoughCircles(
            gray,
            circles,
            this.cv.HOUGH_GRADIENT,
            1,
            gray.rows / 8,
            50,
            30,
            1,
            50
        );

        let bestCircle = null;
        if (circles.cols > 0) {
            // get best one
            const x = circles.data32F[0];
            const y = circles.data32F[1];
            const radius = circles.data32F[2];
            bestCircle = [x, y, radius];

            // draw that bad boi
            this.cv.circle(this.cvFrame, new this.cv.Point(x, y), 3, new this.cv.Scalar(0, 255, 0, 255), -1);
            this.cv.circle(this.cvFrame, new this.cv.Point(x, y), radius, new this.cv.Scalar(255, 0, 0, 255), 3);
        }

        gray.delete();
        circles.delete();

        this.addReticle(this.cvFrame);

        return bestCircle;

    } catch (error) {
        console.error('Error in detectCircle:', error);
        return null;
    }
  }

  // this just pulls in a new frame from the video element, puts it into the canvas, flips it,
  // and loads it into this.frame
  loadNewFrame(){
    // Get the current frame for processing
    const context = this.canvas.getContext('2d');
    context.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
    const imageData = context.getImageData(0, 0, this.video.videoWidth, this.video.videoHeight);
    const tempMat = this.cv.matFromImageData(imageData);
    tempMat.copyTo(this.frame);
    tempMat.delete();
    this.cv.flip(this.frame, this.frame, -1);
  }


  // this is what runs like 60hz, and determines if we're showing processed or just streaming
  // then it kicks off whichever we're doing!  
  videoTick() {

    if (this.displayCv) {

        this.showFrame(this.cvFrame);

    }

    else{

        this.loadNewFrame();

        this.frame = this.addReticle(this.frame);

        this.showFrame(this.frame);
    }

    // set next frame to fire
    requestAnimationFrame(() => this.videoTick());

  }


  displayCvFrame(time) {
  
    this.displayCv = true;
    
    // set timer to return to normal view after n seconds
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
    }, time);

  }

  stopVideo(canvas) {
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
      this.video.remove(); 
      this.video = null; 
    }

    if (this.src) {
      this.src.delete();
      this.src = null;
    }

    if (this.dst) {
      this.dst.delete();
      this.dst = null;
    }
    
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    console.log('Video stopped and cleaned up');
  }

 
}